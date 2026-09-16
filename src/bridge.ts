/**
 * The chat ↔ agent bridge: routes each DingTalk conversation to its DSH
 * session (persisted binding, resume on restart), injects inbound text as a
 * user message, and completes when the driven turn settles (the queue
 * serializes on that completion). Rendering lives in renderer.ts.
 */
import { randomUUID } from 'node:crypto'
import type { AgentHandle, HostAgent, HostAgentContext, HostAgentRegistry, ImageBlock, TextBlock } from './host.js'
import { sessionId } from './host.js'
import type { InboundMessage } from './stream.js'
import type { JsonStore } from './jsonstore.js'
import type { ModelOverride } from './commands.js'

/** conversationId → sessionId, persisted so a restarted host resumes the same session. */
export type Bindings = JsonStore<string>

export class BridgeSessionError extends Error {
  readonly code = 'SESSION_OWNERSHIP_CONFLICT'
}

export interface TurnRenderer {
  onInbound(sessionId: string, msg: InboundMessage): Promise<void>
}

export interface BridgeOptions {
  /** 数字员工不借用 Web UI 或其他 Channel 持有的运行实例。 */
  exclusiveOwnership?: boolean
  cwd: string
  log(line: string): void
  /** Per-conversation model override store (set via /model use). */
  modelOverrides: JsonStore<ModelOverride>
  /** Per-conversation workspace override store (set via /cd). */
  workspaceOverrides: JsonStore<string>
  /** Deployment default model route; undefined lets the host decide. */
  modelSelection(): { provider?: string; model?: string } | undefined
  /** Default agent-preset composition (tools); empty when the deployment has no roster. */
  compose(): Promise<{ agentPreset?: string; setup?: (agentCtx: HostAgentContext) => Promise<void> }>
  /** Refresh transport context for tools that wait on channel input. */
  onAgentMessage(agent: HostAgent, msg: InboundMessage): void | Promise<void>
  /** Resolve one inbound picture into a stored attachment block; null = degrade to text note. */
  resolveImage?(downloadCode: string, scopeKey: string): Promise<ImageBlock | null>
}

export class Bridge {
  private closed = false
  private readonly owned = new Map<string, AgentHandle>()
  private readonly resolving = new Map<string, Promise<HostAgent>>()

  async close(): Promise<string[]> {
    this.closed = true
    await Promise.allSettled([...this.resolving.values()])
    const handles = [...this.owned.values()]
    await Promise.all(
      handles.map(async (handle) => {
        // 宿主可能已经开始销毁 inbox；只等待所属 handle 的幂等销毁，
        // 由宿主完成取消、排空和注销，不能再操作失效的 Agent 投影。
        await handle.dispose()
        this.owned.delete(handle.agent.id)
      }),
    )
    return handles.map((handle) => handle.agent.id)
  }

  constructor(
    private readonly agents: HostAgentRegistry,
    private readonly renderer: TurnRenderer,
    private readonly bindings: Bindings,
    private readonly opts: BridgeOptions,
  ) {}

  /** Drive one message through its agent; resolves when the turn settles. */
  async process(msg: InboundMessage, scopeKey: string): Promise<string> {
    if (this.closed) throw new Error('employee_stopping')
    const agent = await this.agentFor(scopeKey)
    await this.opts.onAgentMessage(agent, msg)
    if (this.closed) throw new Error('employee_stopping')
    const settled = this.renderer.onInbound(agent.id, msg)
    const content: Array<TextBlock | ImageBlock> = []
    const parts = msg.contentParts?.length
      ? msg.contentParts
      : [
          ...(msg.imageDownloadCodes ?? []).map((downloadCode) => ({ type: 'image' as const, downloadCode })),
          ...(msg.text ? [{ type: 'text' as const, text: msg.text }] : []),
        ]
    for (const part of parts) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text })
      } else if (this.opts.resolveImage) {
        const image = await this.opts.resolveImage(part.downloadCode, scopeKey)
        if (image) content.push(image)
        else content.push({ type: 'text', text: '（用户发来一张图片，但图片接收失败）' })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '（用户发来一张图片）' })
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'user' },
    })
    await settled
    return agent.id
  }

  /** Web 只能恢复已有绑定，不能隐式新建会话或绕开本 Bridge 的生命周期。 */
  async resolveBoundSession(id: string): Promise<HostAgent | undefined> {
    const matches = [...this.bindings.entries()].filter(([, value]) => value === id)
    if (!matches.length) return undefined
    if (matches.length !== 1) throw new BridgeSessionError('employee_session_ambiguous')
    return this.agentFor(matches[0][0])
  }

  private agentFor(conversationId: string): Promise<HostAgent> {
    if (this.closed) return Promise.reject(new BridgeSessionError('employee_stopping'))
    const existing = this.resolving.get(conversationId)
    if (existing) return existing
    const pending = this.loadAgent(conversationId)
    this.resolving.set(conversationId, pending)
    void pending
      .finally(() => {
        if (this.resolving.get(conversationId) === pending) this.resolving.delete(conversationId)
      })
      .catch(() => undefined)
    return pending
  }

  private async loadAgent(conversationId: string): Promise<HostAgent> {
    // Entry-point-created agents carry no session-local model selection, so the
    // route must be supplied here or prompt assembly fails ({{model}} unset).
    // Likewise the preset must be composed via setup, or the agent has no tools.
    const agentOptions = this.opts.modelOverrides.get(conversationId) ?? this.opts.modelSelection()
    const cwd = this.opts.workspaceOverrides.get(conversationId) ?? this.opts.cwd
    const composition = await this.opts.compose()
    const bound = this.bindings.get(conversationId)
    if (bound) {
      const running = this.agents.get(sessionId(bound))
      if (running) {
        if (this.opts.exclusiveOwnership && this.owned.get(running.id)?.agent !== running)
          throw new BridgeSessionError('session_owned_by_another_runtime')
        return running
      }
      try {
        const handle = await this.agents.resume({
          resumeSessionId: sessionId(bound),
          agentOptions,
          setup: composition.setup,
        })
        this.opts.log(`resumed session ${bound} for conversation ${conversationId}`)
        return this.own(handle)
      } catch (err) {
        // 数字员工恢复失败时保留绑定与历史，不能偷偷新建空会话。
        if (this.opts.exclusiveOwnership) throw new BridgeSessionError('employee_session_resume_failed', { cause: err })
        this.opts.log(`resume ${bound} failed (${err instanceof Error ? err.message : err}); creating fresh`)
      }
    }
    const id = sessionId(randomUUID())
    const handle = await this.agents.create({
      sessionId: id,
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      agentOptions,
      setup: composition.setup,
    })
    this.bindings.set(conversationId, id)
    this.opts.log(
      `created session ${id} for conversation ${conversationId} (preset=${composition.agentPreset ?? 'none'})`,
    )
    return this.own(handle)
  }

  private async own(handle: AgentHandle): Promise<HostAgent> {
    if (this.closed) {
      await handle.dispose()
      throw new Error('employee_stopping')
    }
    this.owned.set(handle.agent.id, handle)
    return handle.agent
  }
}
