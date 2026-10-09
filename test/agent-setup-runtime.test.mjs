import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Bridge as RealBridge } from '../lib/bridge.js'
import { strictAgentContext } from './helpers/strict-agent-context.mjs'

const bridges = [],
  sources = []
class Bridge extends RealBridge {
  constructor(agents, _renderer, bindings, options) {
    super(agents, { onInbound: async () => {} }, bindings, options)
    bridges.push(this)
  }
}
class RobotStreamSource {
  constructor(options) {
    this.options = options
    sources.push(this)
  }
  async start() {}
  async stop() {}
}
class DwsDigitalEmployeeSource extends RobotStreamSource {
  replySink = { async verifyBinding() {}, async audit() {}, async drain() {} }
  currentStatus() {
    return { state: 'ready' }
  }
}
// 租约属于 DWS 控制协议，此测试仅验证宿主 setup 与交互安装链。
mock.module('../lib/digital-employee-lease.js', {
  namedExports: {
    EmployeeLease: class {
      lost = false
      async start() {}
      async stop() {}
    },
  },
})
mock.module('../lib/bridge.js', { namedExports: { Bridge } })
mock.module('../lib/inbound-source.js', { namedExports: { RobotStreamSource } })
mock.module('../lib/digital-employee-runtime.js', { namedExports: { DwsDigitalEmployeeSource } })
const { apply, Config } = await import('../lib/index.js')

for (const preset of ['success', 'missing', 'resolve-failed']) {
  test(`公开 apply：机器人与数字员工严格 setup，preset ${preset}，创建/恢复/补装/回滚重试`, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-sc-'))
    const previous = process.env.DSH_DINGTALK_STATE_DIR
    process.env.DSH_DINGTALK_STATE_DIR = path.join(dir, 'state')
    const lifecycle = new Context()
    const live = new Map(),
      scopes = [],
      followups = [],
      attempts = []
    let rollback = false,
      mountFails = false,
      mounted = 0
    const makeAgent = (id) => {
      const names = new Set()
      const scope = strictAgentContext((definition) => {
        assert.ok(!names.has(definition.name), `重复注册 ${definition.name}`)
        names.add(definition.name)
        return () => names.delete(definition.name)
      })
      scopes.push({ ...scope, names })
      const agent = {
        id,
        ctx: scope.ctx,
        status: 'idle',
        followup(message) {
          followups.push({ agent, message })
        },
        steer() {},
        cancel() {},
      }
      return { agent, scope }
    }
    const prepare = async (kind, id, setup) => {
      const { agent, scope } = makeAgent(id)
      attempts.push({ kind, agent })
      try {
        await setup?.(agent.ctx, agent)
        if (rollback) {
          rollback = false
          throw new Error('fixture_setup_rollback')
        }
      } catch (error) {
        await scope.dispose()
        throw error
      }
      live.set(id, agent)
      return {
        agent,
        async dispose() {
          if (live.get(id) === agent) live.delete(id)
          await scope.dispose()
        },
      }
    }
    const presets = {
      async resolve() {
        if (preset === 'resolve-failed') throw new Error('fixture_preset_missing')
        return { id: 'fixture-preset' }
      },
      async mount(ctx, id) {
        assert.equal(id, 'fixture-preset')
        mounted++
        ctx.tools.register({ name: 'fixture-preset-tool' })
        if (mountFails) {
          mountFails = false
          throw new Error('fixture_preset_mount_failed')
        }
      },
    }
    const ctx = {
      effect: (...args) => lifecycle.effect(...args),
      credentials: { async resolve() {} },
      agents: {
        get: (id) => live.get(id),
        create: (options) => prepare('create', options.sessionId, options.setup),
        resume: (options) => prepare('resume', options.resumeSessionId, options.setup),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
      on() {
        return () => {}
      },
      get(name) {
        if (name === 'workspaceRegistry')
          return { resolveByPath: async () => ({ path: dir, sessionIds: [], async attachSession() {} }) }
        if (name === 'agentPresets' && preset !== 'missing') return presets
        return undefined
      },
    }
    t.after(async () => {
      await lifecycle.fiber.dispose()
      for (const scope of scopes) await scope.dispose()
      if (previous === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
      else process.env.DSH_DINGTALK_STATE_DIR = previous
      await rm(dir, { recursive: true, force: true })
    })
    bridges.length = sources.length = 0
    const employee = {
      agentUuid: 'fixture-employee',
      enabled: true,
      name: '测试员工',
      dwsProfile: 'fixture:fixture',
      operatorOpenDingTalkId: 'fixture-owner',
      allowedDirectSenders: [],
      allowedGroups: [],
      sessionScope: 'chat',
      protocolVersion: 1,
    }
    await apply(
      ctx,
      Config({
        accounts: [
          {
            id: 'fixture-bot',
            enabled: true,
            clientId: 'fixture-client',
            clientSecret: 'fixture-secret',
            ownerStaffId: 'fixture-owner',
          },
        ],
        digitalEmployees: [employee],
        workspace: dir,
        tools: { enabled: false },
        interactionMode: 'text',
        emotionFirstResponse: false,
        replyMode: { direct: 'text', group: 'text' },
      }),
    )
    assert.equal(bridges.length, 2)
    assert.equal(sources.length, 2)
    for (const [index, source] of sources.entries()) {
      const digital = source instanceof DwsDigitalEmployeeSource
      const channel = digital ? 'employee' : 'robot'
      let sequence = 0
      const send = async (scopeKey) => {
        const message = {
          msgId: `${channel}-${++sequence}`,
          conversationId: scopeKey,
          conversationType: 'direct',
          senderStaffId: 'fixture-owner',
          senderNick: '测试',
          createAt: String(Date.now()),
          text: 'fixture',
          sessionWebhook: 'https://fixture.invalid/reply',
        }
        const before = followups.length
        if (digital)
          await source.options.onMessage({
            scopeKey,
            message,
            event: {
              eventId: message.msgId,
              conversationId: scopeKey,
              conversationType: 'direct',
              senderOpenDingTalkId: 'fixture-owner',
              text: 'fixture',
            },
          })
        else await bridges[index].process(message, scopeKey)
        return followups.slice(before)
      }
      const key = `${channel}-chat`
      const first = (await send(key))[0].agent
      const firstScope = scopes.find((scope) => scope.ctx === first.ctx)
      assert.throws(() => first.ctx.agent, /cannot get property "agent" without inject/)
      assert.equal(firstScope.listeners.get('approval/request').length, digital ? 2 : 1)
      assert.equal(firstScope.listeners.get('user-questions/request').length, digital ? 2 : 1)
      if (!digital) assert.ok(firstScope.names.has('ask_user_question'))
      await send(key)
      assert.equal(firstScope.listeners.get('approval/request').length, digital ? 2 : 1)
      await firstScope.dispose()
      live.delete(first.id)
      const resumed = (await send(key))[0].agent
      assert.equal(resumed.id, first.id)
      assert.notEqual(resumed.ctx, first.ctx)
      assert.equal(attempts.at(-1).kind, 'resume')
      // 模拟 Web 已加载；机器人走补装，员工只借用本 Bridge 已持有的实例。
      const scope = scopes.find((item) => item.ctx === resumed.ctx)
      await scope.dispose()
      const replacement = makeAgent(resumed.id).agent
      if (digital) {
        // 已持有的 Agent 换成未安装的活跃 Context，必须由补装入口接线。
        // 保持 Agent 身份，避免绕过数字员工的独占所有权保护。
        resumed.ctx = replacement.ctx
        const beforeAttempts = attempts.length
        assert.equal((await send(key)).length, 1)
        assert.equal(attempts.length, beforeAttempts)
        assert.equal(scopes.at(-1).listeners.get('approval/request').length, 2)
        assert.equal(scopes.at(-1).listeners.get('user-questions/request').length, 2)
      } else {
        live.set(replacement.id, replacement)
        const beforeAttempts = attempts.length
        await send(key)
        assert.equal(attempts.length, beforeAttempts)
        assert.ok(scopes.at(-1).names.has('ask_user_question'))
      }
      // setup 已安装后回滚；同一持久会话 ID 再恢复仍必须完成安装。
      live.delete(first.id)
      rollback = true
      const beforeAttempts = attempts.length
      assert.equal((await send(key)).length, 1)
      assert.equal(attempts[beforeAttempts].kind, 'resume')
      assert.notEqual(attempts[beforeAttempts].agent.ctx, attempts[beforeAttempts + 1].agent.ctx)
      assert.ok(followups.at(-1).agent)
      if (preset === 'success') {
        live.delete(followups.at(-1).agent.id)
        mountFails = true
        await send(key)
        assert.equal(attempts.at(-2).kind, 'resume')
        assert.equal(attempts.at(-1).kind, 'create')
      }
    }
    assert.equal(mounted > 0, preset === 'success')
  })
}
