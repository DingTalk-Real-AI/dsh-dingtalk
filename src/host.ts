/**
 * Narrow structural contracts for the DSH host services this plugin consumes.
 * Shapes mirror `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` as of
 * deepseek-harness main (2026-08). The host packages are private (unpublished),
 * so a composed DSH profile supplies the real implementations at runtime and
 * this package builds self-contained — the same approach dsh-lark uses.
 */

declare const SessionIdBrand: unique symbol

/** Branded session identity; the runtime value is a plain UUID string. */
export type SessionId = string & { readonly [SessionIdBrand]: never }

/** Brand a plain string as a SessionId at this package's boundary. */
export function sessionId(value: string): SessionId {
  return value as SessionId
}

/** One model-facing text block of a user message. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Durable metadata for one stored image (host `AttachmentStore.saveImage` result). */
export interface HostImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** A model-facing image block referencing a stored attachment. */
export interface ImageBlock {
  readonly type: 'image'
  readonly attachment: HostImageRef
}

/** `ctx.attachments` — image intake store (subset of the host `AttachmentStore`). */
export interface HostAttachments {
  readonly imageLimits: {
    readonly maxImageBytes: number
    readonly mediaTypes: readonly string[]
  }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<HostImageRef>
}

/** A user-role message accepted by {@link HostAgent.followup}. */
export interface UserMessage {
  /** Stable message identity; a fresh UUID per message. */
  readonly id: string
  readonly role: 'user'
  readonly content: ReadonlyArray<TextBlock | ImageBlock>
  /** Producer tag: chat input is a direct human prompt. */
  readonly source: { readonly kind: 'user' }
}

/** Live agent handle (subset of the host `Agent` interface). */
export interface HostAgent {
  readonly id: SessionId
  /** `idle` = no driver active; `running` = a turn is in flight. */
  readonly status: 'idle' | 'running'
  /** Agent-scoped registration boundary, available on already-loaded agents too. */
  readonly ctx: HostAgentContext
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: UserMessage): void
  /** Submit steering; a running driver consumes it at its next step boundary. */
  steer(message: UserMessage): void
  /** Abort the active turn; `keepInbox` preserves queued work. */
  cancel(cause: { readonly kind: 'user' }, options?: { keepInbox?: boolean }): void
}

/** Owned handle returned by create/resume; disposing stops and unregisters the agent. */
export interface AgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** Provider/model route for a new agent (subset of the host `AgentOptions`). */
export interface AgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

/** One model-facing tool definition registered in an agent scope. */
export interface HostToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly TextBlock[]
  }
  readonly timeoutMs?: number
  execute(args: unknown, exec: HostToolExecution): Promise<unknown>
}

/** Runtime identity supplied to a model-facing tool call. */
export interface HostToolExecution {
  readonly agent?: HostAgent
  readonly signal: AbortSignal
}

/** Agent-scoped services exposed during preset composition. */
export interface HostAgentContext {
  /** The owning Agent; DSH installs this as an own property on Agent.ctx. */
  readonly agent?: HostAgent
  readonly tools: {
    register(definition: HostToolDefinition): () => void
  }
  /** Register a live user-interaction answerer scoped to this Agent. */
  on(
    name: 'user-questions/request',
    listener: (
      request: HostUserQuestionRequest,
      next: () => Promise<HostUserQuestionAnswer>,
    ) => Promise<HostUserQuestionAnswer>,
  ): () => void
  /** Register a fail-closed approval answerer scoped to this Agent. */
  on(
    name: 'approval/request',
    listener: (request: HostApprovalRequest, next: () => Promise<HostApprovalOutcome>) => Promise<HostApprovalOutcome>,
    options?: { readonly prepend?: boolean },
  ): () => void
}

/** Outcomes accepted by DSH's approval service. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One live sensitive-operation decision requested by DSH. */
export interface HostApprovalRequest {
  readonly agent: HostAgent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** One option supplied through DSH's native user-questions service. */
export interface HostUserQuestionOption {
  readonly label: string
  readonly description?: string
}

/** One native question, including the Plan Review presentation intent. */
export interface HostUserQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly HostUserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

/** A scoped DSH request for human input. */
export interface HostUserQuestionRequest {
  readonly questions: readonly HostUserQuestionItem[]
  readonly agent?: HostAgent
  readonly signal?: AbortSignal
}

/** One native answer returned to DSH. */
export interface HostUserQuestionAnswerItem {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

/** The complete response to a native DSH question request. */
export interface HostUserQuestionAnswer {
  readonly answers: HostUserQuestionAnswerItem[]
}

/** Creation-time composition of the agent's scoped world (tools, prompt sections). */
export type AgentSetup = (agentCtx: HostAgentContext) => Promise<void>

/** Subset of the host `CreateAgentOptions`. */
export interface CreateAgentOptions {
  readonly sessionId: SessionId
  readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
  readonly agentOptions?: AgentOptions
  readonly setup?: AgentSetup
}

/** Subset of the host `ResumeAgentOptions`. */
export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId
  readonly agentOptions?: AgentOptions
  readonly setup?: AgentSetup
}

/**
 * `ctx.agentPresets` — the optional preset roster (subset). Without mounting a
 * preset, an entry-point-created agent gets no tools at all (the web UI always
 * composes one, e.g. `standard-codex`).
 */
export interface HostAgentPresets {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: unknown, id: string): Promise<void>
}

/** A detached default-model selection from `ctx.agentDefaultModel`. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
}

/** `ctx.agentDefaultModel` — deployment default for entry-point-created agents (subset). */
export interface HostDefaultModel {
  currentSelection(): ModelSelection
}

/** `ctx.agents` — the AgentRegistry service (subset). */
export interface HostAgentRegistry {
  get(id: SessionId): HostAgent | undefined
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** The session a `session/event` dispatch concerns (subset). */
export interface HostSession {
  readonly id: SessionId
}

/** A durable session event from the `session/event` feed (subset; payload is event-specific). */
export interface HostSessionEvent {
  readonly type: string
  readonly data?: any
}
