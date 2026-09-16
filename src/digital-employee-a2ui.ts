import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { A2uiInteractions, type A2uiCard, type A2uiMessage, type A2uiPresentation } from './a2ui.js'
import { sanitizedDwsEnvironment } from './digital-employee-reply-sink.js'
import type { DigitalEmployeeConfig } from './setup-state.js'

/** 本地验收接线：仅显式开启的员工使用；不改变通用模块或机器人默认行为。 */
export function employeeA2ui(employee: DigitalEmployeeConfig, timeoutMs: number, log: (line: string) => void) {
  const source = `${employee.agentUuid}:${employee.bindingRevision}:${randomUUID()}`
  const sessions = new Set<string>()
  const calls = new Set<Promise<unknown>>()
  let closed = false
  const cli = (args: string[], signal: AbortSignal): Promise<unknown> => {
    const call = new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('a2ui_aborted'))
      const child = spawn('dws', [...args, '--profile', employee.dwsProfile, '--format', 'json'], {
        env: sanitizedDwsEnvironment(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const stop = () => child.kill('SIGTERM')
      const timer = setTimeout(stop, 35_000)
      signal.addEventListener('abort', stop, { once: true })
      child.stderr.resume()
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.length > 2_000_000) stop()
      })
      child.once('error', () => reject(new Error('a2ui_dws_spawn_failed')))
      child.once('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        try {
          const value = JSON.parse(output)
          if (code !== 0 || signal.aborted || value.ok === false || value.success === false || value.error)
            throw new Error('failed')
          resolve(value)
        } catch {
          reject(new Error('a2ui_dws_failed_unknown_delivery'))
        }
      })
    })
    calls.add(call)
    void call.finally(() => calls.delete(call)).catch(() => undefined)
    return call
  }
  const content = (messages: A2uiMessage[]) => JSON.stringify(messages.map((message) => JSON.stringify(message)))
  const annotations = (surfaceId: string, value: A2uiPresentation) =>
    JSON.stringify([{ surfaceId, componentId: value.summaryComponentId, type: 'artifact' }])
  const updates = new Map<string, Promise<void>>()
  const update = (card: A2uiCard, messages: A2uiMessage[], signal: AbortSignal, value: A2uiPresentation) => {
    const flowStatus = {
      'waiting-approval': 'CONFIRMING',
      'waiting-input': 'CONFIRMING',
      'waiting-choice': 'CONFIRMING',
      'allowed-once': 'CONFIRMED',
      answered: 'FINISH',
      rejected: 'ABORTED',
      cancelled: 'ABORTED',
      unavailable: 'ERROR',
      'timed-out': 'TIMEOUT',
    }[value.state]
    // 同一卡片串行更新，避免等待态的迟到响应覆盖已提交/取消状态。
    const call = (updates.get(card.bizId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await cli(
          [
            'chat',
            'message',
            'update-a2ui-card',
            '--biz-id',
            card.bizId,
            '--content',
            content(messages),
            '--flow-status',
            flowStatus,
            '--a2ui-annotations',
            annotations(card.surfaceId, value),
          ],
          signal,
        )
        log(`a2ui state update accepted: ${value.state}`)
      })
    updates.set(card.bizId, call)
    calls.add(call)
    void call
      .finally(() => {
        if (updates.get(card.bizId) === call) updates.delete(card.bizId)
        calls.delete(call)
      })
      .catch(() => undefined)
    return call
  }
  const manager = new A2uiInteractions({
    source,
    timeoutMs,
    log,
    route: (session) =>
      !closed && sessions.has(session)
        ? {
            target: { type: 'user', id: employee.operatorOpenDingTalkId },
            operatorOpenDingTalkId: employee.operatorOpenDingTalkId,
            bindingId: source,
          }
        : undefined,
    transport: {
      async create(input) {
        const surfaceId = `dsh-${randomUUID()}`
        const messages = [
          {
            version: 'v1.0',
            createSurface: {
              surfaceId,
              catalogId: 'https://dingtalk.com/card/a2ui/catalogs/public/catalog.json',
              dataModel: {},
            },
          },
          ...input.render(surfaceId),
        ]
        const value = await cli(
          [
            'chat',
            'message',
            'send-a2ui-card',
            '--open-dingtalk-id',
            input.target.id,
            '--summary',
            input.presentation.summary,
            '--content',
            content(messages),
            '--a2ui-annotations',
            annotations(surfaceId, input.presentation),
          ],
          input.signal,
        )
        const ids = new Set<string>()
        const collect = (item: unknown): void => {
          if (typeof item === 'string' && /^[\[{]/.test(item)) {
            try {
              collect(JSON.parse(item))
            } catch {
              /* 非 JSON 文本不参与提取 */
            }
          } else if (item && typeof item === 'object') {
            for (const [key, child] of Object.entries(item)) {
              if (key === 'bizId' && typeof child === 'string' && child) ids.add(child)
              else collect(child)
            }
          }
        }
        collect(value)
        if (ids.size !== 1) throw new Error('a2ui_unknown_delivery_no_retry')
        log('a2ui card delivered')
        return { bizId: [...ids][0], surfaceId }
      },
      setWaiting(card, value, signal) {
        // 只更新摘要组件，不能重新下发初始 answers 覆盖用户已填写的内容。
        return update(
          card,
          [
            {
              version: 'v1.0',
              updateComponents: {
                surfaceId: card.surfaceId,
                components: [
                  {
                    id: value.summaryComponentId,
                    component: 'Markdown',
                    content: value.titleMarkdown ?? `## ${value.summary}`,
                  },
                ],
              },
            },
          ],
          signal,
          value,
        )
      },
      update,
    },
  })
  return {
    install: manager.install.bind(manager),
    bindSession: (session: string) => sessions.add(session),
    handleInbound: async () => false,
    handleEvent: (event: unknown) => {
      const accepted = manager.handleEvent(source, event)
      log(`a2ui callback accepted=${accepted}`)
    },
    close: () => {
      closed = true
      manager.close()
      sessions.clear()
    },
    drain: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await Promise.allSettled([...calls])
    },
  }
}
