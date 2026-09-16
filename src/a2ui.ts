import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  HostAgentContext,
  HostApprovalOutcome,
  HostApprovalRequest,
  HostUserQuestionAnswer,
  HostUserQuestionItem,
  HostUserQuestionRequest,
  SessionId,
} from './host.js'

/** 由接入方从可信配置解析；必须明确身份命名空间，不能互换 UID、staffId、OpenDingTalkId。 */
export type A2uiRoute = {
  target: { type: 'user' | 'group'; id: string }
  /** 换绑、撤权时必须变化；不依赖数字员工协议。 */
  bindingId: string
} & ({ operatorUid: string; operatorOpenDingTalkId?: never } | { operatorUid?: never; operatorOpenDingTalkId: string })

export interface A2uiCard {
  bizId: string
  surfaceId: string
}

export type A2uiMessage = Record<string, unknown>

/** 传输负责创建真实 Surface，再调用 render；不把任意 ID 当作已创建的 Surface。 */
export interface A2uiTransport {
  create(input: {
    interactionId: string
    target: A2uiRoute['target']
    render(surfaceId: string): A2uiMessage[]
    signal: AbortSignal
  }): Promise<A2uiCard>
  update(card: A2uiCard, messages: A2uiMessage[], signal: AbortSignal): Promise<void>
}

export interface A2uiInteractionOptions {
  /** 注入方标记的可信订阅来源，不读取卡片 context 中的来源字段。 */
  source: string
  timeoutMs: number
  transport: A2uiTransport
  route(sessionId: SessionId, kind: 'approval' | 'ask'): A2uiRoute | undefined
  log?(line: string): void
}

interface Pending {
  id: string
  sessionId: SessionId
  route: A2uiRoute
  card?: A2uiCard
  expiresAt: number
  kind: 'approval' | 'ask'
  questions: readonly HostUserQuestionItem[]
  finish(outcome: Terminal, answers?: HostUserQuestionAnswer): void
}

type Terminal = HostApprovalOutcome | 'answered'
interface Result {
  outcome: Terminal
  answers?: HostUserQuestionAnswer
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function uid(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return undefined
}

function identity(route: A2uiRoute): string | undefined {
  if (route.operatorUid !== undefined && route.operatorOpenDingTalkId === undefined) {
    const value = uid(route.operatorUid)
    return value ? `uid:${value}` : undefined
  }
  if (
    route.operatorUid === undefined &&
    typeof route.operatorOpenDingTalkId === 'string' &&
    route.operatorOpenDingTalkId.trim()
  )
    return `openDingTalkId:${route.operatorOpenDingTalkId}`
  return undefined
}

function actionContext(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const atomic = object(object(object(body?.a2uiEvent)?.action)?.context)
  const legacy = object(object(body?.actionData)?.context)
  // 两种格式同时存在时必须一致；畸形新格式也不能降级绕过校验。
  if (body && Object.hasOwn(body, 'a2uiEvent')) {
    if (!atomic) return undefined
    if (Object.hasOwn(body, 'actionData')) {
      if (!legacy) return undefined
      for (const key of ['interactionId', 'action', 'answers']) {
        if (!isDeepStrictEqual(atomic[key], legacy[key])) return undefined
      }
    }
    return atomic
  }
  return legacy
}

function componentMessages(surfaceId: string, components: Record<string, unknown>[]): A2uiMessage[] {
  return [{ version: 'v1.0', updateComponents: { surfaceId, components } }]
}

// 仅用于拼入标题的纯文本；正文 reason/detail 仍保留宿主提供的 Markdown。
function markdownText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ')
}

function readOnlyCard(surfaceId: string, components: Record<string, unknown>[]): A2uiMessage[] {
  return componentMessages(surfaceId, [
    { id: 'root', component: 'Column', gap: 12, children: components.map((c) => c.id) },
    ...components,
  ])
}

function terminalHeader(outcome: Terminal): Record<string, unknown>[] {
  const [title, description] = {
    'allowed-once': ['✅ 已批准', '仅授权本次操作，**不代表执行成功**。执行结果以宿主后续反馈为准。'],
    rejected: ['⛔ 已拒绝', '本次请求未获授权。'],
    cancelled: ['○ 已取消', '本次交互已结束，无需继续操作。'],
    unavailable: ['⌛ 请求已失效', '本次请求无法继续处理，请在会话中重新发起。'],
    answered: ['✅ 回答已提交', '已将以下回答交回当前请求；这不代表批准执行工具。'],
  }[outcome]
  return [
    { id: 'title', component: 'Markdown', content: `## ${title}` },
    { id: 'status', component: 'Markdown', content: description },
  ]
}

function approvalDetails(tool: string, detail?: string): Record<string, unknown>[] {
  return [
    { id: 'tool', component: 'Text', text: `请求操作：${tool}` },
    ...(detail ? [{ id: 'detail', component: 'Markdown', content: detail }] : []),
  ]
}

function approvalCard(surfaceId: string, id: string, tool: string, detail?: string): A2uiMessage[] {
  const details = approvalDetails(tool, detail)
  return componentMessages(surfaceId, [
    {
      id: 'root',
      component: 'Column',
      gap: 12,
      children: ['title', 'status', ...details.map((c) => c.id), 'hint', 'actions'],
    },
    { id: 'title', component: 'Markdown', content: '## 🔐 操作确认' },
    { id: 'status', component: 'Markdown', content: '**等待你的确认** · 授权仅本次有效' },
    ...details,
    { id: 'hint', component: 'Markdown', content: '> 请先核对操作内容。不确定时可选择「拒绝」。' },
    { id: 'actions', component: 'Row', children: ['approve_once', 'reject'] },
    ...(['approve_once', 'reject'] as const).flatMap((action) => [
      {
        id: action,
        component: 'Button',
        child: `${action}_label`,
        variant: action === 'approve_once' ? 'primary' : 'default',
        action: { event: { name: 'dsh.interaction', context: { interactionId: id, action } } },
      },
      { id: `${action}_label`, component: 'Text', text: action === 'approve_once' ? '允许一次' : '拒绝' },
    ]),
  ])
}

function questionCard(surfaceId: string, id: string, questions: readonly HostUserQuestionItem[]): A2uiMessage[] {
  const children: string[] = ['title', 'status']
  const components: Record<string, unknown>[] = [
    { id: 'title', component: 'Markdown', content: '## 💬 需要你补充信息' },
    {
      id: 'status',
      component: 'Markdown',
      content: `共 **${questions.length}** 个问题 · 填写后统一提交；不确定的项目可留空。`,
    },
  ]
  const answers: Record<string, unknown> = {}
  for (const [index, question] of questions.entries()) {
    // 不把任意问题 ID 拼进 JSON Pointer；回传时再映射回宿主 ID。
    const key = `q${index}`
    answers[key] = { selected: [], custom: '' }
    children.push(`${key}_title`)
    components.push({
      id: `${key}_title`,
      component: 'Markdown',
      content: `### ${index + 1}. ${markdownText(question.header || question.question)}`,
    })
    if (question.header || question.detail) {
      children.push(`${key}_detail`)
      components.push({
        id: `${key}_detail`,
        component: 'Markdown',
        content: [question.question, question.detail].filter(Boolean).join('\n\n'),
      })
    }
    if (question.options?.length) {
      children.push(`${key}_choices`)
      components.push({
        id: `${key}_choices`,
        component: 'ChoicePicker',
        variant: question.multiSelect ? 'multipleSelection' : 'mutuallyExclusive',
        displayStyle: 'checkbox',
        options: question.options.map((option, i) => ({ label: option.label, value: `option_${i}` })),
        value: { path: `/answers/${key}/selected` },
      })
      const descriptions = question.options.filter((option) => option.description)
      if (descriptions.length) {
        children.push(`${key}_options_detail`)
        components.push({
          id: `${key}_options_detail`,
          component: 'Markdown',
          content: descriptions.map((option) => `${option.label}：${option.description}`).join('\n\n'),
        })
      }
    }
    children.push(`${key}_custom`)
    components.push({
      id: `${key}_custom`,
      component: 'TextField',
      label: question.options?.length ? '补充说明（可选）' : '填写回答（可选）',
      variant: 'longText',
      value: { path: `/answers/${key}/custom` },
    })
  }
  children.push('actions')
  components.push({ id: 'actions', component: 'Row', children: ['submit', 'cancel'] })
  for (const action of ['submit', 'cancel']) {
    components.push({
      id: action,
      component: 'Button',
      child: `${action}_label`,
      variant: action === 'submit' ? 'primary' : 'default',
      action: {
        event: {
          name: 'dsh.interaction',
          context: {
            interactionId: id,
            action,
            ...(action === 'submit' ? { answers: { path: '/answers' } } : {}),
          },
        },
      },
    })
    components.push({ id: `${action}_label`, component: 'Text', text: action === 'submit' ? '提交回答' : '取消' })
  }
  return [
    ...componentMessages(surfaceId, [{ id: 'root', component: 'Column', gap: 12, children }, ...components]),
    { version: 'v1.0', updateDataModel: { surfaceId, path: '/', value: { answers } } },
  ]
}

function questionReceipt(
  surfaceId: string,
  outcome: Terminal,
  questions: readonly HostUserQuestionItem[],
  answer?: HostUserQuestionAnswer,
): A2uiMessage[] {
  const components = terminalHeader(outcome)
  for (const [index, question] of questions.entries()) {
    const key = `q${index}`
    components.push({
      id: `${key}_title`,
      component: 'Markdown',
      content: `### ${index + 1}. ${markdownText(question.header || question.question)}`,
    })
    if (question.header || question.detail)
      components.push({
        id: `${key}_detail`,
        component: 'Markdown',
        content: [question.question, question.detail].filter(Boolean).join('\n\n'),
      })
    if (outcome !== 'answered') continue
    const value = answer?.answers[index]
    if (value?.selected.length)
      components.push({ id: `${key}_selected`, component: 'Text', text: `已选：${value.selected.join('、')}` })
    if (value?.custom) components.push({ id: `${key}_answer`, component: 'Text', text: value.custom })
    if (!value?.selected.length && !value?.custom)
      components.push({ id: `${key}_empty`, component: 'Markdown', content: '*未填写*' })
  }
  return readOnlyCard(surfaceId, components)
}

function parseAnswers(value: unknown, questions: readonly HostUserQuestionItem[]): HostUserQuestionAnswer | undefined {
  const input = object(value)
  if (!input || Object.keys(input).length !== questions.length) return undefined
  const answers: HostUserQuestionAnswer['answers'] = []
  for (const [index, question] of questions.entries()) {
    if (!Object.hasOwn(input, `q${index}`)) return undefined
    const answer = object(input[`q${index}`])
    if (!answer || Object.keys(answer).some((key) => key !== 'selected' && key !== 'custom')) return undefined
    const { selected, custom } = answer
    if (
      !Array.isArray(selected) ||
      !selected.every((item) => typeof item === 'string') ||
      new Set(selected).size !== selected.length ||
      (!question.multiSelect && selected.length > 1) ||
      typeof custom !== 'string' ||
      custom.length > 10_000
    )
      return undefined
    const options = new Map((question.options ?? []).map((option, i) => [`option_${i}`, option.label]))
    if (selected.some((item) => !options.has(item))) return undefined
    answers.push({
      id: question.id,
      selected: selected.map((item) => options.get(item)!),
      ...(custom ? { custom } : {}),
    })
  }
  return { answers }
}

/** 原子卡片交互与宿主续执行；不创建员工、不登录、不订阅事件，也不修改既有文字通道。 */
export class A2uiInteractions {
  private readonly pending = new Map<string, Pending>()
  private readonly installations = new Map<HostAgentContext, () => void>()
  private closed = false

  constructor(private readonly options: A2uiInteractionOptions) {
    if (
      !options.source ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647
    )
      throw new Error('invalid_a2ui_options')
  }

  /** 仅在自己拥有的 Agent 上安装，不与旧审批管理器同时接管同一个 Agent。 */
  install(ctx: HostAgentContext): () => void {
    if (this.closed) throw new Error('a2ui_closed')
    const existing = this.installations.get(ctx)
    if (existing) return existing
    const agent = ctx.agent
    if (!agent) throw new Error('a2ui_requires_agent_scope')
    const off = ctx.on(
      'approval/request',
      (request, next) => {
        if (request.agent !== agent) return next()
        return this.approve(request)
      },
      { prepend: true },
    )
    const questionOff = ctx.on(
      'user-questions/request',
      (request, next) => {
        if (request.agent && request.agent !== agent) return next()
        return this.ask(agent.id, request)
      },
      { prepend: true },
    )
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      off()
      questionOff()
      this.installations.delete(ctx)
      for (const request of this.pending.values()) {
        if (request.sessionId === agent.id) request.finish('cancelled')
      }
    }
    this.installations.set(ctx, dispose)
    return dispose
  }

  async approve(request: HostApprovalRequest): Promise<HostApprovalOutcome> {
    const { toolName, reason } = request
    const result = await this.start(
      request.agent.id,
      'approval',
      request.signal,
      (surface, id) => approvalCard(surface, id, toolName, reason),
      (surface, outcome) => readOnlyCard(surface, [...terminalHeader(outcome), ...approvalDetails(toolName, reason)]),
    )
    return result.outcome === 'answered' ? 'unavailable' : result.outcome
  }

  async ask(sessionId: SessionId, request: HostUserQuestionRequest): Promise<HostUserQuestionAnswer> {
    const questions = structuredClone(request.questions)
    if (
      !Array.isArray(questions) ||
      !questions.length ||
      questions.length > 20 ||
      questions.some((q) => !q.id || typeof q.question !== 'string' || (q.options?.length ?? 0) > 100) ||
      new Set(questions.map((q) => q.id)).size !== questions.length
    )
      throw new Error('a2ui_invalid_questions')
    const result = await this.start(
      sessionId,
      'ask',
      request.signal,
      (surface, id) => questionCard(surface, id, questions),
      (surface, outcome, answers) => questionReceipt(surface, outcome, questions, answers),
      questions,
    )
    if (result.outcome === 'answered' && result.answers) return result.answers
    const error = new Error(`a2ui_question_${result.outcome}`)
    if (result.outcome === 'cancelled') error.name = 'AbortError'
    throw error
  }

  private start(
    sessionId: SessionId,
    kind: 'approval' | 'ask',
    signal: AbortSignal | undefined,
    render: (surfaceId: string, id: string) => A2uiMessage[],
    renderTerminal: (surfaceId: string, outcome: Terminal, answers?: HostUserQuestionAnswer) => A2uiMessage[],
    questions: readonly HostUserQuestionItem[] = [],
  ): Promise<Result> {
    if (this.closed || signal?.aborted) return Promise.resolve({ outcome: 'cancelled' })
    let route: A2uiRoute | undefined
    try {
      route = this.options.route(sessionId, kind)
    } catch {
      return Promise.resolve({ outcome: 'unavailable' })
    }
    if (!route || !identity(route) || !route.bindingId || !route.target.id)
      return Promise.resolve({ outcome: 'unavailable' })
    const id = randomUUID()
    const snapshot = structuredClone(route)
    return new Promise((resolve) => {
      const delivery = new AbortController()
      let finished: Terminal | undefined
      let receiptAnswers: HostUserQuestionAnswer | undefined
      const repaint = () => {
        if (!pending.card || !finished) return
        const messages = renderTerminal(pending.card.surfaceId, finished, receiptAnswers)
        void Promise.resolve()
          .then(() => this.options.transport.update(pending.card!, messages, AbortSignal.timeout(10_000)))
          .catch(() => this.options.log?.('a2ui_terminal_update_failed'))
      }
      const onAbort = () => pending.finish('cancelled')
      const pending: Pending = {
        id,
        sessionId,
        kind,
        questions,
        route: snapshot,
        expiresAt: Date.now() + this.options.timeoutMs,
        finish: (outcome, answers) => {
          if (finished) return
          finished = outcome
          receiptAnswers = answers ? structuredClone(answers) : undefined
          this.pending.delete(id)
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          delivery.abort()
          resolve({ outcome, answers })
          repaint()
        },
      }
      const timer = setTimeout(() => pending.finish('unavailable'), this.options.timeoutMs)
      this.pending.set(id, pending)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      void Promise.resolve()
        .then(() => {
          if (finished) return undefined
          return this.options.transport.create({
            interactionId: id,
            target: structuredClone(snapshot.target),
            signal: delivery.signal,
            render: (surfaceId) => render(surfaceId, id),
          })
        })
        .then((card) => {
          if (!card) return
          if (!card.bizId || !card.surfaceId) throw new Error('a2ui_invalid_card')
          pending.card = { ...card }
          if (finished) repaint()
        })
        .catch(() => pending.finish('unavailable'))
    })
  }

  /** 只接受可信订阅的已解析事件；不精确的数值 UID 会被拒绝。应在会话队列之外调用。 */
  handleEvent(source: string, event: unknown): boolean {
    if (this.closed || source !== this.options.source) return false
    const envelope = object(event)
    if (envelope?.type !== 'user_card_action_triggered') return false
    const body = object(object(envelope.payload)?.body)
    const context = actionContext(body)
    if (typeof context?.interactionId !== 'string') return false
    const pending = this.pending.get(context.interactionId)
    if (!pending?.card || object(body?.bizInfoDTO)?.bizId !== pending.card.bizId) return false
    const operator = object(body?.operatorDTO)
    // 身份仅来自可信订阅的服务端 operatorDTO，绝不读取按钮 context 中的身份。
    if (pending.route.operatorUid !== undefined) {
      if (uid(operator?.uid) !== pending.route.operatorUid) return false
    } else if (operator?.openDingTalkId !== pending.route.operatorOpenDingTalkId) return false
    if (Date.now() >= pending.expiresAt) {
      pending.finish('unavailable')
      return false
    }
    let current: A2uiRoute | undefined
    try {
      current = this.options.route(pending.sessionId, pending.kind)
    } catch {
      return false
    }
    if (
      !current ||
      current.bindingId !== pending.route.bindingId ||
      identity(current) !== identity(pending.route) ||
      current.target.type !== pending.route.target.type ||
      current.target.id !== pending.route.target.id
    )
      return false
    if (pending.kind === 'approval') {
      if (context.action !== 'approve_once' && context.action !== 'reject') return false
      pending.finish(context.action === 'approve_once' ? 'allowed-once' : 'rejected')
    } else if (context.action === 'cancel') {
      pending.finish('cancelled')
    } else if (context.action === 'submit') {
      const answers = parseAnswers(context.answers, pending.questions)
      if (!answers) return false
      pending.finish('answered', answers)
    } else return false
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.installations.values()) dispose()
    for (const request of this.pending.values()) request.finish('cancelled')
  }
}
