/**
 * The chat ↔ agent bridge: routes each DingTalk conversation to its DSH
 * session (persisted binding, resume on restart), injects inbound text as a
 * user message, and completes when the driven turn settles (the queue
 * serializes on that completion). Rendering lives in renderer.ts.
 */
import { randomUUID } from 'node:crypto'
import type { HostAgent, HostAgentContext, HostAgentRegistry, ImageBlock, TextBlock } from './host.js'
import { sessionId } from './host.js'
import type { InboundMessage } from './stream.js'
import type { Renderer } from './renderer.js'
import type { JsonStore } from './jsonstore.js'
import type { ModelOverride } from './commands.js'

/** conversationId → sessionId, persisted so a restarted host resumes the same session. */
export type Bindings = JsonStore<string>

export interface BridgeOptions {
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
  onAgentMessage(agent: HostAgent, msg: InboundMessage): void
  /** Resolve one inbound picture into a stored attachment block; null = degrade to text note. */
  resolveImage?(downloadCode: string, scopeKey: string): Promise<ImageBlock | null>
}

export class Bridge {
  constructor(
    private readonly agents: HostAgentRegistry,
    private readonly renderer: Renderer,
    private readonly bindings: Bindings,
    private readonly opts: BridgeOptions,
  ) {}

  /** Drive one message through its agent; resolves when the turn settles. */
  async process(msg: InboundMessage, scopeKey: string): Promise<void> {
    const agent = await this.agentFor(scopeKey)
    this.opts.onAgentMessage(agent, msg)
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
  }

  private async agentFor(conversationId: string): Promise<HostAgent> {
    // Entry-point-created agents carry no session-local model selection, so the
    // route must be supplied here or prompt assembly fails ({{model}} unset).
    // Likewise the preset must be composed via setup, or the agent has no tools.
    const agentOptions = this.opts.modelOverrides.get(conversationId) ?? this.opts.modelSelection()
    const cwd = this.opts.workspaceOverrides.get(conversationId) ?? this.opts.cwd
    const composition = await this.opts.compose()
    const bound = this.bindings.get(conversationId)
    if (bound) {
      const running = this.agents.get(sessionId(bound))
      if (running) return running
      try {
        const handle = await this.agents.resume({
          resumeSessionId: sessionId(bound),
          agentOptions,
          setup: composition.setup,
        })
        this.opts.log(`resumed session ${bound} for conversation ${conversationId}`)
        return handle.agent
      } catch (err) {
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
    return handle.agent
  }
}
