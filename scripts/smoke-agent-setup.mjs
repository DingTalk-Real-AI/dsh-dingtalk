import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { QuestionManager } from '../lib/questions.js'
import { A2uiInteractions } from '../lib/a2ui.js'
import { DigitalEmployeeApprovalManager } from '../lib/digital-employee-renderer.js'
import { employeeA2ui } from '../lib/digital-employee-a2ui.js'
import { FileTransfer } from '../lib/file-transfer.js'

// 先在独立目录安装 @deepseek-ai/dsh@0.2.0-rc.2，再传入该目录的 node_modules。
const modules = process.env.DSH_SMOKE_NODE_MODULES
if (!modules || !path.isAbsolute(modules)) throw new Error('DSH_SMOKE_NODE_MODULES 必须是隔离安装树的绝对路径')
// 从 DSH 包自身解析依赖，同时支持本地 hoist 和 npm 全局安装的嵌套依赖树。
const hostRequire = createRequire(path.join(modules, '@deepseek-ai/dsh/package.json'))
const load = (name) => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href)
const dsh = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'))
assert.equal(dsh.version, '0.2.0-rc.2')
const [
  { Context },
  { default: Agents },
  { default: Sessions },
  { default: Projections },
  { default: Prompt },
  { default: Tools },
  { default: Loop },
  { default: Persistence },
] = await Promise.all(
  [
    'cordis',
    'dsh-agent',
    'dsh-session',
    'dsh-session-projection',
    'dsh-system-prompt',
    'dsh-tools',
    'dsh-agent-loop',
    'dsh-session-persistence-jsonl',
  ].map(load),
)
const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-as-'))
const root = new Context()
// 不启动 Channel、不发送钉钉消息、不提供模型实现；意外访问网络直接失败。
const originalFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('smoke 禁止访问网络')
}
root.provide('llm', {
  stream() {
    throw new Error('smoke 禁止调用模型')
  },
})
try {
  for (const [plugin, config] of [
    [Agents],
    [Sessions],
    [Projections],
    [Prompt, {}],
    [Tools, {}],
    [Persistence, { root: path.join(dir, 'sessions'), compression: 'none' }],
    [Loop, { agents: [], maxParallelToolCalls: 1 }],
  ]) {
    const fiber = root.plugin(plugin, config)
    await fiber
  }
  const questions = new QuestionManager({
    outbound: {
      sendMarkdown() {
        throw new Error('unexpected DingTalk message')
      },
    },
    markdownTitle: 'DSH',
    timeoutMs: 1000,
    log() {},
  })
  const cards = new A2uiInteractions({
    source: 'fixture',
    timeoutMs: 1000,
    route: () => undefined,
    transport: {
      create() {
        throw new Error('unexpected DingTalk card')
      },
      async update() {},
    },
  })
  const text = new DigitalEmployeeApprovalManager({}, 'fixture-operator', 1000, () => {})
  const employee = employeeA2ui(
    { agentUuid: 'fixture', dwsProfile: 'fixture', operatorOpenDingTalkId: 'fixture' },
    1000,
    () => {},
  )
  let setups = 0
  const files = new FileTransfer({
    accountId: 'fixture',
    outbound: {
      async sendMedia() {
        throw new Error('unexpected DingTalk media')
      },
    },
    log() {},
  })
  const contexts = []
  const setup = (ctx, agent) => {
    setups++
    contexts.push(ctx)
    assert.equal(ctx, agent.ctx)
    assert.equal(ctx.get('agent'), undefined)
    assert.throws(() => ctx.agent, /cannot get property "agent" without inject/)
    questions.install(ctx, agent)
    questions.installFor(agent)
    files.install(ctx, agent)
    files.install(ctx, agent)
    cards.install(ctx, agent)
    text.install(ctx, agent)
    employee.install(ctx, agent)
    // 相同作用域再安装不会产生同名工具冲突。
    questions.install(ctx, { ...agent })
    text.install(ctx, agent)
    employee.install(ctx, agent)
  }
  let handle = await root.agents.create({
    sessionId: 'fixture-create',
    meta: { cwd: dir },
    setup(ctx, agent) {
      setup(ctx, agent)
      // 持久化一条合成事件供 resume 使用；不驱动 Agent，不调用模型。
      agent.session.append(
        'user/message',
        { id: 'fixture-message', role: 'user', content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user' } },
        { surfaceOp: 'append' },
      )
    },
  })
  assert.equal(root.agents.get(handle.agent.id), handle.agent)
  await handle.dispose()
  handle = await root.agents.resume({ resumeSessionId: 'fixture-create', setup })
  assert.notEqual(contexts[0], contexts[1])
  await handle.dispose()
  await assert.rejects(
    root.agents.create({
      sessionId: 'fixture-retry',
      meta: { cwd: dir },
      setup(ctx, agent) {
        setup(ctx, agent)
        throw new Error('fixture setup rollback')
      },
    }),
    /fixture setup rollback/,
  )
  assert.equal(root.agents.get('fixture-retry'), undefined)
  handle = await root.agents.create({ sessionId: 'fixture-retry', meta: { cwd: dir }, setup })
  assert.notEqual(contexts[2], contexts[3])
  await handle.dispose()
  const loaded = await root.agents.create({ sessionId: 'fixture-loaded', meta: { cwd: dir } })
  questions.installFor(loaded.agent)
  questions.installFor(loaded.agent)
  files.install(loaded.agent.ctx, loaded.agent)
  files.install(loaded.agent.ctx, loaded.agent)
  cards.install(loaded.agent.ctx, loaded.agent)
  text.install(loaded.agent.ctx, loaded.agent)
  employee.install(loaded.agent.ctx, loaded.agent)
  await loaded.dispose()
  assert.equal(setups, 4)
  cards.close()
  text.close()
  employee.close()
  await files.close()
  console.log('PASS DSH 0.2.0-rc.2：创建、恢复、补装、重复安装、setup 回滚后重试；无钉钉消息和模型调用')
} finally {
  globalThis.fetch = originalFetch
  await root.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
}
