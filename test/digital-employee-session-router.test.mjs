import assert from 'node:assert/strict'
import test from 'node:test'
import { Bridge } from '../lib/bridge.js'
import { EmployeeSessionRouter } from '../lib/digital-employee-session-router.js'

function fixture() {
  const bindings = new Map([['chat', 'stored-session']])
  let live,
    resumes = 0,
    follows = 0,
    disposals = 0
  const agents = {
    get: () => live,
    async resume({ setup }) {
      resumes++
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(live, undefined)
      const agent = {
        id: 'stored-session',
        ctx: {},
        followup() {
          follows++
        },
      }
      await setup?.(agent.ctx)
      live = agent
      return {
        agent,
        async dispose() {
          disposals++
          live = undefined
        },
      }
    },
    create() {
      assert.fail('不能新建会话或丢失历史')
    },
  }
  const bridge = new Bridge(agents, { onInbound: async () => {} }, bindings, {
    exclusiveOwnership: true,
    cwd: '/fixture',
    log() {},
    modelOverrides: new Map(),
    workspaceOverrides: new Map(),
    modelSelection() {},
    compose: async () => ({
      setup: async (ctx) => {
        ctx.interactionsInstalled = true
      },
    }),
    onAgentMessage() {},
  })
  const router = new EmployeeSessionRouter()
  router.reserve('employee', bindings)
  const deactivate = router.activate('employee', (id) => bridge.resolveBoundSession(id))
  return {
    bridge,
    router,
    bindings,
    deactivate,
    stats: () => ({ resumes, follows, disposals }),
    web: async (id) => (await router.resolve(id)) ?? agents.get(id),
    send: () => bridge.process({ msgId: 'message', text: 'fixture' }, 'chat'),
  }
}

test('Web 先打开冷会话后钉钉继续同一会话，保留交互安装与拥有者清理', async () => {
  const f = fixture()
  const webAgent = await f.web('stored-session')
  assert.equal(webAgent.ctx.interactionsInstalled, true)
  assert.equal(await f.send(), 'stored-session')
  assert.equal(await f.web('stored-session'), webAgent)
  assert.deepEqual(f.stats(), { resumes: 1, follows: 1, disposals: 0 })
  await f.bridge.close()
  assert.equal(f.stats().disposals, 1)
})

test('Web 和 IM 同时打开只恢复一次，不创建替代会话', async () => {
  const f = fixture()
  await Promise.all([f.web('stored-session'), f.send(), f.web('stored-session')])
  assert.equal(f.stats().resumes, 1)
  assert.equal(f.stats().follows, 1)
  await f.bridge.close()
})

test('停止员工时不降级为 Web 接管；无关会话不被路由', async () => {
  const f = fixture()
  assert.equal(await f.router.resolve('unrelated'), undefined)
  f.deactivate()
  await assert.rejects(f.router.resolve('stored-session'), /employee_session_unavailable/)
  assert.equal(f.stats().resumes, 0)
  await f.bridge.close()
})

test('恢复中关闭会等待恢复结果销毁，不留下孤立 Agent', async () => {
  const f = fixture()
  const opening = f.web('stored-session')
  const rejected = assert.rejects(opening)
  await f.bridge.close()
  await rejected
  assert.equal(f.stats().follows, 0)
  assert.equal(f.stats().disposals, 1)
})

test('重复绑定拒绝，旧实例注销不能清掉新实例，绑定变化实时生效', async () => {
  const f = fixture()
  const replacement = (id) => Promise.resolve({ id, replacement: true })
  f.router.activate('employee', replacement)
  f.deactivate()
  assert.equal((await f.router.resolve('stored-session')).replacement, true)
  f.router.reserve('another', new Map([['other-chat', 'stored-session']]))
  await assert.rejects(f.router.resolve('stored-session'), /employee_session_ambiguous/)
  f.bindings.set('chat', 'new-session')
  assert.equal((await f.router.resolve('new-session')).replacement, true)
  await f.bridge.close()
})
