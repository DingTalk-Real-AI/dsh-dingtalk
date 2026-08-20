/**
 * Slash commands — handled locally, never sent to the model:
 * /status /new /stop /model /help, plus the queue-busy numeric choice
 * ("2" = interrupt) captured while a busy notice is pending.
 */
import { existsSync, statSync } from 'node:fs'
import type { HostAgentRegistry } from './host.js'
import { sessionId } from './host.js'
import type { InboundMessage } from './stream.js'
import type { Outbound } from './outbound.js'
import type { Bindings } from './bridge.js'
import type { JsonStore } from './jsonstore.js'
import type { Queue } from './queue.js'

export interface ModelOverride {
  provider: string
  model: string
}

export interface CommandDeps {
  agents: HostAgentRegistry
  outbound: Outbound
  bindings: Bindings
  modelOverrides: JsonStore<ModelOverride>
  queue: Queue
  defaultModel(): { provider?: string; model?: string } | undefined
  /** Human-readable connector security/capability lines appended to /status. */
  connectorStatus(): string[]
  /** One-line dws tools-module state for /status; absent = module not wired. */
  toolsStatusLine?(): string
  /** Per-conversation workspace override store (set via /cd); absent = module not wired. */
  workspaceOverrides?: JsonStore<string>
  /** Registered host workspaces for /ws; empty when the registry is unavailable. */
  listWorkspaces?(): Promise<Array<{ path: string; title?: string }>>
  defaultWorkspace?: string
  markdownTitle: string
  log(line: string): void
}

const HELP = [
  '**可用命令**',
  '- `/status` 连接与会话状态',
  '- `/new` 重开会话（清空上下文）',
  '- `/stop` 停止当前正在执行的任务',
  '- `/model` 查看当前模型',
  '- `/model use <provider>/<model>` 切换本会话模型（会重开会话生效）',
  '- `/model reset` 恢复默认模型（会重开会话生效）',
  '- `/ws` 列出可用工作区',
  '- `/cd <路径或序号>` 切换本会话工作目录（会重开会话生效）；`/cd reset` 恢复默认',
  '- `/help` 本清单',
].join('\n')

/** Commands that must win over a pending human-interaction answer. */
export function isSessionControl(text: string): boolean {
  const command = text.trim().split(/\s+/, 1)[0]
  return command === '/new' || command === '/stop'
}

/** The queued message a busy notice refers to, plus the hook that drops it from the lane. */
export interface BusyContext {
  queuedMsg: InboundMessage
  /** Remove the queued task from the lane (used when its content is steered into the active turn). */
  skip(): void
  /**
   * Whether the queued task already left the queue and started running — a
   * fast first task can close the busy window before the choice arrives, and
   * then neither interrupting nor steering makes sense anymore.
   */
  started(): boolean
  /** The updatable notice card; a choice outcome morphs it in place instead of adding a bubble. */
  noticeCard?: Promise<{ updateStatic(content: string): Promise<void> } | null>
}

export class Commands {
  /** Conversations with a pending queue-busy notice: 1 = interrupt, 2 = steer into the active turn. */
  private pendingBusyChoice = new Map<string, { at: number; ctx: BusyContext }>()
  /** Interactive busy cards: outTrackId → conversationId (buttons and text answers share one pending state). */
  private busyCards = new Map<string, string>()

  constructor(private readonly deps: CommandDeps) {}

  markBusyNotice(conversationId: string, ctx: BusyContext): void {
    this.pendingBusyChoice.set(conversationId, { at: Date.now(), ctx })
  }

  registerBusyCard(outTrackId: string, conversationId: string): void {
    this.busyCards.set(outTrackId, conversationId)
  }

  /**
   * Consume a busy-card button press: approve = interrupt, reject = steer.
   * Only the queued message's own sender may decide.
   * @returns true when the callback belonged to a busy card and was handled.
   */
  async handleCardCallback(callback: { outTrackId: string; userId: string; actionIds: string[] }): Promise<boolean> {
    const conversationId = this.busyCards.get(callback.outTrackId)
    if (!conversationId) return false
    const action = callback.actionIds[0]
    if (action !== 'approve' && action !== 'reject') return false
    const pending = this.pendingBusyChoice.get(conversationId)
    if (!pending) {
      this.busyCards.delete(callback.outTrackId)
      return false
    }
    if (callback.userId !== pending.ctx.queuedMsg.senderStaffId) return false
    this.busyCards.delete(callback.outTrackId)
    this.pendingBusyChoice.delete(conversationId)
    const msg = pending.ctx.queuedMsg
    const reply = async (t: string): Promise<void> => {
      await this.deps.outbound.sendMarkdown(msg.sessionWebhook, this.deps.markdownTitle, t)
    }
    if (pending.ctx.started()) {
      await reply('ℹ️ 前面的任务已经完成，你排队的那条正在处理中——无需打断或并入。')
      return true
    }
    if (action === 'approve') {
      await this.stop(msg, reply, '✅ 已打断当前任务，马上处理你排队的那条。')
    } else {
      await this.steerQueued(msg, pending.ctx, reply)
    }
    return true
  }

  /** @returns true when the message was a command/choice and is fully handled. */
  async handle(msg: InboundMessage, scopeKey?: string): Promise<boolean> {
    const key = scopeKey ?? msg.conversationId
    const text = msg.text.trim()
    const reply = async (t: string): Promise<void> => {
      await this.deps.outbound.sendMarkdown(msg.sessionWebhook, this.deps.markdownTitle, t)
    }

    // Queue-busy numeric choice (valid for 5 minutes after the notice).
    // Default is queueing — sending was the queue-in; the two ACTIVE choices
    // are interrupt (1) and steer-into-current (2).
    const pending = this.pendingBusyChoice.get(key)
    if (pending && Date.now() - pending.at < 5 * 60_000 && (text === '1' || text === '2')) {
      this.pendingBusyChoice.delete(key)
      // Prefer morphing the notice card in place over adding another bubble.
      const announce = async (t: string): Promise<void> => {
        const card = pending.ctx.noticeCard ? await pending.ctx.noticeCard : null
        if (card) {
          try {
            await card.updateStatic(t)
            this.deps.log('busy notice morphed in place')
            return
          } catch (err) {
            this.deps.log(`busy notice morph failed, bubbling: ${err instanceof Error ? err.message : err}`)
          }
        } else {
          this.deps.log('busy notice card unavailable, bubbling')
        }
        await reply(t)
      }
      if (pending.ctx.started()) {
        // The fast lane already picked the queued message up — interrupting
        // would kill it and steering would duplicate it.
        await announce('ℹ️ 前面的任务已经完成，你排队的那条正在处理中——无需打断或并入。')
        return true
      }
      if (text === '1') {
        await this.stop(msg, announce, '✅ 已打断当前任务，马上处理你排队的那条。')
      } else {
        await this.steerQueued(msg, pending.ctx, announce)
      }
      return true
    }

    if (!text.startsWith('/')) return false
    const [cmd, sub, ...rest] = text.split(/\s+/)

    switch (cmd) {
      case '/help':
        await reply(HELP)
        return true

      case '/status': {
        const bound = this.deps.bindings.get(key)
        const agent = bound ? this.deps.agents.get(sessionId(bound)) : undefined
        const override = this.deps.modelOverrides.get(key)
        const model = override ?? this.deps.defaultModel()
        const ws = this.deps.workspaceOverrides?.get(key)
        await reply(
          [
            '**状态**',
            `- 会话：${bound ? `\`${bound.slice(0, 8)}…\`${agent ? `（${agent.status === 'running' ? '执行中' : '空闲'}）` : '（未加载，下条消息恢复）'}` : '尚未建立'}`,
            `- 模型：${model?.provider ?? '?'}/${model?.model ?? '?'}${override ? '（本会话覆盖）' : '（默认）'}`,
            `- 排队：${this.deps.queue.depth(key)} 条在途`,
            ...(this.deps.defaultWorkspace
              ? [`- 工作区：${ws ?? this.deps.defaultWorkspace}${ws ? '（本会话覆盖）' : '（默认）'}`]
              : []),
            ...(this.deps.toolsStatusLine ? [`- 钉钉能力：${this.deps.toolsStatusLine()}`] : []),
            ...this.deps.connectorStatus().map((line) => `- ${line}`),
          ].join('\n'),
        )
        return true
      }

      case '/new':
        {
          const bound = this.deps.bindings.get(key)
          const agent = bound ? this.deps.agents.get(sessionId(bound)) : undefined
          if (agent?.status === 'running') {
            try {
              agent.cancel({ kind: 'user' })
            } catch (err) {
              await reply(`⚠️ 旧任务取消失败，会话未重开：${err instanceof Error ? err.message : err}`)
              return true
            }
          }
        }
        this.pendingBusyChoice.delete(key)
        this.deps.queue.clear(key)
        this.deps.bindings.delete(key)
        await reply('✅ 已重开会话——上下文已清空，直接说新任务吧。')
        return true

      case '/stop':
        await this.stop(msg, reply, '✅ 已停止当前任务。', key)
        return true

      case '/model': {
        if (!sub) {
          const override = this.deps.modelOverrides.get(key)
          const model = override ?? this.deps.defaultModel()
          await reply(
            `当前模型：\`${model?.provider ?? '?'}/${model?.model ?? '?'}\`${override ? '（本会话覆盖）' : '（跟随默认）'}\n切换：\`/model use <provider>/<model>\`（可用清单见 dsh web 设置 → 模型）`,
          )
          return true
        }
        if (sub === 'reset') {
          this.deps.modelOverrides.delete(key)
          this.deps.bindings.delete(key)
          await reply('✅ 已恢复默认模型，会话已重开。')
          return true
        }
        if (sub === 'use') {
          const spec = rest.join(' ').trim()
          const slash = spec.indexOf('/')
          if (slash <= 0 || slash === spec.length - 1) {
            await reply('用法：`/model use <provider>/<model>`，例如 `/model use qoder-sdk/gm51model`')
            return true
          }
          const override = { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }
          this.deps.modelOverrides.set(key, override)
          this.deps.bindings.delete(key)
          await reply(`✅ 本会话模型已切换为 \`${override.provider}/${override.model}\`，会话已重开（新上下文生效）。`)
          return true
        }
        await reply(HELP)
        return true
      }

      case '/ws': {
        if (!this.deps.listWorkspaces || !this.deps.workspaceOverrides) {
          await reply('工作区模块未装配。')
          return true
        }
        const list = await this.deps.listWorkspaces()
        const current = this.deps.workspaceOverrides.get(key) ?? this.deps.defaultWorkspace
        const lines = list.length
          ? list.map(
              (w, i) =>
                `${i + 1}. ${w.title ? `**${w.title}** ` : ''}\`${w.path}\`${w.path === current ? '（当前）' : ''}`,
            )
          : ['（工作区注册表不可用，可直接 `/cd <绝对路径>`）']
        await reply(['**可用工作区**', ...lines, '', '切换：`/cd <序号或绝对路径>`；恢复默认：`/cd reset`'].join('\n'))
        return true
      }

      case '/cd': {
        if (!this.deps.listWorkspaces || !this.deps.workspaceOverrides) {
          await reply('工作区模块未装配。')
          return true
        }
        const target = [sub, ...rest].filter(Boolean).join(' ').trim()
        if (!target) {
          await reply('用法：`/cd <序号或绝对路径>`（先 `/ws` 看清单）；`/cd reset` 恢复默认')
          return true
        }
        if (target === 'reset') {
          this.deps.workspaceOverrides.delete(key)
          this.deps.bindings.delete(key)
          await reply(`✅ 已恢复默认工作区 \`${this.deps.defaultWorkspace}\`，会话已重开。`)
          return true
        }
        let dir = target
        if (/^\d+$/.test(target)) {
          const list = await this.deps.listWorkspaces()
          const picked = list[Number(target) - 1]
          if (!picked) {
            await reply(`没有第 ${target} 个工作区，先 \`/ws\` 看清单。`)
            return true
          }
          dir = picked.path
        }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          await reply(`目录不存在：\`${dir}\``)
          return true
        }
        this.deps.workspaceOverrides.set(key, dir)
        this.deps.bindings.delete(key)
        await reply(`✅ 本会话工作区已切换为 \`${dir}\`，会话已重开（新任务在该目录执行）。`)
        return true
      }

      default:
        await reply(`未知命令 \`${cmd}\`\n\n${HELP}`)
        return true
    }
  }

  /** Fold the queued message into the ACTIVE turn as steering, dropping its own lane slot. */
  private async steerQueued(
    msg: InboundMessage,
    ctx: BusyContext,
    reply: (t: string) => Promise<void>,
    scopeKey?: string,
  ): Promise<void> {
    const bound = this.deps.bindings.get(scopeKey ?? msg.conversationId)
    const agent = bound ? this.deps.agents.get(sessionId(bound)) : undefined
    if (agent && agent.status === 'running') {
      agent.steer({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: ctx.queuedMsg.text }],
        source: { kind: 'user' },
      })
      ctx.skip()
      await reply('✅ 已把排队那条并入当前任务——Agent 会在下一步接上你的引导。')
    } else {
      await reply('当前任务已结束，排队那条会正常独立处理，无需并入。')
    }
  }

  private async stop(
    msg: InboundMessage,
    reply: (t: string) => Promise<void>,
    okText: string,
    scopeKey?: string,
  ): Promise<void> {
    const bound = this.deps.bindings.get(scopeKey ?? msg.conversationId)
    const agent = bound ? this.deps.agents.get(sessionId(bound)) : undefined
    if (agent && agent.status === 'running') {
      try {
        agent.cancel({ kind: 'user' })
        await reply(okText)
      } catch (err) {
        await reply(`⚠️ 停止失败：${err instanceof Error ? err.message : err}`)
      }
    } else {
      await reply('当前没有正在执行的任务。')
    }
  }
}
