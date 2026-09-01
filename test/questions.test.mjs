import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { QuestionManager } from '../lib/questions.js'

function inbound(overrides = {}) {
  return {
    msgId: crypto.randomUUID(),
    conversationId: 'conversation-1',
    conversationType: 'direct',
    senderStaffId: 'user-1',
    senderNick: 'Raph',
    text: 'hello',
    createAt: String(Date.now()),
    sessionWebhook: 'https://example.test/webhook-1',
    ...overrides,
  }
}

function harness(timeoutMs = 1_000, delivered = true, interactionCards, approvalTimeoutMs, approvalUserId) {
  const sent = []
  const logs = []
  const listeners = new Map()
  let definition
  const manager = new QuestionManager({
    outbound: {
      async sendMarkdown(message, title, text) {
        sent.push({ sessionWebhook: message.sessionWebhook, title, text })
        return delivered
      },
    },
    markdownTitle: 'DSH',
    timeoutMs,
    approvalTimeoutMs,
    approvalUserId,
    interactionCards,
    log: (line) => logs.push(line),
  })
  const agent = {
    id: 'session-1',
    status: 'running',
    ctx: {
      tools: {
        register(value) {
          definition = value
          return () => {}
        },
      },
      on(name, listener) {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    },
    followup() {},
    cancel() {},
  }
  agent.ctx.agent = agent
  manager.installFor(agent)
  manager.bindSession(agent.id, inbound())
  return { manager, agent, sent, logs, definition, listeners }
}

function execute(h, questions, signal = new AbortController().signal) {
  return h.definition.execute({ questions }, { agent: h.agent, signal })
}

async function waitUntil(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待测试状态超时')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

test('单选序号由同一会话、同一发件人的下一条消息回答', async () => {
  const h = harness()
  const resultPromise = execute(h, [
    {
      id: 'mode',
      header: '选择模式',
      question: '使用哪种模式？',
      options: [{ label: '安全模式', description: '只读' }, { label: '执行模式' }],
    },
  ])

  await Promise.resolve()
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /1\. \*\*安全模式\*\*/)
  assert.equal(h.manager.handleInbound(inbound({ senderStaffId: 'other', text: '1' })), false)
  assert.equal(h.manager.handleInbound(inbound({ text: '2' })), true)
  assert.deepEqual(await resultPromise, { answers: [{ id: 'mode', selected: ['执行模式'] }] })
})

test('多选、自由文本和跳过返回 DSH 兼容的结构', async () => {
  const h = harness()
  const multi = execute(h, [
    {
      id: 'targets',
      question: '选择目标',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      multi_select: true,
    },
  ])
  await Promise.resolve()
  assert.equal(h.manager.handleInbound(inbound({ text: '1，3' })), true)
  assert.deepEqual(await multi, { answers: [{ id: 'targets', selected: ['A', 'C'] }] })

  const custom = execute(h, [{ id: 'detail', question: '请补充说明' }])
  await Promise.resolve()
  h.manager.handleInbound(inbound({ text: '按灰度方案推进' }))
  assert.deepEqual(await custom, { answers: [{ id: 'detail', selected: [], custom: '按灰度方案推进' }] })

  const skipped = execute(h, [{ id: 'optional', question: '可选信息' }])
  await Promise.resolve()
  h.manager.handleInbound(inbound({ text: '跳过' }))
  assert.deepEqual(await skipped, { answers: [{ id: 'optional', selected: [] }] })
})

test('DSH 原生 user-questions 请求通过 scoped answerer 完成 Plan Review', async () => {
  const h = harness()
  const answer = h.listeners.get('user-questions/request')
  assert.equal(typeof answer, 'function')
  const fallback = async () => {
    throw new Error('不应回落到 Web Provider')
  }
  const resultPromise = answer(
    {
      questions: [
        {
          id: 'plan-review',
          header: 'Plan review',
          question: '批准这份计划？',
          detail: '# 发布计划\n\n1. 先验证\n2. 再发布',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        },
      ],
      agent: h.agent,
      signal: new AbortController().signal,
    },
    fallback,
  )

  await Promise.resolve()
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /# 发布计划/)
  assert.equal(h.manager.handleInbound(inbound({ text: '1' })), true)
  assert.deepEqual(await resultPromise, {
    answers: [{ id: 'plan-review', selected: ['Approve'] }],
  })
})

test('Plan Review 优先使用互动卡片并允许管理员批准', async () => {
  const created = []
  const h = harness(1_000, true, {
    async create(request) {
      created.push(request)
      return true
    },
  })
  const answer = h.listeners.get('user-questions/request')
  const resultPromise = answer(
    {
      questions: [
        {
          id: 'plan-review',
          question: '批准这份计划？',
          detail: '# 计划',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        },
      ],
      agent: h.agent,
      signal: new AbortController().signal,
    },
    async () => ({ answers: [] }),
  )

  await waitUntil(() => created.length === 1)
  assert.equal(created[0].kind, 'plan-review')
  assert.equal(h.sent.length, 0)
  assert.equal(
    h.manager.handleCardCallback({
      outTrackId: created[0].outTrackId,
      userId: 'user-1',
      actionIds: ['approve'],
      params: {},
    }),
    true,
  )
  assert.deepEqual(await resultPromise, {
    answers: [{ id: 'plan-review', selected: ['Approve'] }],
  })
})

test('敏感审批只接受绑定管理员的互动卡片回调', async () => {
  const created = []
  const h = harness(1_000, true, {
    async create(request) {
      created.push(request)
      return true
    },
  })
  const approve = h.listeners.get('approval/request')
  assert.equal(typeof approve, 'function')
  const resultPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      callId: 'call-1',
      reason: '需要写入工作区',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )

  await waitUntil(() => created.length === 1)
  assert.equal(created[0].kind, 'approval')
  assert.equal(
    h.manager.handleCardCallback({
      outTrackId: created[0].outTrackId,
      userId: 'other-user',
      actionIds: ['approve'],
      params: {},
    }),
    false,
  )
  assert.equal(
    h.manager.handleCardCallback({
      outTrackId: created[0].outTrackId,
      userId: 'user-1',
      actionIds: ['approve'],
      params: {},
    }),
    true,
  )
  assert.equal(await resultPromise, 'allowed-once')
})

test('群成员触发的敏感审批仍只接受管理员', async () => {
  const created = []
  const h = harness(
    1_000,
    true,
    {
      async create(request) {
        created.push(request)
        return true
      },
    },
    undefined,
    () => 'owner-1',
  )
  h.manager.bindSession(
    h.agent.id,
    inbound({ conversationType: 'group', conversationId: 'group-1', senderStaffId: 'member-1' }),
  )
  const approve = h.listeners.get('approval/request')
  const resultPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )

  await waitUntil(() => created.length === 1)
  assert.equal(
    h.manager.handleCardCallback({
      outTrackId: created[0].outTrackId,
      userId: 'member-1',
      actionIds: ['approve'],
      params: {},
    }),
    false,
  )
  assert.equal(
    h.manager.handleCardCallback({
      outTrackId: created[0].outTrackId,
      userId: 'owner-1',
      actionIds: ['approve'],
      params: {},
    }),
    true,
  )
  assert.equal(await resultPromise, 'allowed-once')
})

test('群成员触发的文字审批由同群管理员确认', async () => {
  const h = harness(1_000, true, undefined, undefined, () => 'owner-1')
  h.manager.bindSession(
    h.agent.id,
    inbound({ conversationType: 'group', conversationId: 'group-1', senderStaffId: 'member-1' }),
  )
  const approve = h.listeners.get('approval/request')
  const resultPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )

  await waitUntil(() => h.sent.length === 1)
  const code = h.sent[0].text.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(code)
  assert.equal(
    h.manager.handleInbound(
      inbound({
        conversationType: 'group',
        conversationId: 'group-1',
        senderStaffId: 'member-1',
        text: `确认 ${code}`,
      }),
    ),
    false,
  )
  assert.equal(
    h.manager.handleInbound(
      inbound({ conversationType: 'group', conversationId: 'group-1', senderStaffId: 'owner-1', text: `确认 ${code}` }),
    ),
    true,
  )
  assert.equal(await resultPromise, 'allowed-once')

  const questionPromise = execute(h, [{ id: 'follow-up', question: '请补充参数' }])
  await waitUntil(() => h.sent.length === 2)
  assert.equal(
    h.manager.handleInbound(
      inbound({ conversationType: 'group', conversationId: 'group-1', senderStaffId: 'owner-1', text: '管理员回答' }),
    ),
    false,
  )
  assert.equal(
    h.manager.handleInbound(
      inbound({ conversationType: 'group', conversationId: 'group-1', senderStaffId: 'member-1', text: '成员回答' }),
    ),
    true,
  )
  assert.deepEqual(await questionPromise, {
    answers: [{ id: 'follow-up', selected: [], custom: '成员回答' }],
  })
})

test('其他成员私聊触发敏感审批时明确拒绝', async () => {
  const h = harness(1_000, true, undefined, undefined, () => 'owner-1')
  const approve = h.listeners.get('approval/request')
  const outcome = await approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: new AbortController().signal,
    },
    async () => 'allowed-once',
  )

  assert.equal(outcome, 'unavailable')
  assert.match(h.sent[0].text, /只能由机器人管理员批准/)
})

test('缺少互动卡片时通过一次性码完成文字审批', async () => {
  const h = harness()
  const approve = h.listeners.get('approval/request')
  const resultPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      reason: '需要写入工作区',
      signal: new AbortController().signal,
    },
    async () => 'allowed-once',
  )

  await waitUntil(() => h.sent.length === 1)
  assert.match(h.sent[0].text, /审批敏感操作/)
  assert.match(h.sent[0].text, /需要写入工作区/)
  const code = h.sent[0].text.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(code)

  assert.equal(h.manager.handleInbound(inbound({ senderStaffId: 'other-user', text: `确认 ${code}` })), false)
  assert.equal(h.manager.handleInbound(inbound({ text: '确认 WRONG1' })), true)
  assert.equal(h.manager.handleInbound(inbound({ text: `确认 ${code}` })), true)
  assert.equal(await resultPromise, 'allowed-once')
})

test('钉钉审批优先于先注册的 Web 全局审批处理器', async () => {
  const ctx = new Context()
  let webIntercepted = false
  ctx.on('approval/request', (request) => {
    webIntercepted = true
    if (request.agent.id !== 'session-web-competition') return Promise.resolve('rejected')
    return new Promise(() => {})
  })

  const sent = []
  const manager = new QuestionManager({
    outbound: {
      async sendMarkdown(message, title, text) {
        sent.push({ sessionWebhook: message.sessionWebhook, title, text })
        return true
      },
    },
    markdownTitle: 'DSH',
    timeoutMs: 1_000,
    log() {},
  })
  let agent
  const agentCtx = ctx.extend({
    get agent() {
      return agent
    },
    tools: { register: () => () => {} },
  })
  agent = {
    id: 'session-web-competition',
    status: 'running',
    ctx: agentCtx,
    followup() {},
    cancel() {},
  }
  manager.installFor(agent)
  manager.bindSession(agent.id, inbound())

  const outcome = ctx.waterfall(
    agent,
    'approval/request',
    {
      agent,
      toolName: 'bash',
      reason: '需要修改工作区',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )

  assert.equal(sent.length, 1)
  assert.equal(webIntercepted, false)
  const code = sent[0].text.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(code)
  assert.equal(manager.handleInbound(inbound({ text: `确认 ${code}` })), true)
  assert.equal(await outcome, 'allowed-once')

  const webOnlyAgent = { ...agent, id: 'session-web-only' }
  assert.equal(
    await ctx.waterfall(
      webOnlyAgent,
      'approval/request',
      { agent: webOnlyAgent, toolName: 'bash' },
      async () => 'unavailable',
    ),
    'rejected',
  )
  assert.equal(webIntercepted, true)
  assert.equal(sent.length, 1)
})

test('文字审批支持拒绝，并使用独立的审批超时', async () => {
  const h = harness(1_000, true, undefined, 30)
  const approve = h.listeners.get('approval/request')
  const rejectedPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: new AbortController().signal,
    },
    async () => 'allowed-once',
  )

  await waitUntil(() => h.sent.length === 1)
  const rejectedCode = h.sent[0].text.match(/`拒绝 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(rejectedCode)
  assert.equal(h.manager.handleInbound(inbound({ text: `拒绝 ${rejectedCode}` })), true)
  assert.equal(await rejectedPromise, 'rejected')

  const timedOutPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: new AbortController().signal,
    },
    async () => 'allowed-once',
  )
  await waitUntil(() => h.sent.length === 2)
  const expiredCode = h.sent[1].text.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(expiredCode)
  assert.equal(await timedOutPromise, 'unavailable')
  assert.equal(h.manager.handleInbound(inbound({ text: `确认 ${expiredCode}` })), false)
  assert.match(h.sent.at(-1).text, /审批已超时/)
})

test('文字审批发送卡住时仍会按审批超时 fail-closed', async () => {
  const neverDelivered = new Promise(() => {})
  const h = harness(1_000, neverDelivered, undefined, 20)
  const approve = h.listeners.get('approval/request')
  const resultPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: new AbortController().signal,
    },
    async () => 'allowed-once',
  )

  await waitUntil(() => h.sent.length === 1)
  const code = h.sent[0].text.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(code)
  const outcome = await Promise.race([
    resultPromise,
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 80)),
  ])
  assert.equal(outcome, 'unavailable')
  assert.equal(h.manager.handleInbound(inbound({ text: `确认 ${code}` })), false)
})

test('互动卡片发送失败时回退到文字审批', async () => {
  const h = harness(1_000, true, {
    async create() {
      return false
    },
  })
  const approve = h.listeners.get('approval/request')
  const resultPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )

  await waitUntil(() => h.sent.length === 1)
  const code = h.sent[0].text.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(code)
  assert.equal(h.manager.handleInbound(inbound({ text: `确认 ${code}` })), true)
  assert.equal(await resultPromise, 'allowed-once')
  assert.match(h.logs.join('\n'), /falling back to text/)
})

test('卡片发送期间取消审批不会留下文字回退', async () => {
  let releaseCard
  const h = harness(1_000, true, {
    create() {
      return new Promise((resolve) => {
        releaseCard = resolve
      })
    },
  })
  const controller = new AbortController()
  const approve = h.listeners.get('approval/request')
  const resultPromise = approve(
    {
      agent: h.agent,
      toolName: 'bash',
      signal: controller.signal,
    },
    async () => 'unavailable',
  )

  await waitUntil(() => typeof releaseCard === 'function')
  controller.abort()
  releaseCard(false)

  assert.equal(await resultPromise, 'cancelled')
  assert.equal(h.sent.length, 0)
  assert.equal(h.manager.handleInbound(inbound({ text: '确认 ABC123' })), false)
})

test('多个问题顺序发送，并使用回答消息携带的新 webhook', async () => {
  const h = harness()
  const resultPromise = execute(h, [
    { id: 'first', question: '第一个？', options: [{ label: '是' }, { label: '否' }] },
    { id: 'second', question: '第二个？' },
  ])
  await Promise.resolve()
  h.manager.handleInbound(inbound({ text: '1', sessionWebhook: 'https://example.test/webhook-2' }))
  await waitUntil(() => h.sent.length === 2)
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].sessionWebhook, 'https://example.test/webhook-2')
  h.manager.handleInbound(inbound({ text: '补充内容', sessionWebhook: 'https://example.test/webhook-3' }))
  assert.deepEqual(await resultPromise, {
    answers: [
      { id: 'first', selected: ['是'] },
      { id: 'second', selected: [], custom: '补充内容' },
    ],
  })
})

test('AbortSignal 会清理等待状态，后续消息不再被吞掉', async () => {
  const h = harness()
  const controller = new AbortController()
  const resultPromise = execute(h, [{ id: 'confirm', question: '确认？' }], controller.signal)
  await Promise.resolve()
  controller.abort()
  await assert.rejects(resultPromise, (error) => error.name === 'AbortError')
  assert.equal(h.manager.handleInbound(inbound({ text: '迟到的回答' })), false)
})

test('等待超时会拒绝工具调用、清理状态并通知用户', async () => {
  const h = harness(20)
  const resultPromise = execute(h, [{ id: 'confirm', question: '确认？' }])
  await assert.rejects(resultPromise, /timed out after 20ms/)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(h.manager.handleInbound(inbound({ text: '迟到的回答' })), false)
  assert.equal(h.sent.at(-1).text, '等待回答已超时，本次问题已取消。')
})

test('问题发送失败时立即退出等待，不吞掉后续消息', async () => {
  const h = harness(1_000, false)
  const resultPromise = execute(h, [{ id: 'confirm', question: '确认？' }])
  await assert.rejects(resultPromise, /could not deliver the question to DingTalk/)
  assert.equal(h.manager.handleInbound(inbound({ text: '后续消息' })), false)
})

test('/stop 取消等待中的 Agent 任务', async () => {
  const h = harness()
  let cancelled = false
  h.agent.cancel = () => {
    cancelled = true
  }
  const resultPromise = execute(h, [{ id: 'confirm', question: '确认？' }])
  await Promise.resolve()
  assert.equal(h.manager.handleInbound(inbound({ text: '/stop' })), true)
  await assert.rejects(resultPromise, (error) => error.name === 'AbortError')
  assert.equal(cancelled, true)
})

test('复用已加载的 Agent 时补装 scoped ask_user_question，且重复调用幂等', async () => {
  const sent = []
  let registered = 0
  let definition
  const manager = new QuestionManager({
    outbound: {
      async sendMarkdown(message, title, text) {
        sent.push({ sessionWebhook: message.sessionWebhook, title, text })
        return true
      },
    },
    markdownTitle: 'DSH',
    timeoutMs: 1_000,
    log() {},
  })
  const agent = {
    id: 'existing-session',
    status: 'idle',
    followup() {},
    cancel() {},
    ctx: {
      on() {
        return () => {}
      },
      tools: {
        register(value) {
          registered++
          definition = value
          return () => {}
        },
      },
    },
  }
  agent.ctx.agent = agent

  manager.installFor(agent)
  manager.installFor(agent)
  manager.bindSession(agent.id, inbound())

  assert.equal(registered, 1)
  const resultPromise = definition.execute(
    { questions: [{ id: 'confirm', question: '确认？' }] },
    { agent, signal: new AbortController().signal },
  )
  await Promise.resolve()
  assert.equal(sent.length, 1)
  manager.handleInbound(inbound({ text: '确认' }))
  assert.deepEqual(await resultPromise, {
    answers: [{ id: 'confirm', selected: [], custom: '确认' }],
  })
})
