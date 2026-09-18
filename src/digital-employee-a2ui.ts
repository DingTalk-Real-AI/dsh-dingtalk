import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { A2uiInteractions, type A2uiCard, type A2uiMessage, type A2uiPresentation } from './a2ui.js'
import { sanitizedDwsEnvironment } from './digital-employee-reply-sink.js'
import type { DigitalEmployeeConfig } from './setup-state.js'
import type { DigitalEmployeeEvent } from './digital-employee-types.js'
import type { HostAgentContext } from './host.js'
import type { DigitalEmployeeAuditFields } from './digital-employee-audit.js'

/** 数字员工默认接线：发卡前探测，未知投递结果不重试、不另开审批入口。 */
export function employeeA2ui(
  employee: DigitalEmployeeConfig,
  timeoutMs: number,
  log: (line: string) => void,
  options: { questionTimeoutMs?: number; audit?(fields: DigitalEmployeeAuditFields): Promise<void> } = {},
) {
  const source = `${employee.agentUuid}:${randomUUID()}`
  const binding = JSON.stringify(employee)
  const sessions = new Map<string, DigitalEmployeeEvent>()
  const installations = new Map<HostAgentContext, () => void>()
  let available = false
  let connected = false
  const calls = new Set<Promise<unknown>>()
  let closed = false
  const cli = (args: string[], signal: AbortSignal, help = false): Promise<unknown> => {
    const call = new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('a2ui_aborted'))
      const child = spawn('dws', [...args, '--profile', employee.dwsProfile, '--format', 'json'], {
        env: sanitizedDwsEnvironment(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const stop = () => child.kill('SIGTERM')
      let failed = false
      const timer = setTimeout(
        () => {
          failed = true
          stop()
        },
        help ? 5_000 : 35_000,
      )
      signal.addEventListener('abort', stop, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.resume()
      child.stdout.on('data', (chunk) => {
        if (failed) return
        output += chunk
        if (output.length > 2_000_000) {
          failed = true
          stop()
        }
      })
      child.once('error', () => reject(new Error('a2ui_dws_spawn_failed')))
      child.once('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        try {
          const value = help ? output : JSON.parse(output)
          if (code !== 0 || failed || signal.aborted || value.ok === false || value.success === false || value.error)
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
    questionTimeoutMs: options.questionTimeoutMs,
    log,
    route: (session, kind) => {
      const event = sessions.get(session)
      if (closed || !available || !connected || !event || JSON.stringify(employee) !== binding) return undefined
      const operator = kind === 'approval' ? employee.operatorOpenDingTalkId : event.senderOpenDingTalkId
      return {
        target:
          kind === 'ask' && event.conversationType === 'group'
            ? { type: 'group', id: event.conversationId }
            : { type: 'user', id: operator },
        operatorOpenDingTalkId: operator,
        bindingId: `${source}:${event.conversationId}:${event.senderOpenDingTalkId}`,
      }
    },
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
            input.target.type === 'group' ? '--conversation-id' : '--open-dingtalk-id',
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
    async prepare() {
      if (closed) return false
      try {
        const signal = AbortSignal.timeout(6_000)
        const [send, update, events] = await Promise.all([
          cli(['chat', 'message', 'send-a2ui-card', '--help'], signal, true),
          cli(['chat', 'message', 'update-a2ui-card', '--help'], signal, true),
          cli(['event', 'consume', '--help'], signal, true),
        ])
        available =
          !closed &&
          typeof send === 'string' &&
          typeof update === 'string' &&
          typeof events === 'string' &&
          ['--summary', '--content', '--a2ui-annotations', '--open-dingtalk-id', '--conversation-id'].every((flag) =>
            send.includes(flag),
          ) &&
          ['--biz-id', '--content', '--flow-status', '--a2ui-annotations'].every((flag) => update.includes(flag)) &&
          events.includes('user_card_action_triggered') &&
          events.includes('--flatten')
      } catch {
        available = false
      }
      log(available ? 'a2ui capabilities verified' : 'a2ui unavailable before delivery; using text interactions')
      return available
    },
    available: () => available && !closed,
    setConnected(value: boolean) {
      connected = value
    },
    disable() {
      available = false
      connected = false
      manager.close()
    },
    install(ctx: HostAgentContext) {
      if (closed || installations.has(ctx)) return
      const agent = ctx.agent
      if (!agent) return
      const approvalOff = ctx.on(
        'approval/request',
        async (request, next) => {
          if (request.agent !== agent) return next()
          if (closed || JSON.stringify(employee) !== binding) return Promise.resolve('unavailable')
          if (!available) return next()
          // 订阅暂时离线时不能转到第二个授权通道；恢复连接后才接受新的卡片请求。
          if (!connected) return Promise.resolve('unavailable')
          const event = sessions.get(agent.id)
          if (!event) return 'unavailable'
          try {
            await options.audit?.({
              eventId: event.eventId,
              sessionId: agent.id,
              operationType: 'approval_request',
              toolName: request.toolName,
              status: 'started',
            })
            const outcome = await manager.approve(request)
            await options.audit?.({
              eventId: event.eventId,
              sessionId: agent.id,
              operationType: 'approval_response',
              toolName: request.toolName,
              status: outcome,
            })
            if (request.signal?.aborted || closed || JSON.stringify(employee) !== binding) return 'cancelled'
            return outcome
          } catch {
            log('a2ui approval audit failed; denied')
            return 'unavailable'
          }
        },
        { prepend: true },
      )
      const askOff = ctx.on(
        'user-questions/request',
        (request, next) => {
          if (request.agent && request.agent !== agent) return next()
          if (closed || JSON.stringify(employee) !== binding || (available && !connected))
            return Promise.reject(new Error('a2ui_unavailable'))
          return available ? manager.ask(agent.id, request) : next()
        },
        { prepend: true },
      )
      installations.set(ctx, () => {
        approvalOff()
        askOff()
      })
    },
    bindSession: (session: string, event: DigitalEmployeeEvent) => sessions.set(session, event),
    handleInbound: async () => false,
    handleEvent: (event: unknown) => {
      const accepted = manager.handleEvent(source, event)
      log(`a2ui callback accepted=${accepted}`)
    },
    close: () => {
      closed = true
      manager.close()
      for (const dispose of installations.values()) dispose()
      installations.clear()
      sessions.clear()
    },
    drain: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await Promise.allSettled([...calls])
    },
  }
}
