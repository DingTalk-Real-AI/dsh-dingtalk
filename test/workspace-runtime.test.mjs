import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Bridge as RealBridge } from '../lib/bridge.js'
import { strictAgentContext } from './helpers/strict-agent-context.mjs'

const sources = []
class RobotStreamSource {
  constructor(options) {
    this.options = options
    sources.push(this)
  }
  async start() {}
  async stop() {}
}
class DwsDigitalEmployeeSource extends RobotStreamSource {
  replySink = {
    async verifyBinding() {},
    async audit() {},
    async drain() {},
    async reply() {
      return { deliveryStatus: 'delivered' }
    },
  }
  currentStatus() {
    return { state: 'ready' }
  }
}
// 保留真实 Commands、Bridge 和 WorkspaceLinker；仅隔离网络、渲染和控制进程。
mock.module('../lib/bridge.js', {
  namedExports: {
    Bridge: class extends RealBridge {
      constructor(agents, _renderer, bindings, options) {
        super(agents, { onInbound: async () => {} }, bindings, options)
      }
    },
  },
})
mock.module('../lib/inbound-source.js', { namedExports: { RobotStreamSource } })
mock.module('../lib/digital-employee-runtime.js', { namedExports: { DwsDigitalEmployeeSource } })
mock.module('../lib/digital-employee-lease.js', {
  namedExports: {
    EmployeeLease: class {
      async start() {}
      async stop() {}
    },
  },
})
mock.module('../lib/digital-employee-control.js', {
  namedExports: { serveEmployeeControl: async () => ({ async close() {} }) },
})
mock.module('../lib/outbound.js', {
  namedExports: {
    Outbound: class {
      async sendMarkdown() {
        return true
      }
      async sendText() {
        return true
      }
    },
  },
})
const { apply, Config } = await import('../lib/index.js')

async function flushUntil(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail('等待公开运行时完成会话创建和工作区挂接超时')
}

for (const [channel, conversationType] of [
  ['robot', 'direct'],
  ['robot', 'group'],
  ['employee', 'direct'],
  ['employee', 'group'],
]) {
  test(`公开 ${channel} ${conversationType}：/cd 后 cwd 与分组一致，重开/恢复/补装及其他会话互不影响`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ws-runtime-'))
    const cwd = await realpath(root)
    const target = path.join(cwd, 'target')
    const unregistered = path.join(cwd, 'unregistered')
    await Promise.all([mkdir(target), mkdir(unregistered)])
    const previous = process.env.DSH_DINGTALK_STATE_DIR
    process.env.DSH_DINGTALK_STATE_DIR = path.join(cwd, 'state')
    const lifecycle = new Context()
    const scopes = [],
      live = new Map(),
      headers = new Map(),
      followups = []
    const workspaces = new Map()
    const attachmentAttempts = new Set()
    const registerWorkspace = (dir) => {
      const workspace = {
        path: dir,
        sessionIds: [],
        async attachSession(id) {
          try {
            // 与真实宿主一致：cwd 不匹配时拒绝归属，不能由替身掩盖错误。
            assert.equal(await realpath(headers.get(id).cwd), dir)
            if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
          } finally {
            attachmentAttempts.add(id)
          }
        },
      }
      workspaces.set(dir, workspace)
      return workspace
    }
    registerWorkspace(cwd)
    registerWorkspace(target)
    let created = 0,
      resumed = 0
    const prepare = async (id, header, setup) => {
      const scope = strictAgentContext()
      scopes.push(scope)
      const agent = {
        id,
        ctx: scope.ctx,
        status: 'idle',
        followup() {
          followups.push({ id, cwd: header.cwd })
        },
        cancel() {},
        steer() {},
      }
      await setup?.(agent.ctx, agent)
      headers.set(id, header)
      live.set(id, agent)
      return {
        agent,
        async dispose() {
          live.delete(id)
          await scope.dispose()
        },
      }
    }
    const registry = {
      resolveByPath: async (dir) => workspaces.get(await realpath(dir)),
      create: async (dir) => registerWorkspace(await realpath(dir)),
      list: async () => [...workspaces.values()],
    }
    const ctx = {
      effect: (...args) => lifecycle.effect(...args),
      credentials: { async resolve() {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
      agents: {
        get: (id) => live.get(id),
        create(options) {
          created++
          return prepare(options.sessionId, options.meta, options.setup)
        },
        resume(options) {
          resumed++
          return prepare(options.resumeSessionId, headers.get(options.resumeSessionId), options.setup)
        },
      },
      on() {
        return () => {}
      },
      get(name) {
        if (name === 'workspaceRegistry') return registry
        if (name === 'sessionPersistence')
          return { list: async () => [...headers].map(([id, header]) => ({ id, ...header })) }
      },
    }
    t.after(async () => {
      await lifecycle.fiber.dispose()
      for (const scope of scopes) await scope.dispose()
      if (previous === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
      else process.env.DSH_DINGTALK_STATE_DIR = previous
      await rm(root, { recursive: true, force: true })
    })
    sources.length = 0
    await apply(
      ctx,
      Config({
        accounts:
          channel === 'robot'
            ? [
                {
                  id: 'fixture-bot',
                  enabled: true,
                  clientId: 'fixture-client',
                  clientSecret: 'fixture-secret',
                  ownerStaffId: 'fixture-owner',
                  senderAccess: 'all',
                  groupAccess: 'all',
                  sessionScope: 'chat-sender',
                },
              ]
            : [],
        digitalEmployees:
          channel === 'employee'
            ? [
                {
                  agentUuid: 'fixture-employee',
                  enabled: true,
                  name: '测试员工',
                  dwsProfile: 'fixture:fixture',
                  operatorOpenDingTalkId: 'fixture-owner',
                  allowedDirectSenders: [],
                  allowedGroups: [],
                  sessionScope: 'chat-sender',
                  protocolVersion: 1,
                },
              ]
            : [],
        workspace: cwd,
        tools: { enabled: false },
        interactionMode: 'text',
        emotionFirstResponse: false,
        replyMode: { direct: 'text', group: 'text' },
      }),
    )
    assert.equal(sources.length, 1)
    let sequence = 0
    const send = async (text, sender = 'fixture-owner') => {
      const conversationId = conversationType === 'group' ? 'group' : `direct-${sender}`
      const message = {
        msgId: `${channel}-${++sequence}`,
        conversationId,
        conversationType,
        senderStaffId: sender,
        senderNick: '测试用户',
        text,
        createAt: String(sequence),
        sessionWebhook: 'https://fixture.invalid/reply',
      }
      const before = followups.length
      if (channel === 'robot') await sources[0].options.onMessage(message)
      else
        await sources[0].options.onMessage({
          scopeKey: conversationType === 'group' ? `${conversationId}#${sender}` : conversationId,
          message,
          event: {
            eventId: message.msgId,
            conversationId,
            conversationType,
            senderOpenDingTalkId: sender,
            text,
          },
        })
      if (text.startsWith('/')) return
      await flushUntil(() => followups.length > before)
      // 等待实际归属写入；即使归属错误，也应立即进入下方精确断言。
      const turn = followups.at(-1)
      await flushUntil(() => attachmentAttempts.has(turn.id))
      return turn
    }
    const check = (turn, expected) => {
      assert.equal(turn.cwd, expected)
      assert.ok(workspaces.get(expected).sessionIds.includes(turn.id), `会话 ${turn.id} 未归入 ${expected}`)
      for (const [dir, workspace] of workspaces)
        if (dir !== expected) assert.ok(!workspace.sessionIds.includes(turn.id), '会话被归入错误工作区')
    }
    check(await send('初始消息'), cwd)
    await send('/cd 2')
    let current = await send('切换后消息')
    check(current, target)
    check(await send('其他成员消息', 'fixture-other'), cwd)
    for (const command of ['/new', '/model use fixture/other', '/model reset']) {
      await send(command)
      const reopened = await send('重开后消息')
      assert.notEqual(reopened.id, current.id)
      check(reopened, target)
      current = reopened
    }
    live.delete(current.id)
    const restored = await send('恢复后的消息')
    assert.equal(restored.id, current.id)
    assert.equal(resumed, 1)
    check(restored, target)
    const before = created
    check(await send('已加载补装'), target)
    assert.equal(created, before)
    await send(`/cd ${unregistered}`)
    check(await send('未注册目录消息'), unregistered)
    await send('/cd reset')
    check(await send('恢复默认后消息'), cwd)
    check(await send('其他成员仍在默认目录', 'fixture-other'), cwd)
  })
}
