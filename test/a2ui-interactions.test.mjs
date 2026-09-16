import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { A2uiInteractions } from '../lib/a2ui.js'

function harness(overrides = {}) {
  const sent = []
  const updated = []
  const listeners = new Map()
  const agent = { id: 'session-1' }
  const ctx = {
    agent,
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  agent.ctx = ctx
  const manager = new A2uiInteractions({
    source: 'account-1',
    timeoutMs: 10_000,
    route: () => ({ target: { type: 'user', id: 'recipient-1' }, operatorUid: '123', bindingId: 'binding-1' }),
    transport: {
      async create(input) {
        const card = { bizId: `biz-${sent.length}`, surfaceId: `surface-${sent.length}` }
        sent.push({ ...input, ...card, messages: input.render(card.surfaceId) })
        return card
      },
      async update(card, messages) {
        updated.push({ card, messages })
      },
    },
    ...overrides,
  })
  const dispose = manager.install(ctx)
  return { manager, sent, updated, listeners, agent, ctx, dispose }
}

async function ready() {
  await new Promise((resolve) => setImmediate(resolve))
}

function event(card, action, overrides = {}) {
  return {
    type: 'user_card_action_triggered',
    payload: {
      body: {
        bizInfoDTO: { bizId: card.bizId },
        operatorDTO: { uid: '123' },
        actionData: { context: { interactionId: card.interactionId, action, ...overrides } },
      },
    },
  }
}

// 按端上实际回调结构缩减，所有业务、会话和身份值均为测试数据。
function atomicEvent(card, action, overrides = {}) {
  return {
    type: 'user_card_action_triggered',
    payload: {
      body: {
        a2uiEvent: {
          version: '1.0',
          action: {
            context: {
              interactionId: card.interactionId,
              action,
              corpId: 'fixture-corp',
              openDingTalkId: 'fixture-actor',
              ...overrides,
            },
          },
        },
        bizInfoDTO: { bizId: card.bizId },
        operatorDTO: { openDingTalkId: 'fixture-actor' },
        conversationContextDTO: { openConversationId: 'fixture-conversation' },
      },
    },
  }
}

test('真实原子回调 a2uiEvent + OpenDingTalkId 能恢复审批，动作上下文不是身份凭证', async (t) => {
  const h = harness({
    route: () => ({
      target: { type: 'user', id: 'fixture-actor' },
      operatorOpenDingTalkId: 'fixture-actor',
      bindingId: 'binding-1',
    }),
  })
  t.after(() => h.manager.close())
  const result = h.manager.approve({ agent: h.agent, toolName: 'fixture' })
  await ready()
  assert.equal(h.sent.length, 1)
  const callback = atomicEvent(h.sent[0], 'approve_once')
  const wrongActor = structuredClone(callback)
  wrongActor.payload.body.operatorDTO.openDingTalkId = 'another-actor'
  assert.equal(h.manager.handleEvent('account-1', wrongActor), false)
  const missingActor = structuredClone(callback)
  delete missingActor.payload.body.operatorDTO
  assert.equal(h.manager.handleEvent('account-1', missingActor), false)
  assert.equal(h.manager.handleEvent('account-1', callback), true)
  assert.equal(await result, 'allowed-once')
  assert.equal(h.manager.handleEvent('account-1', callback), false)
})

test('原生审批由匹配卡片和操作人恢复一次，重复回调不再执行', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const result = h.listeners.get('approval/request')({ agent: h.agent, toolName: 'fixture_tool' }, () => {
    throw new Error('已接管的审批不能落到其他授权渠道')
  })
  await ready()
  assert.equal(h.sent.length, 1)
  const components = h.sent[0].messages[0].updateComponents.components
  assert.deepEqual(
    components.filter((c) => c.component === 'Button').map((c) => c.action.event.context.action),
    ['approve_once', 'reject'],
  )
  const callback = event(h.sent[0], 'approve_once')
  assert.equal(h.manager.handleEvent('wrong-account', callback), false)
  assert.equal(h.manager.handleEvent('account-1', callback), true)
  assert.equal(h.manager.handleEvent('account-1', callback), false)
  assert.equal(await result, 'allowed-once')
  await ready()
  assert.equal(h.updated.length, 1)
  assert.equal(
    h.updated[0].messages[0].updateComponents.components.some((c) => c.component === 'Button'),
    false,
  )
})

test('原子回调拒绝身份空间混用、授权变更和冲突动作格式', async (t) => {
  let route = {
    target: { type: 'user', id: 'fixture-actor' },
    operatorOpenDingTalkId: 'fixture-actor',
    bindingId: 'binding-1',
  }
  const h = harness({ route: () => route })
  t.after(() => h.manager.close())
  const result = h.manager.approve({ agent: h.agent, toolName: 'fixture' })
  await ready()
  const callback = atomicEvent(h.sent[0], 'reject')
  const wrongNamespace = structuredClone(callback)
  wrongNamespace.payload.body.operatorDTO = { uid: 'fixture-actor' }
  assert.equal(h.manager.handleEvent('account-1', wrongNamespace), false)
  const mixed = structuredClone(callback)
  mixed.payload.body.actionData = { context: { interactionId: h.sent[0].interactionId, action: 'approve_once' } }
  assert.equal(h.manager.handleEvent('account-1', mixed), false)
  const malformed = event(h.sent[0], 'approve_once')
  malformed.payload.body.operatorDTO = { openDingTalkId: 'fixture-actor' }
  malformed.payload.body.a2uiEvent = null
  assert.equal(h.manager.handleEvent('account-1', malformed), false)
  const saved = structuredClone(route)
  for (const change of [{ operatorOpenDingTalkId: 'changed' }, { bindingId: 'changed' }, { operatorUid: '123' }]) {
    route = { ...saved, ...change }
    assert.equal(h.manager.handleEvent('account-1', callback), false)
  }
  route = saved
  assert.equal(h.manager.handleEvent('account-1', callback), true)
  assert.equal(await result, 'rejected')
})

test('UID 路由不能以同值 OpenDingTalkId 回调授权，两种配置不可同时启用', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const result = h.manager.approve({ agent: h.agent, toolName: 'fixture' })
  await ready()
  const callback = atomicEvent(h.sent[0], 'approve_once')
  callback.payload.body.operatorDTO = { openDingTalkId: '123' }
  assert.equal(h.manager.handleEvent('account-1', callback), false)
  h.manager.close()
  assert.equal(await result, 'cancelled')
  const invalid = harness({
    route: () => ({
      target: { type: 'user', id: 'fixture' },
      bindingId: 'binding-1',
      operatorUid: '123',
      operatorOpenDingTalkId: 'fixture-actor',
    }),
  })
  t.after(() => invalid.manager.close())
  assert.equal(await invalid.manager.approve({ agent: invalid.agent, toolName: 'fixture' }), 'unavailable')
  assert.equal(invalid.sent.length, 0)
})

test('原子 ask 回调返回结构化答案，双格式答案冲突不恢复请求', async (t) => {
  const h = harness({
    route: () => ({
      target: { type: 'user', id: 'fixture-actor' },
      operatorOpenDingTalkId: 'fixture-actor',
      bindingId: 'binding-1',
    }),
  })
  t.after(() => h.manager.close())
  const result = h.manager.ask('session-1', { questions: [{ id: 'note', question: '备注' }] })
  await ready()
  const callback = atomicEvent(h.sent[0], 'submit', { answers: { q0: { selected: [], custom: 'fixture answer' } } })
  const mixed = structuredClone(callback)
  mixed.payload.body.actionData = {
    context: {
      ...callback.payload.body.a2uiEvent.action.context,
      answers: { q0: { selected: [], custom: 'different' } },
    },
  }
  assert.equal(h.manager.handleEvent('account-1', mixed), false)
  assert.equal(h.manager.handleEvent('account-1', callback), true)
  assert.deepEqual(await result, { answers: [{ id: 'note', selected: [], custom: 'fixture answer' }] })
})

test('原生 ask 在一张卡片中组合单选、多选、自由文本并返回宿主标签', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const result = h.listeners.get('user-questions/request')(
    {
      agent: h.agent,
      questions: [
        { id: 'mode/path', question: '选择模式', options: [{ label: '安全' }, { label: '执行' }] },
        { id: 'targets', question: '选择目标', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'note', question: '补充说明' },
      ],
    },
    () => {
      throw new Error('不应落到 Web 提问')
    },
  )
  await ready()
  const components = h.sent[0].messages[0].updateComponents.components
  assert.deepEqual(
    components.filter((c) => c.component === 'ChoicePicker').map((c) => c.variant),
    ['mutuallyExclusive', 'multipleSelection'],
  )
  const submit = components.find((c) => c.id === 'submit')
  assert.deepEqual(submit.action.event.context.answers, { path: '/answers' })
  const answers = {
    q0: { selected: ['option_0'], custom: '' },
    q1: { selected: ['option_0', 'option_1'], custom: '' },
    q2: { selected: [], custom: '分阶段执行' },
  }
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'approve_once')), false)
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'submit', { answers })), true)
  assert.deepEqual(await result, {
    answers: [
      { id: 'mode/path', selected: ['安全'] },
      { id: 'targets', selected: ['A', 'B'] },
      { id: 'note', selected: [], custom: '分阶段执行' },
    ],
  })
})

test('拒绝伪造操作人、错误卡片、精度丢失的 UID、错误事件和撤销的绑定', async (t) => {
  let route = { target: { type: 'user', id: 'recipient-1' }, operatorUid: '123', bindingId: 'binding-1' }
  const h = harness({ route: () => route })
  t.after(() => h.manager.close())
  const result = h.manager.approve({ agent: h.agent, toolName: 'fixture' })
  await ready()
  for (const mutate of [
    (e) => {
      e.payload.body.operatorDTO.uid = '456'
    },
    (e) => {
      e.payload.body.operatorDTO.uid = Number.MAX_SAFE_INTEGER + 1
    },
    (e) => {
      e.payload.body.bizInfoDTO.bizId = 'another-card'
    },
    (e) => {
      e.type = 'user_im_message_receive_o2o_all'
    },
    (e) => {
      delete e.payload.body.operatorDTO
      e.payload.body.actionData.context.createUid = '123'
    },
  ]) {
    const callback = event(h.sent[0], 'approve_once')
    mutate(callback)
    assert.equal(h.manager.handleEvent('account-1', callback), false)
  }
  route = { ...route, bindingId: 'binding-2' }
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'approve_once')), false)
  h.manager.close()
  assert.equal(await result, 'cancelled')
})

test('ask 拒绝未知问题、未知选项、单选多值和非文本输入，不能误走批准分支', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const result = h.manager.ask(h.agent.id, {
    questions: [{ id: 'q', question: '选择', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await ready()
  for (const answers of [
    {},
    { q0: { selected: ['option_99'], custom: '' } },
    { q0: { selected: ['option_0', 'option_1'], custom: '' } },
    { q0: { selected: ['option_0', 'option_0'], custom: '' } },
    { q0: { selected: [], custom: {} } },
    { q0: { selected: [], custom: '' }, extra: {} },
    { q0: { selected: [], custom: '', execute: 'arbitrary-tool' } },
  ])
    assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'submit', { answers })), false)
  assert.equal(
    h.manager.handleEvent('account-1', event(h.sent[0], 'submit', { answers: { q0: { selected: [], custom: '' } } })),
    true,
  )
  assert.deepEqual(await result, { answers: [{ id: 'q', selected: [] }] })
})

test('相同会话的并发交互使用独立 ID，不交叉恢复', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const a = h.manager.approve({ agent: h.agent, toolName: 'first' })
  const b = h.manager.approve({ agent: h.agent, toolName: 'second' })
  await ready()
  assert.notEqual(h.sent[0].interactionId, h.sent[1].interactionId)
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[1], 'reject')), true)
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'approve_once')), true)
  assert.deepEqual(await Promise.all([a, b]), ['allowed-once', 'rejected'])
})

test('超时、AbortSignal、关闭和解绑 Agent 均结束等待并拒绝晚到回调', async (t) => {
  for (const mode of ['timeout', 'abort', 'close', 'dispose']) {
    await t.test(mode, async () => {
      const h = harness({ timeoutMs: mode === 'timeout' ? 20 : 1_000 })
      const controller = new AbortController()
      const result = h.manager.approve({ agent: h.agent, toolName: 'fixture', signal: controller.signal })
      await ready()
      if (mode === 'abort') controller.abort()
      if (mode === 'close') h.manager.close()
      if (mode === 'dispose') h.dispose()
      assert.equal(await result, mode === 'timeout' ? 'unavailable' : 'cancelled')
      assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'approve_once')), false)
      h.manager.close()
    })
  }
})

test('ask 取消返回 AbortError，不把取消当答案或授权', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const result = h.manager.ask(h.agent.id, { questions: [{ id: 'q', question: '说明' }] })
  const rejected = assert.rejects(result, { name: 'AbortError' })
  await ready()
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'cancel')), true)
  await rejected
})

test('发送失败不重试、不自动退回别的审批渠道', async (t) => {
  let attempts = 0
  const h = harness({
    transport: {
      create: async () => {
        attempts++
        throw new Error('private-response')
      },
      update: async () => {},
    },
  })
  t.after(() => h.manager.close())
  assert.equal(await h.manager.approve({ agent: h.agent, toolName: 'fixture' }), 'unavailable')
  assert.equal(attempts, 1)
})

test('取消发生在发卡返回之前：原请求立即结束，晚返回卡片仍收口', async () => {
  let deliver
  let updates = 0
  const h = harness({
    transport: {
      create: () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
      update: async () => {
        updates++
      },
    },
  })
  const result = h.manager.approve({ agent: h.agent, toolName: 'fixture' })
  await ready()
  h.manager.close()
  assert.equal(await result, 'cancelled')
  deliver({ bizId: 'late-biz', surfaceId: 'late-surface' })
  await ready()
  assert.equal(updates, 1)
})

test('卡片更新失败不重新执行，日志不输出传输错误中的私有信息', async (t) => {
  const logs = []
  let input
  const h = harness({
    log: (line) => logs.push(line),
    transport: {
      create: async (value) => {
        input = value
        return { bizId: 'biz', surfaceId: 'surface' }
      },
      update: async () => {
        throw new Error('private-response')
      },
    },
  })
  t.after(() => h.manager.close())
  const result = h.manager.approve({ agent: h.agent, toolName: 'fixture' })
  await ready()
  assert.equal(h.manager.handleEvent('account-1', event({ ...input, bizId: 'biz' }, 'approve_once')), true)
  assert.equal(await result, 'allowed-once')
  await ready()
  assert.deepEqual(logs, ['a2ui_terminal_update_failed'])
})

test('未知授权身份、预先取消和关闭后的请求不发卡', async () => {
  const h = harness({ route: () => undefined })
  assert.equal(await h.manager.approve({ agent: h.agent, toolName: 'fixture' }), 'unavailable')
  h.manager.close()
  assert.equal(await h.manager.approve({ agent: h.agent, toolName: 'fixture' }), 'cancelled')
  assert.equal(h.sent.length, 0)
  const other = harness()
  assert.equal(
    await other.manager.approve({ agent: other.agent, toolName: 'fixture', signal: AbortSignal.abort() }),
    'cancelled',
  )
  assert.equal(other.sent.length, 0)
  other.manager.close()
})

test('不接管其他 Agent；重复安装幂等，关闭移除原生监听', async () => {
  const h = harness()
  assert.equal(h.manager.install(h.ctx), h.dispose)
  assert.equal(
    await h.listeners.get('approval/request')(
      { agent: { id: 'web-session' }, toolName: 'fixture' },
      async () => 'next',
    ),
    'next',
  )
  h.manager.close()
  assert.equal(h.listeners.size, 0)
})

test('旧卸载函数重复调用不能取消重新安装后的请求', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  h.dispose()
  h.manager.install(h.ctx)
  const result = h.manager.approve({ agent: h.agent, toolName: 'fixture' })
  await ready()
  h.dispose()
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'approve_once')), true)
  assert.equal(await result, 'allowed-once')
})

test('真实 Cordis waterfall 中 A2UI 审批优先于 Web 处理器且仅恢复自己的 Agent', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const ctx = new Context()
  let intercepted = 0
  ctx.on('approval/request', async () => {
    intercepted++
    return 'rejected'
  })
  let agent
  const scoped = ctx.extend({
    get agent() {
      return agent
    },
  })
  agent = { id: 'native-agent', ctx: scoped }
  h.manager.install(scoped)
  const result = ctx.waterfall(agent, 'approval/request', { agent, toolName: 'fixture' }, async () => 'unavailable')
  await ready()
  assert.equal(intercepted, 0)
  assert.equal(h.manager.handleEvent('account-1', event(h.sent[0], 'approve_once')), true)
  assert.equal(await result, 'allowed-once')
  const webAgent = { id: 'web-only' }
  assert.equal(
    await ctx.waterfall(
      webAgent,
      'approval/request',
      { agent: webAgent, toolName: 'fixture' },
      async () => 'unavailable',
    ),
    'rejected',
  )
  assert.equal(intercepted, 1)
})

test('真实 Cordis waterfall 中原生 ask 不被先注册的 Web 回答器截走', async (t) => {
  const h = harness()
  t.after(() => h.manager.close())
  const ctx = new Context()
  ctx.on('user-questions/request', async () => ({ answers: [{ id: 'wrong', selected: [] }] }))
  let agent
  const scoped = ctx.extend({
    get agent() {
      return agent
    },
  })
  agent = { id: 'native-question-agent', ctx: scoped }
  h.manager.install(scoped)
  const result = ctx.waterfall(
    agent,
    'user-questions/request',
    {
      agent,
      questions: [{ id: 'q', question: '说明' }],
    },
    async () => ({ answers: [] }),
  )
  await ready()
  assert.equal(h.sent.length, 1)
  assert.equal(
    h.manager.handleEvent(
      'account-1',
      event(h.sent[0], 'submit', {
        answers: { q0: { selected: [], custom: '原生答案' } },
      }),
    ),
    true,
  )
  assert.deepEqual(await result, { answers: [{ id: 'q', selected: [], custom: '原生答案' }] })
})
