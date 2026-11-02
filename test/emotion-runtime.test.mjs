import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const sources = []
// 只替换入站传输和模型执行，验证公开 apply 到真实表情请求与定稿撤回的链路。
mock.module('../lib/inbound-source.js', {
  namedExports: {
    RobotStreamSource: class {
      constructor(options) {
        sources.push(options)
      }
      async start() {}
      stop() {}
    },
  },
})
mock.module('../lib/digital-employee-control.js', {
  namedExports: {
    serveEmployeeControl: async () => ({ async close() {} }),
  },
})
mock.module('../lib/bridge.js', {
  namedExports: {
    Bridge: class {
      constructor(_agents, renderer) {
        this.renderer = renderer
      }
      async process(msg, scopeKey) {
        const settled = this.renderer.onInbound(scopeKey, msg)
        const session = { id: scopeKey }
        this.renderer.onSessionEvent(session, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '任务完成' }] } },
        })
        this.renderer.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        await settled
      }
    },
  },
})
const { apply, Config } = await import('../lib/index.js')

for (const enabled of [true, false]) {
  test(
    `公开 apply：自定义表情在多个机器人账号${enabled ? '添加并撤回' : '关闭时不发送'}`,
    { timeout: 5000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-emotion-runtime-'))
      const previous = process.env.DSH_DINGTALK_STATE_DIR
      process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'state')
      const lifecycle = new Context()
      t.after(async () => {
        await lifecycle.fiber.dispose()
        if (previous === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
        else process.env.DSH_DINGTALK_STATE_DIR = previous
        await rm(root, { recursive: true, force: true })
      })
      const requests = []
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) })
        if (String(url).includes('/oauth2/')) return Response.json({ accessToken: 'fixture-token', expireIn: 7200 })
        return new Response(null, { status: 200 })
      })
      const workspace = { path: root, sessionIds: [], async attachSession() {} }
      const ctx = {
        effect: (...args) => lifecycle.effect(...args),
        on: (...args) => lifecycle.on(...args),
        credentials: { async resolve() {} },
        agents: {},
        agentDefaultModel: { currentSelection: () => undefined },
        get(name) {
          if (name === 'workspaceRegistry') return { resolveByPath: async () => workspace }
          if (name === 'sessionPersistence') return { list: async () => [] }
          return undefined
        },
      }
      sources.length = 0
      await apply(
        ctx,
        Config({
          accounts: ['first', 'second'].map((id) => ({
            id,
            clientId: id,
            clientSecret: 'fixture-secret',
            ownerStaffId: 'owner',
          })),
          workspace: root,
          replyMode: { direct: 'markdown', group: 'markdown' },
          tools: { enabled: false },
          emotionFirstResponse: enabled,
          emotionFirstResponseText: '🔍正在查代码',
        }),
      )
      assert.equal(sources.length, 2)
      for (const source of sources) {
        await source.onMessage({
          msgId: `message-${source.clientId}`,
          conversationId: `chat-${source.clientId}`,
          conversationType: 'direct',
          senderStaffId: 'owner',
          text: '测试任务',
          createAt: '1000',
          sessionWebhook: `https://fixture.invalid/${source.clientId}`,
        })
      }
      while (requests.filter(({ url }) => String(url).startsWith('https://fixture.invalid/')).length < 2) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      const emotions = requests.filter(({ url }) => String(url).includes('/robot/emotion/'))
      assert.equal(emotions.length, enabled ? 4 : 0)
      if (enabled) {
        for (const id of ['first', 'second']) {
          const pair = emotions.filter(({ body }) => body.robotCode === id)
          assert.deepEqual(
            pair.map(({ url }) => String(url).split('/').at(-1)),
            ['reply', 'recall'],
          )
          assert.deepEqual(pair[0].body, pair[1].body)
          assert.equal(pair[0].body.emotionName, '🔍正在查代码')
          assert.equal(pair[0].body.textEmotion.text, '🔍正在查代码')
          assert.equal(pair[0].body.openMsgId, `message-${id}`)
          assert.equal(pair[0].body.openConversationId, `chat-${id}`)
        }
      }
    },
  )
}
