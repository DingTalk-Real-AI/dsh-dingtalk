/**
 * DingTalk text adapter for DSH's model-facing `ask_user_question` tool.
 *
 * The tool is registered in each DingTalk agent scope, where DSH intentionally
 * lets it shadow the web profile's global tool. This keeps web-created agents
 * on the browser modal while DingTalk-created agents wait for the next matching
 * chat message.
 */
import { randomBytes } from 'node:crypto'
import type {
  HostAgent,
  HostAgentContext,
  HostApprovalOutcome,
  HostApprovalRequest,
  HostToolDefinition,
  HostToolExecution,
  HostUserQuestionAnswer,
  HostUserQuestionItem,
  HostUserQuestionRequest,
  SessionId,
} from './host.js'
import type { Outbound } from './outbound.js'
import type { InteractionCardCallback, InteractionCardRequest, InteractionCardSender } from './interaction-card.js'
export type { InteractionCardCallback, InteractionCardRequest, InteractionCardSender } from './interaction-card.js'
import type { InboundMessage } from './stream.js'
import { cardTarget } from './targets.js'

interface QuestionOption {
  label: string
  description?: string
}

interface Question {
  id: string
  question: string
  header?: string
  options?: QuestionOption[]
  multi_select?: boolean
  multiSelect?: boolean
  detail?: string
  intent?: { kind: 'plan-review'; approve: string }
}

interface QuestionArgs {
  questions: Question[]
}

interface QuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

interface Route {
  conversationId: string
  conversationType: InboundMessage['conversationType']
  senderStaffId: string
  sessionWebhook: string
}

interface PendingQuestion {
  sessionId: SessionId
  agent: HostAgent
  userId: string
  cardId?: string
  question: Question
  resolve(answer: QuestionAnswer): void
  reject(error: Error): void
  cleanup(): void
}

interface PendingApproval {
  sessionId: SessionId
  userId: string
  confirmationCode: string
  resolve(outcome: HostApprovalOutcome): void
  cleanup(): void
}

/** One callback emitted by DingTalk's interactive-card Stream topic. */
export interface QuestionManagerOptions {
  outbound: Pick<Outbound, 'sendMarkdown'>
  markdownTitle: string
  timeoutMs: number
  approvalTimeoutMs?: number
  approvalUserId?: () => string | undefined
  interactionCards?: InteractionCardSender
  log(line: string): void
}

const SKIP_ANSWERS = new Set(['0', '跳过', '/skip', 'skip'])
const CANCEL_ANSWERS = new Set(['取消', '/cancel', '/stop'])

function routeKey(route: Pick<Route, 'conversationId' | 'senderStaffId'>): string {
  return `${route.conversationId}\u0000${route.senderStaffId}`
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function optionForToken(token: string, options: readonly QuestionOption[]): QuestionOption | undefined {
  const index = Number(token)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1]
  const wanted = normalized(token)
  return options.find((option) => normalized(option.label) === wanted)
}

function parseAnswer(question: Question, text: string): QuestionAnswer {
  const value = text.trim()
  const lowered = normalized(value)
  if (SKIP_ANSWERS.has(lowered)) return { id: question.id, selected: [] }

  const options = question.options ?? []
  if (!options.length) return { id: question.id, selected: [], custom: value }

  if (!(question.multi_select ?? question.multiSelect)) {
    const option = optionForToken(value, options)
    return option ? { id: question.id, selected: [option.label] } : { id: question.id, selected: [], custom: value }
  }

  // Match an entire label first so labels containing spaces remain selectable.
  const exact = optionForToken(value, options)
  if (exact) return { id: question.id, selected: [exact.label] }

  const tokens = value.split(/[,，、\s]+/u).filter(Boolean)
  const selected = tokens.map((token) => optionForToken(token, options))
  if (selected.length && selected.every((option): option is QuestionOption => option !== undefined)) {
    return { id: question.id, selected: [...new Set(selected.map((option) => option.label))] }
  }
  return { id: question.id, selected: [], custom: value }
}

function renderQuestion(question: Question, index: number, total: number): string {
  const lines = [`### ${question.header?.trim() || '需要你确认'}`, '', question.question]
  if (question.detail?.trim()) lines.push('', question.detail.trim())
  const options = question.options ?? []
  if (options.length) {
    lines.push('')
    for (const [optionIndex, option] of options.entries()) {
      lines.push(`${optionIndex + 1}. **${option.label}**${option.description ? ` — ${option.description}` : ''}`)
    }
  }
  lines.push('', total > 1 ? `问题 ${index + 1}/${total}` : '')
  if (options.length) {
    lines.push(
      (question.multi_select ?? question.multiSelect)
        ? '请回复一个或多个序号（例如 `1,3`），也可以直接输入答案。'
        : '请回复一个序号，也可以直接输入答案。',
    )
  } else {
    lines.push('请直接回复你的答案。')
  }
  lines.push('回复 `跳过` 可跳过；回复 `/stop` 可取消当前任务。')
  return lines.filter((line, lineIndex, all) => line !== '' || all[lineIndex - 1] !== '').join('\n')
}

const ASK_USER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          header: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          },
          multi_select: { type: 'boolean' },
        },
        required: ['id', 'question'],
      },
    },
  },
  required: ['questions'],
} as const

const ASK_USER_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          selected: { type: 'array', items: { type: 'string' } },
          custom: { type: 'string' },
        },
        required: ['id', 'selected'],
      },
    },
  },
  required: ['answers'],
} as const

export class QuestionManager {
  private readonly routes = new Map<SessionId, Route>()
  private readonly pendingBySession = new Map<SessionId, PendingQuestion>()
  private readonly pendingByRoute = new Map<string, PendingQuestion>()
  private readonly pendingQuestionByCard = new Map<string, PendingQuestion>()
  private readonly pendingApprovalBySession = new Map<SessionId, PendingApproval>()
  private readonly pendingApprovalByCard = new Map<string, PendingApproval>()
  private readonly pendingApprovalByRoute = new Map<string, PendingApproval>()
  private readonly installedAgents = new WeakSet<HostAgent>()

  constructor(private readonly opts: QuestionManagerOptions) {}

  /** Refresh the route before each turn; the webhook is carried by every inbound message. */
  bindSession(sessionId: SessionId, msg: InboundMessage): void {
    this.routes.set(sessionId, {
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      senderStaffId: msg.senderStaffId,
      sessionWebhook: msg.sessionWebhook,
    })
  }

  /** Register the DingTalk-specific shadow in one agent's scoped context. */
  install(agentCtx: HostAgentContext): void {
    const agent = agentCtx.agent
    if (agent && this.installedAgents.has(agent)) return
    agentCtx.tools.register(this.definition())
    if (agent) {
      this.installedAgents.add(agent)
      agentCtx.on('user-questions/request', (request, next) => {
        if (request.agent !== undefined && request.agent !== agent) return next()
        if (!this.routes.has(agent.id)) return next()
        return this.askNative(agent, request)
      })
      agentCtx.on(
        'approval/request',
        (request, next) => {
          if (request.agent !== agent) return next()
          if (!this.routes.has(agent.id)) return next()
          return this.askApproval(agent, request)
        },
        { prepend: true },
      )
      this.opts.log(`ask_user_question installed for session ${agent.id}`)
    }
  }

  /** Ensure an Agent loaded by another host surface also receives the shadow. */
  installFor(agent: HostAgent): void {
    this.install(agent.ctx)
  }

  /** Consume a matching human answer before commands and the serial task queue. */
  handleInbound(msg: InboundMessage): boolean {
    const key = routeKey(msg)
    const approval = this.pendingApprovalByRoute.get(key)
    if (approval) {
      const route = this.routes.get(approval.sessionId)
      if (route) {
        this.routes.set(approval.sessionId, { ...route, sessionWebhook: msg.sessionWebhook })
      }
      const answer = normalized(msg.text)
      const code = normalized(approval.confirmationCode)
      if (answer === `确认 ${code}`) {
        approval.cleanup()
        approval.resolve('allowed-once')
        this.opts.log(`approval approved via text for session ${approval.sessionId}`)
        return true
      }
      if (answer === `拒绝 ${code}`) {
        approval.cleanup()
        approval.resolve('rejected')
        this.opts.log(`approval rejected via text for session ${approval.sessionId}`)
        return true
      }
      void this.opts.outbound.sendMarkdown(
        msg.sessionWebhook,
        this.opts.markdownTitle,
        `审批仍在等待：请回复 \`确认 ${approval.confirmationCode}\` 或 \`拒绝 ${approval.confirmationCode}\`。`,
      )
      return true
    }
    const pending = this.pendingByRoute.get(key)
    if (!pending) return false

    this.bindSession(pending.sessionId, msg)
    const answer = normalized(msg.text)
    if (CANCEL_ANSWERS.has(answer)) {
      pending.cleanup()
      pending.agent.cancel({ kind: 'user' })
      pending.reject(abortError('用户从钉钉取消了当前问题'))
      this.opts.log(`ask_user_question cancelled for session ${pending.sessionId}`)
      return true
    }

    pending.cleanup()
    pending.resolve(parseAnswer(pending.question, msg.text))
    this.opts.log(`ask_user_question answered for session ${pending.sessionId}`)
    return true
  }

  /** Consume one authenticated interactive-card action. */
  handleCardCallback(callback: InteractionCardCallback): boolean {
    const action = callback.actionIds[0]
    if (action !== 'approve' && action !== 'reject') return false
    const approval = this.pendingApprovalByCard.get(callback.outTrackId)
    if (approval) {
      if (approval.userId !== callback.userId) return false
      approval.cleanup()
      approval.resolve(action === 'approve' ? 'allowed-once' : 'rejected')
      this.opts.log(`approval ${action === 'approve' ? 'approved' : 'rejected'} for session ${approval.sessionId}`)
      return true
    }
    const question = this.pendingQuestionByCard.get(callback.outTrackId)
    if (!question || question.userId !== callback.userId) return false
    if (question.question.intent?.kind !== 'plan-review') {
      // Plain two-option question: approve = option 1, reject = option 2.
      const options = question.question.options ?? []
      if (options.length !== 2) return false
      question.cleanup()
      question.resolve({
        id: question.question.id,
        selected: [action === 'approve' ? options[0].label : options[1].label],
      })
      this.opts.log(`question answered via card (${action}) for session ${question.sessionId}`)
      return true
    }
    const approve = question.question.intent.approve
    const reject = question.question.options?.find((option) => option.label !== approve)?.label
    if (action === 'reject' && !reject) return false
    question.cleanup()
    question.resolve({
      id: question.question.id,
      selected: [action === 'approve' ? approve : reject!],
    })
    this.opts.log(`plan review ${action === 'approve' ? 'approved' : 'rejected'} for session ${question.sessionId}`)
    return true
  }

  private definition(): HostToolDefinition {
    return {
      name: 'ask_user_question',
      description:
        'Ask the DingTalk user a concise question when confirmation, a choice, or missing information is required. The tool waits for their next matching chat reply.',
      parameters: ASK_USER_PARAMETERS,
      output: {
        schema: ASK_USER_OUTPUT,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => this.ask(args as QuestionArgs, exec),
    }
  }

  private async ask(args: QuestionArgs, exec: HostToolExecution): Promise<{ answers: QuestionAnswer[] }> {
    const agent = exec.agent
    if (!agent) throw new Error('ask_user_question requires an agent-scoped execution')
    if (this.pendingBySession.has(agent.id))
      throw new Error('ask_user_question already has a pending question for this session')

    const answers: QuestionAnswer[] = []
    for (const [index, question] of args.questions.entries()) {
      answers.push(await this.askOne(agent, question, index, args.questions.length, exec.signal))
    }
    return { answers }
  }

  private async askNative(agent: HostAgent, request: HostUserQuestionRequest): Promise<HostUserQuestionAnswer> {
    const signal = request.signal ?? new AbortController().signal
    const answers: QuestionAnswer[] = []
    for (const [index, question] of request.questions.entries()) {
      answers.push(
        await this.askOne(agent, question as HostUserQuestionItem & Question, index, request.questions.length, signal),
      )
    }
    return { answers }
  }

  private async askApproval(agent: HostAgent, request: HostApprovalRequest): Promise<HostApprovalOutcome> {
    const route = this.routes.get(agent.id)
    if (!route) return 'unavailable'
    if (this.pendingApprovalBySession.has(agent.id) || this.pendingBySession.has(agent.id)) {
      return 'unavailable'
    }

    const approvalUserId = this.opts.approvalUserId?.() || route.senderStaffId
    if (route.conversationType === 'direct' && approvalUserId !== route.senderStaffId) {
      await this.opts.outbound.sendMarkdown(
        route.sessionWebhook,
        this.opts.markdownTitle,
        '敏感操作只能由机器人管理员批准。当前是其他成员私聊，操作已拒绝；请让管理员在自己的私聊或已允许的群聊中发起。',
      )
      return 'unavailable'
    }

    const outTrackId = `dshdt_approval_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const confirmationCode = randomBytes(3).toString('hex').toUpperCase()
    const approvalRouteKey = routeKey({ ...route, senderStaffId: approvalUserId })
    let settled = false
    let pending!: PendingApproval
    const result = new Promise<HostApprovalOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const signal = request.signal
      const onAbort = () => {
        pending.cleanup()
        resolve('cancelled')
      }
      pending = {
        sessionId: agent.id,
        userId: approvalUserId,
        confirmationCode,
        resolve,
        cleanup: () => {
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (this.pendingApprovalBySession.get(agent.id) === pending) {
            this.pendingApprovalBySession.delete(agent.id)
          }
          if (this.pendingApprovalByCard.get(outTrackId) === pending) {
            this.pendingApprovalByCard.delete(outTrackId)
          }
          if (this.pendingApprovalByRoute.get(approvalRouteKey) === pending) {
            this.pendingApprovalByRoute.delete(approvalRouteKey)
          }
        },
      }
      timer = setTimeout(() => {
        pending.cleanup()
        resolve('unavailable')
        void this.opts.outbound.sendMarkdown(
          (this.routes.get(agent.id) ?? route).sessionWebhook,
          this.opts.markdownTitle,
          '敏感操作审批已超时，操作已拒绝。',
        )
      }, this.opts.approvalTimeoutMs ?? this.opts.timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingApprovalBySession.set(agent.id, pending)
      this.pendingApprovalByCard.set(outTrackId, pending)
      if (signal?.aborted) onAbort()
    })
    const raceDelivery = (
      delivery: Promise<boolean>,
      carrier: 'card' | 'text',
    ): Promise<{ kind: 'delivery'; delivered: boolean } | { kind: 'outcome'; outcome: HostApprovalOutcome }> =>
      Promise.race([
        delivery.then(
          (delivered) => ({ kind: 'delivery' as const, delivered }),
          (error) => {
            this.opts.log(
              `approval ${carrier} delivery failed for session ${agent.id}: ${error instanceof Error ? error.message : error}`,
            )
            return { kind: 'delivery' as const, delivered: false }
          },
        ),
        result.then((outcome) => ({ kind: 'outcome' as const, outcome })),
      ])

    if (request.signal?.aborted) return result
    if (this.opts.interactionCards) {
      const attempt = await raceDelivery(
        this.opts.interactionCards.create({
          outTrackId,
          kind: 'approval',
          target: cardTarget(route),
          title: `批准 ${request.toolName}？`,
          detail: request.reason ?? `DSH 请求执行敏感工具：${request.toolName}`,
          approveLabel: '允许一次',
          rejectLabel: '拒绝',
        }),
        'card',
      )
      if (attempt.kind === 'outcome') return attempt.outcome
      if (attempt.delivered) return result
      if (settled) return result
      this.opts.log(`approval card unavailable; falling back to text for session ${agent.id}`)
    }

    this.pendingApprovalByRoute.set(approvalRouteKey, pending)
    const detail = request.reason?.trim() || `DSH 请求执行敏感工具：${request.toolName}`
    const attempt = await raceDelivery(
      this.opts.outbound.sendMarkdown(
        route.sessionWebhook,
        this.opts.markdownTitle,
        [
          '### 审批敏感操作',
          '',
          `**工具**：${request.toolName}`,
          '',
          detail,
          '',
          `回复 \`确认 ${confirmationCode}\` 仅允许本次执行。`,
          `回复 \`拒绝 ${confirmationCode}\` 取消本次操作。`,
        ].join('\n'),
      ),
      'text',
    )
    if (attempt.kind === 'outcome') return attempt.outcome
    if (!attempt.delivered) {
      pending.cleanup()
      pending.resolve('unavailable')
    }
    return result
  }

  private async askOne(
    agent: HostAgent,
    question: Question,
    index: number,
    total: number,
    signal: AbortSignal,
  ): Promise<QuestionAnswer> {
    if (signal.aborted) throw abortError('ask_user_question was aborted before sending')
    const route = this.routes.get(agent.id)
    if (!route) throw new Error('ask_user_question has no active DingTalk route for this session')
    const key = routeKey(route)
    if (this.pendingByRoute.has(key)) throw new Error('this DingTalk conversation already has a pending question')
    const planApprove = question.intent?.kind === 'plan-review' ? question.intent.approve : undefined
    // A plain two-option single-select maps 1:1 onto the two-button template:
    // approve = option 1, reject = option 2 — no extra template needed.
    const twoOption = !question.intent && !question.multi_select && question.options?.length === 2
    const approveLabel = planApprove ?? (twoOption ? question.options![0].label : undefined)
    const rejectLabel = planApprove
      ? question.options?.find((option) => option.label !== planApprove)?.label
      : twoOption
        ? question.options![1].label
        : undefined
    const cardId =
      approveLabel && rejectLabel && this.opts.interactionCards
        ? `dshdt_q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
        : undefined

    let pending!: PendingQuestion
    const promise = new Promise<QuestionAnswer>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const onAbort = () => {
        pending.cleanup()
        reject(abortError('ask_user_question was aborted'))
      }
      pending = {
        sessionId: agent.id,
        agent,
        userId: route.senderStaffId,
        ...(cardId ? { cardId } : {}),
        question,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          if (this.pendingBySession.get(agent.id) === pending) this.pendingBySession.delete(agent.id)
          if (this.pendingByRoute.get(key) === pending) this.pendingByRoute.delete(key)
          if (cardId && this.pendingQuestionByCard.get(cardId) === pending) {
            this.pendingQuestionByCard.delete(cardId)
          }
        },
      }
      timer = setTimeout(() => {
        pending.cleanup()
        reject(new Error(`ask_user_question timed out after ${this.opts.timeoutMs}ms`))
        this.opts.log(`ask_user_question timed out for session ${agent.id}`)
        const latest = this.routes.get(agent.id) ?? route
        void this.opts.outbound.sendMarkdown(
          latest.sessionWebhook,
          this.opts.markdownTitle,
          '等待回答已超时，本次问题已取消。',
        )
      }, this.opts.timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingBySession.set(agent.id, pending)
      this.pendingByRoute.set(key, pending)
      if (cardId) this.pendingQuestionByCard.set(cardId, pending)
      // AbortSignal does not replay an abort that happened just before listener
      // registration, so close that race explicitly.
      if (signal.aborted) onAbort()
    })

    if (signal.aborted) return promise
    try {
      let delivered = false
      if (cardId && approveLabel && rejectLabel && this.opts.interactionCards) {
        delivered = await this.opts.interactionCards.create({
          outTrackId: cardId,
          kind: planApprove ? 'plan-review' : 'question',
          target: cardTarget(route),
          title: question.header?.trim() || (planApprove ? 'Plan Review' : '请选择'),
          detail: question.detail?.trim() || question.question,
          approveLabel,
          rejectLabel,
        })
      }
      if (!delivered) {
        delivered = await this.opts.outbound.sendMarkdown(
          route.sessionWebhook,
          this.opts.markdownTitle,
          renderQuestion(question, index, total),
        )
      }
      if (!delivered) {
        pending.cleanup()
        pending.reject(new Error('ask_user_question could not deliver the question to DingTalk'))
      }
    } catch (err) {
      pending.cleanup()
      pending.reject(err instanceof Error ? err : new Error(String(err)))
    }
    return promise
  }
}
