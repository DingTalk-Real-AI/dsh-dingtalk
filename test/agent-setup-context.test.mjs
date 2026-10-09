import assert from 'node:assert/strict'
import test from 'node:test'
import { QuestionManager } from '../lib/questions.js'
import { A2uiInteractions } from '../lib/a2ui.js'
import { strictAgentContext } from './helpers/strict-agent-context.mjs'

function questions() {
  return new QuestionManager({
    outbound: { sendMarkdown: async () => true },
    markdownTitle: 'DSH',
    timeoutMs: 1000,
    log() {},
  })
}
function a2ui() {
  return new A2uiInteractions({
    source: 'fixture',
    timeoutMs: 1000,
    route: () => undefined,
    transport: {
      create() {
        throw new Error('unexpected delivery')
      },
      async update() {},
    },
  })
}

test('严格 Cordis：问答安装使用显式 Agent，同一 Context 只注册一次', async (t) => {
  let registered = 0
  const scope = strictAgentContext(() => {
    registered++
    return () => {}
  })
  t.after(scope.dispose)
  assert.throws(() => scope.ctx.agent, /cannot get property "agent" without inject/)
  const agent = { id: 'fixture-session', ctx: scope.ctx }
  const manager = questions()
  manager.install(scope.ctx, agent)
  manager.installFor(agent)
  assert.equal(registered, 1)
  assert.equal(scope.listeners.get('user-questions/request').length, 1)
  assert.equal(scope.listeners.get('approval/request').length, 1)
})

test('严格 Cordis：A2UI 支持显式 Agent，缺失 Agent 不探测 Cordis 服务', async (t) => {
  const scope = strictAgentContext()
  t.after(scope.dispose)
  const manager = a2ui()
  t.after(() => manager.close())
  const agent = { id: 'fixture-session', ctx: scope.ctx }
  const off = manager.install(scope.ctx, agent)
  assert.equal(manager.install(scope.ctx, agent), off)
  off()
  assert.throws(() => manager.install(scope.ctx), /a2ui_requires_agent_scope/)
})

test('严格 Cordis：相同会话 ID 的新 Context 在恢复和回滚重试后重新安装', async (t) => {
  const manager = questions()
  for (let attempt = 0; attempt < 3; attempt++) {
    let registrations = 0
    const scope = strictAgentContext(() => {
      registrations++
      return () => {}
    })
    t.after(scope.dispose)
    const agent = { id: 'same-session', ctx: scope.ctx }
    manager.install(scope.ctx, agent)
    manager.installFor({ ...agent })
    assert.equal(registrations, 1)
    await scope.dispose()
  }
})

test('严格 Cordis：部分安装失败清理工具和监听器，相同 Context 也可重试', async (t) => {
  const names = new Set()
  const scope = strictAgentContext((definition) => {
    assert.ok(!names.has(definition.name))
    names.add(definition.name)
    return () => names.delete(definition.name)
  })
  t.after(scope.dispose)
  const manager = questions()
  const on = scope.ctx.on.bind(scope.ctx)
  let fail = true
  const ctx = scope.ctx.extend({
    on(name, listener, options) {
      if (name === 'approval/request' && fail) {
        fail = false
        throw new Error('fixture_registration_failed')
      }
      return on(name, listener, options)
    },
  })
  const agent = { id: 'retry-session', ctx }
  assert.throws(() => manager.install(ctx, agent), /fixture_registration_failed/)
  assert.equal(names.size, 0)
  assert.equal(scope.listeners.get('user-questions/request').length, 0)
  manager.installFor(agent)
  manager.installFor(agent)
  assert.equal(names.size, 1)
  assert.equal(scope.listeners.get('user-questions/request').length, 1)
  assert.equal(scope.listeners.get('approval/request').length, 1)
})

test('A2UI 旧自有 Agent 属性兼容，显式 Agent 优先且不会调用旧 getter', async (t) => {
  const manager = a2ui()
  t.after(() => manager.close())
  const scope = strictAgentContext()
  t.after(scope.dispose)
  const agent = { id: 'legacy-session', ctx: scope.ctx }
  const legacy = scope.ctx.extend({ agent })
  const off = manager.install(legacy)
  assert.equal(manager.install(legacy), off)
  off()
  const throwing = scope.ctx.extend({
    get agent() {
      throw new Error('不得读取旧 getter')
    },
  })
  manager.install(throwing, agent)
})

test('旧 A2UI install 调用和显式 Agent 调用保持 TypeScript 兼容', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const compiler = fileURLToPath(import.meta.resolve('typescript/lib/tsc.js'))
  const fixture = fileURLToPath(new URL('./fixtures/a2ui-types.ts', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      fixture,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('严格 Cordis：原生问答、文字审批和 A2UI 监听器不读取 Context.agent', async (t) => {
  const sent = []
  const scope = strictAgentContext()
  t.after(scope.dispose)
  const agent = { id: 'interaction-session', ctx: scope.ctx, cancel() {} }
  const manager = new QuestionManager({
    outbound: {
      async sendMarkdown(_message, _title, text) {
        sent.push(text)
        return true
      },
    },
    markdownTitle: 'DSH',
    timeoutMs: 1000,
    log() {},
  })
  manager.install(scope.ctx, agent)
  const message = {
    msgId: 'fixture',
    conversationId: 'fixture-chat',
    conversationType: 'direct',
    senderStaffId: 'fixture-user',
    sessionWebhook: 'https://fixture.invalid/reply',
    text: 'fixture',
  }
  manager.bindSession(agent.id, message)
  const ask = scope.listeners.get('user-questions/request')[0]({ questions: [{ id: 'q', question: '测试问题' }] }, () =>
    assert.fail('不应降级'),
  )
  assert.equal(manager.handleInbound({ ...message, text: '测试回答' }), true)
  assert.deepEqual(await ask, { answers: [{ id: 'q', selected: [], custom: '测试回答' }] })
  const approve = scope.listeners.get('approval/request')[0]({ agent, toolName: 'fixture' }, () =>
    assert.fail('不应降级'),
  )
  const code = sent.at(-1).match(/`确认 ([A-Z0-9]{6})`/)[1]
  assert.equal(manager.handleInbound({ ...message, text: `确认 ${code}` }), true)
  assert.equal(await approve, 'allowed-once')
  const cards = a2ui()
  t.after(() => cards.close())
  cards.install(scope.ctx, agent)
  assert.equal(
    await scope.listeners.get('approval/request')[0]({ agent, toolName: 'fixture' }, () => assert.fail()),
    'unavailable',
  )
  await assert.rejects(
    scope.listeners.get('user-questions/request')[0]({ questions: [{ id: 'q', question: '测试' }] }, () =>
      assert.fail(),
    ),
    /a2ui_question_unavailable/,
  )
})

test('A2UI 与数字员工文字/卡片安装均在注册失败后回滚，可重试', async (t) => {
  const { DigitalEmployeeApprovalManager } = await import('../lib/digital-employee-renderer.js')
  const { employeeA2ui } = await import('../lib/digital-employee-a2ui.js')
  for (const manager of [
    a2ui(),
    new DigitalEmployeeApprovalManager({}, 'fixture-operator', 1000, () => {}),
    employeeA2ui({ agentUuid: 'fixture', dwsProfile: 'fixture', operatorOpenDingTalkId: 'fixture' }, 1000, () => {}),
  ]) {
    t.after(() => manager.close())
    const scope = strictAgentContext()
    t.after(scope.dispose)
    const on = scope.ctx.on.bind(scope.ctx)
    let count = 0
    const ctx = scope.ctx.extend({
      on(name, listener, options) {
        if (++count === 2) throw new Error('fixture_registration_failed')
        return on(name, listener, options)
      },
    })
    const agent = { id: 'fixture', ctx }
    assert.throws(() => manager.install(ctx, agent), /fixture_registration_failed/)
    for (const listeners of scope.listeners.values()) assert.equal(listeners.length, 0)
    manager.install(ctx, agent)
    manager.install(ctx, agent)
    assert.equal(scope.listeners.get('approval/request').length, 1)
    assert.equal(scope.listeners.get('user-questions/request').length, 1)
  }
})
