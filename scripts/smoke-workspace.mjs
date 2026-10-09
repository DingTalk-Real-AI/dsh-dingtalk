import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Bridge } from '../lib/bridge.js'
import { Commands } from '../lib/commands.js'
import { JsonStore } from '../lib/jsonstore.js'
import { WorkspaceLinker } from '../lib/workspace.js'

const modules = process.env.DSH_SMOKE_NODE_MODULES
if (!modules || !path.isAbsolute(modules)) throw new Error('DSH_SMOKE_NODE_MODULES 必须是隔离安装树的绝对路径')
const hostRequire = createRequire(path.join(modules, '@deepseek-ai/dsh/package.json'))
const load = (name) => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href)
assert.equal(
  JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version,
  '0.2.0-rc.2',
)
const [{ Context }, ...plugins] = await Promise.all(
  [
    'cordis',
    'dsh-agent',
    'dsh-session',
    'dsh-session-projection',
    'dsh-system-prompt',
    'dsh-tools',
    'dsh-agent-loop',
    'dsh-session-persistence-jsonl',
    'dsh-storage',
    'dsh-storage-json',
    'dsh-storage-domain',
    'dsh-workspace',
  ].map(load),
)
const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-smoke-'))
const cwd = await realpath(dir)
const target = path.join(cwd, 'target')
await mkdir(target)
const root = new Context()
const originalFetch = globalThis.fetch
// 不启动钉钉 Channel，也不提供可调用的模型。
globalThis.fetch = () => {
  throw new Error('smoke 禁止访问网络')
}
root.provide('llm', {
  stream() {
    throw new Error('smoke 禁止调用模型')
  },
})
try {
  const configs = [
    undefined,
    undefined,
    undefined,
    {},
    {},
    { agents: [], maxParallelToolCalls: 1 },
    { root: path.join(cwd, 'sessions'), compression: 'none' },
    undefined,
    { root: path.join(cwd, 'storage') },
    { backend: 'json' },
    undefined,
  ]
  for (const [index, plugin] of plugins.entries()) await root.plugin(plugin.default ?? plugin, configs[index])
  const registry = root.workspaceRegistry
  const defaultWorkspace = await registry.create(cwd)
  const targetWorkspace = await registry.create(target)
  const bindings = new JsonStore(path.join(cwd, 'bindings.json'), () => {})
  const modelOverrides = new JsonStore(path.join(cwd, 'models.json'), () => {})
  const workspaceOverrides = new JsonStore(path.join(cwd, 'overrides.json'), () => {})
  const linker = new WorkspaceLinker({
    cwd,
    resolveRegistry: () => registry,
    resolvePersistence: () => ({ list: async () => (await root.sessionPersistence.list()).map((item) => item.header) }),
    log: console.log,
  })
  await linker.start()
  const handles = new Map()
  const bridge = new Bridge(
    {
      get: (id) => root.agents.get(id),
      async create(options) {
        const handle = await root.agents.create({
          ...options,
          setup(_ctx, agent) {
            // 持久化真实会话头和合成事件，但不驱动模型 turn。
            agent.session.append(
              'user/message',
              { id: 'fixture', role: 'user', content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user' } },
              { surfaceOp: 'append' },
            )
          },
        })
        handle.agent.followup = () => {}
        handles.set(handle.agent.id, handle)
        return handle
      },
      async resume(options) {
        const handle = await root.agents.resume(options)
        handle.agent.followup = () => {}
        handles.set(handle.agent.id, handle)
        return handle
      },
    },
    { onInbound: async () => {} },
    bindings,
    {
      cwd,
      modelOverrides,
      workspaceOverrides,
      modelSelection: () => undefined,
      compose: async () => ({}),
      log: console.log,
      onAgentMessage: (agent, _msg, sessionCwd) => linker.attach(agent.id, sessionCwd),
    },
  )
  const commands = new Commands({
    agents: root.agents,
    bindings,
    modelOverrides,
    workspaceOverrides,
    outbound: {
      async sendMarkdown() {
        return true
      },
    },
    queue: { depth: () => 0, clear() {} },
    defaultModel: () => undefined,
    defaultWorkspace: cwd,
    listWorkspaces: async () => registry.list(),
    markdownTitle: 'DSH',
    log: console.log,
  })
  const message = (text) => ({
    msgId: 'fixture',
    conversationId: 'chat',
    conversationType: 'direct',
    senderStaffId: 'fixture',
    senderNick: 'fixture',
    createAt: '1',
    text,
    sessionWebhook: 'https://fixture.invalid',
  })
  const check = (id, workspace) => {
    assert.equal(root.agents.get(id).session.header.cwd, workspace.path)
    assert.ok(workspace.sessionIds.includes(id), '真实 DSH 工作区未收录会话；Web 会将其显示为未分组')
    const other = workspace === targetWorkspace ? defaultWorkspace : targetWorkspace
    assert.ok(!other.sessionIds.includes(id))
  }
  check(await bridge.process(message('默认目录消息'), 'chat'), defaultWorkspace)
  await commands.handle(message('/cd 1'))
  let id = await bridge.process(message('切换后的消息'), 'chat')
  check(id, targetWorkspace)
  for (const command of ['/new', '/model use fixture/other', '/model reset']) {
    await commands.handle(message(command))
    id = await bridge.process(message('重开后的消息'), 'chat')
    check(id, targetWorkspace)
  }
  await handles.get(id).dispose()
  const restored = await bridge.process(message('恢复后的消息'), 'chat')
  assert.equal(restored, id)
  check(restored, targetWorkspace)
  check(await bridge.process(message('已加载的消息'), 'chat'), targetWorkspace)
  await commands.handle(message('/cd reset'))
  check(await bridge.process(message('恢复默认'), 'chat'), defaultWorkspace)
  await bridge.close()
  console.log('PASS DSH 0.2.0-rc.2：真实工作区显式归属，/cd、/new、/model、恢复、已加载和 reset；无钉钉消息和模型调用')
} finally {
  await root.fiber.dispose()
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
}
