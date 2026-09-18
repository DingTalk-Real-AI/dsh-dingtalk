import { randomBytes } from 'node:crypto'
import type {
  HostAgentContext,
  HostApprovalOutcome,
  HostSession,
  HostSessionEvent,
  HostUserQuestionAnswer,
  HostUserQuestionItem,
  HostUserQuestionRequest,
} from './host.js'
import type { InboundMessage } from './stream.js'
import type { DigitalEmployeeControlSink, DigitalEmployeeReplySink } from './digital-employee-reply-sink.js'
import type { DigitalEmployeeEvent, DigitalEmployeeInbound } from './digital-employee-types.js'
import { describeTurnError } from './errors.js'

const EMPTY_MODEL_RESPONSE = '模型本次未产出正文，请稍后重试。'

interface TurnState {
  event: DigitalEmployeeEvent
  finalParts: string[]
  chunks: string[]
  settle(): void
  fail(error: unknown): void
}

export class DigitalEmployeeTextRenderer {
  private readonly pendingEvents = new Map<string, DigitalEmployeeEvent>()
  private readonly states = new Map<string, TurnState>()

  constructor(
    private readonly runtime: DigitalEmployeeReplySink,
    private readonly log: (line: string) => void,
  ) {}

  accept(input: DigitalEmployeeInbound): void {
    this.pendingEvents.set(input.message.msgId, input.event)
  }

  discard(messageId: string): void {
    this.pendingEvents.delete(messageId)
  }

  onInbound(sessionId: string, msg: InboundMessage): Promise<void> {
    const event = this.pendingEvents.get(msg.msgId)
    this.pendingEvents.delete(msg.msgId)
    if (!event) return Promise.reject(new Error('missing_digital_employee_reply_context'))
    let settle!: () => void
    let fail!: (error: unknown) => void
    const settled = new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    this.states.set(sessionId, { event, finalParts: [], chunks: [], settle, fail })
    return settled
  }

  onSessionEvent(session: HostSession, event: HostSessionEvent): void {
    const state = this.states.get(session.id)
    if (!state) return
    if (event.type === 'assistant/chunk') {
      const chunk = event.data?.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') state.chunks.push(chunk.text)
      return
    }
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) return
      const text = blocks
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('')
      if (text.trim()) state.finalParts.push(text)
      return
    }
    if (event.type === 'turn/end') void this.finalize(session.id, state, event.data?.reason)
  }

  private async finalize(sessionId: string, state: TurnState, reason: any): Promise<void> {
    if (!this.states.delete(sessionId)) return
    const kind = reason?.kind
    if (kind === 'aborted') {
      state.settle()
      return
    }
    const failure = reason?.failure ?? reason?.error
    const failureMessage = typeof failure === 'string' ? failure : failure?.message
    const failureCode =
      typeof failure === 'object' && failure !== null && failure.code !== undefined ? String(failure.code) : undefined
    const errorText = kind === 'error' ? describeTurnError(failureMessage, failureCode).replace(/[*`>#]/g, '') : ''
    const text =
      [state.finalParts.join('\n\n').trim() || state.chunks.join('').trim(), errorText]
        .filter(Boolean)
        .join('\n\n')
        .trim() || EMPTY_MODEL_RESPONSE
    try {
      await this.runtime.reply(state.event, sessionId, text)
      state.settle()
    } catch (error) {
      this.log(`text reply failed (${error instanceof Error ? error.message : 'unknown'})`)
      state.fail(error)
    }
  }
}

interface ApprovalState {
  code: string
  toolName: string
  ready: boolean
  responding: boolean
  finish(outcome: HostApprovalOutcome): void
}
interface QuestionState {
  event: DigitalEmployeeEvent
  request: HostUserQuestionRequest
  ready: boolean
  finish(answer?: HostUserQuestionAnswer): void
}

/** 文字降级仍只允许 operator 私聊确认；同一会话只有一个交互所有者。 */
export class DigitalEmployeeApprovalManager {
  private readonly sessionEvents = new Map<string, DigitalEmployeeEvent>()
  private readonly approvals = new Map<string, ApprovalState>()
  private readonly questions = new Map<string, QuestionState>()
  private readonly installations = new Map<HostAgentContext, () => void>()
  private questionSequence = 0
  private closed = false

  constructor(
    private readonly runtime: DigitalEmployeeControlSink,
    private readonly operatorOpenDingTalkId: string,
    private readonly timeoutMs: number,
    private readonly log: (line: string) => void,
    private readonly questionTimeoutMs = timeoutMs,
  ) {}

  bindSession(sessionId: string, event: DigitalEmployeeEvent): void {
    if (!this.closed) this.sessionEvents.set(sessionId, event)
  }

  install(ctx: HostAgentContext): void {
    if (this.closed || this.installations.has(ctx)) return
    const questionOff = ctx.on(
      'user-questions/request',
      (request, next) => {
        const agent = request.agent ?? ctx.agent
        if (ctx.agent && agent !== ctx.agent) return next()
        const event = agent ? this.sessionEvents.get(agent.id) : undefined
        if (!agent || !event) return next()
        if (this.closed || request.signal?.aborted || !request.questions.length)
          return Promise.reject(new Error('question_unavailable'))
        if (
          this.approvals.has(agent.id) ||
          this.questions.has(agent.id) ||
          [...this.questions.values()].some(
            (q) =>
              q.event.conversationId === event.conversationId &&
              q.event.senderOpenDingTalkId === event.senderOpenDingTalkId,
          )
        )
          return Promise.reject(new Error('interaction_already_pending'))
        return new Promise<HostUserQuestionAnswer>((resolve, reject) => {
          let done = false
          const onAbort = () => pending.finish()
          const pending: QuestionState = {
            event,
            request,
            ready: false,
            finish: (answer) => {
              if (done) return
              done = true
              clearTimeout(timer)
              request.signal?.removeEventListener('abort', onAbort)
              this.questions.delete(agent.id)
              if (answer) resolve(answer)
              else {
                const error = new Error('question_cancelled_or_unavailable')
                if (request.signal?.aborted) error.name = 'AbortError'
                reject(error)
              }
            },
          }
          const timer = setTimeout(() => pending.finish(), this.questionTimeoutMs)
          this.questions.set(agent.id, pending)
          request.signal?.addEventListener('abort', onAbort, { once: true })
          if (request.signal?.aborted) {
            onAbort()
            return
          }
          const sequence = ++this.questionSequence
          void Promise.resolve()
            .then(() => {
              if (done) return
              return this.runtime.reply(
                event,
                agent.id,
                renderQuestions(request.questions),
                `question_prompt_${sequence}`,
              )
            })
            .then((delivery) => {
              if (done) return
              if (delivery?.deliveryStatus === 'delivered') pending.ready = true
              else pending.finish()
            })
            .catch(() => {
              pending.finish()
              this.log('question delivery failed; no alternate channel')
            })
        })
      },
      { prepend: true },
    )
    const approvalOff = ctx.on(
      'approval/request',
      (request, next) => {
        if (ctx.agent && request.agent !== ctx.agent) return next()
        const sessionId = request.agent.id
        const event = this.sessionEvents.get(sessionId)
        if (!event) return next()
        if (this.closed || request.signal?.aborted) return Promise.resolve('cancelled')
        if (this.approvals.has(sessionId) || this.questions.has(sessionId)) return Promise.resolve('unavailable')
        let code: string
        do {
          code = randomBytes(3).toString('hex').toUpperCase()
        } while ([...this.approvals.values()].some((pending) => pending.code === code))
        return new Promise<HostApprovalOutcome>((resolve) => {
          let done = false
          const onAbort = () => pending.finish('cancelled')
          const pending: ApprovalState = {
            code,
            toolName: request.toolName,
            ready: false,
            responding: false,
            finish: (outcome) => {
              if (done) return
              done = true
              clearTimeout(timer)
              request.signal?.removeEventListener('abort', onAbort)
              this.approvals.delete(sessionId)
              resolve(outcome)
            },
          }
          const timer = setTimeout(() => pending.finish('unavailable'), this.timeoutMs)
          this.approvals.set(sessionId, pending)
          request.signal?.addEventListener('abort', onAbort, { once: true })
          if (request.signal?.aborted) {
            onAbort()
            return
          }
          void Promise.resolve()
            .then(() => {
              if (done) return
              return this.runtime.operatorPrivate(
                [
                  'DSH 数字员工请求敏感操作审批',
                  `工具：${request.toolName}`,
                  request.reason ? `原因：${request.reason}` : '',
                  `允许一次请回复：确认 ${code}`,
                  `拒绝请回复：拒绝 ${code}`,
                ]
                  .filter(Boolean)
                  .join('\n'),
                'approval_request',
              )
            })
            .then(async (delivery) => {
              if (done) return
              if (delivery?.deliveryStatus !== 'delivered') {
                pending.finish('unavailable')
                return
              }
              await this.runtime.audit({
                eventId: event.eventId,
                sessionId,
                operationType: 'approval_request',
                toolName: request.toolName,
                status: delivery.deliveryStatus,
                replyMessageId: delivery.openMessageId,
              })
              if (!done) pending.ready = true
            })
            .catch(() => {
              pending.finish('unavailable')
              this.log('operator approval delivery failed; no alternate channel')
            })
        })
      },
      { prepend: true },
    )
    this.installations.set(ctx, () => {
      questionOff()
      approvalOff()
    })
  }

  async handleInbound(input: DigitalEmployeeInbound): Promise<boolean> {
    if (this.closed) return false
    if (input.event.conversationType === 'direct' && input.event.senderOpenDingTalkId === this.operatorOpenDingTalkId) {
      const match = input.event.text.trim().match(/^(确认|拒绝)\s+([A-F0-9]{6})$/)
      if (match) {
        for (const [sessionId, approval] of this.approvals) {
          if (approval.code !== match[2]) continue
          if (!approval.ready || approval.responding) return true
          approval.responding = true
          const approved = match[1] === '确认'
          try {
            await this.runtime.audit({
              eventId: input.event.eventId,
              sessionId,
              operationType: 'approval_response',
              toolName: approval.toolName,
              status: approved ? 'allowed_once' : 'rejected',
            })
            approval.finish(approved ? 'allowed-once' : 'rejected')
          } catch {
            approval.finish('unavailable')
          }
          return true
        }
      }
    }
    for (const question of this.questions.values()) {
      if (
        input.event.conversationId !== question.event.conversationId ||
        input.event.conversationType !== question.event.conversationType ||
        input.event.senderOpenDingTalkId !== question.event.senderOpenDingTalkId
      )
        continue
      if (!question.ready) return true
      const answer = parseQuestionAnswer(question.request.questions, input.event.text)
      if (!answer) return false
      question.finish(answer)
      return true
    }
    return false
  }

  expects(event: DigitalEmployeeEvent): boolean {
    if (
      event.conversationType === 'direct' &&
      event.senderOpenDingTalkId === this.operatorOpenDingTalkId &&
      /^(确认|拒绝)\s+[A-F0-9]{6}$/.test(event.text.trim()) &&
      this.approvals.size > 0
    )
      return true
    return [...this.questions.values()].some(
      (q) =>
        event.conversationId === q.event.conversationId && event.senderOpenDingTalkId === q.event.senderOpenDingTalkId,
    )
  }

  close(): void {
    this.closed = true
    for (const pending of this.approvals.values()) pending.finish('cancelled')
    for (const pending of this.questions.values()) pending.finish()
    for (const off of this.installations.values()) off()
    this.installations.clear()
    this.sessionEvents.clear()
  }
}
function renderQuestions(questions: readonly HostUserQuestionItem[]): string {
  const lines = ['DSH 需要你补充信息：']
  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header ? `[${question.header}] ` : ''}${question.question}`)
    if (question.detail) lines.push(`   ${question.detail}`)
    question.options?.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    })
  })
  lines.push(
    questions.length === 1
      ? '请直接回复选项序号、选项文字或自定义答案。'
      : '请逐行回复“题号=答案”，例如：1=1；2=自定义内容。',
  )
  return lines.join('\n')
}

function parseOneQuestion(question: HostUserQuestionItem, value: string): { selected: string[]; custom?: string } {
  const raw = value.trim()
  const values = question.multiSelect ? raw.split(/[，,]+/u).map((item) => item.trim()) : [raw]
  const selected: string[] = []
  const custom: string[] = []
  for (const entry of values) {
    const numeric = Number(entry)
    const option = Number.isInteger(numeric) && numeric > 0 ? question.options?.[numeric - 1] : undefined
    const exact = question.options?.find((item) => item.label === entry)
    if (option || exact) selected.push((option ?? exact)!.label)
    else if (entry) custom.push(entry)
  }
  return {
    selected,
    ...(custom.length ? { custom: custom.join(question.multiSelect ? '，' : '') } : {}),
  }
}

function parseQuestionAnswer(
  questions: readonly HostUserQuestionItem[],
  text: string,
): HostUserQuestionAnswer | undefined {
  if (questions.length === 1) {
    const answer = parseOneQuestion(questions[0], text)
    if (!answer.selected.length && !answer.custom) return undefined
    return { answers: [{ id: questions[0].id, ...answer }] }
  }
  const entries = new Map<number, string>()
  for (const line of text.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s*[=:：]\s*(.+)$/u)
    if (match) entries.set(Number(match[1]), match[2])
  }
  if (entries.size !== questions.length) return undefined
  return {
    answers: questions.map((question, index) => ({
      id: question.id,
      ...parseOneQuestion(question, entries.get(index + 1) ?? ''),
    })),
  }
}
