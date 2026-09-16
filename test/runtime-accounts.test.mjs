import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

function config(workspace) {
  return {
    accounts: [
      { id: 'broken-bot', enabled: true, clientId: 'broken', clientSecret: 'secret' },
      { id: 'healthy-bot', enabled: true, clientId: 'healthy', clientSecret: 'secret' },
    ],
    clientId: '',
    clientSecret: '',
    workspace,
    markdownTitle: 'DSH',
    interactionCardTemplateId: '',
    ownerStaffId: '',
    allowedSenders: [],
    groupAllowlist: [],
    replyMode: { direct: 'aicard', group: 'aicard' },
    streaming: { enabled: true, throttleMs: 500, maxCardChars: 15_000 },
    asyncMode: false,
    ackText: '',
    queueAckText: '',
    questionTimeoutMs: 300_000,
    approvalTimeoutMs: 300_000,
    tools: { enabled: false },
    sessionScope: 'chat',
    imageMode: 'auto',
    emotionFirstResponse: false,
    rejectNotice: true,
    debug: false,
  }
}

test('插件公开 apply 边界隔离多账号 Stream，单账号失败不影响其他账号', async (t) => {
  // 短路径保证 macOS 也真正启动 Unix socket，避免路径上限掩盖宿主清理遗漏。
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ra-'))
  const lifecycle = new Context()
  const closeHost = () => lifecycle.fiber.dispose()
  const previousStateDir = process.env.DSH_DINGTALK_STATE_DIR
  process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'state')
  t.after(async () => {
    await closeHost()
    if (previousStateDir === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
    else process.env.DSH_DINGTALK_STATE_DIR = previousStateDir
    await import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true }))
  })

  const connected = []
  const disconnected = []
  class FakeClient {
    constructor(options) {
      this.options = options
      this.socket = new EventEmitter()
      this.socket.readyState = 1
      this.socket.ping = () => this.socket.emit('pong')
    }
    registerCallbackListener() {}
    async connect() {
      if (this.options.clientId === 'broken') throw new Error('simulated connection failure')
      connected.push(this.options.clientId)
    }
    async disconnect() {
      disconnected.push(this.options.clientId)
    }
  }
  mock.module('dingtalk-stream', {
    namedExports: {
      DWClient: FakeClient,
      TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
      TOPIC_CARD: '/v1.0/card/instances/callback',
    },
  })
  t.after(() => mock.restoreAll())
  const { apply } = await import(`../lib/index.js?runtime-accounts=${Date.now()}`)

  const workspace = {
    path: root,
    sessionIds: [],
    async attachSession() {},
  }
  const ctx = {
    provide(name, value) {
      this[name] = value
    },
    effect: (...args) => lifecycle.effect(...args),
    credentials: { async resolve() {} },
    agents: {},
    agentDefaultModel: { currentSelection: () => undefined },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          resolveByPath: async () => workspace,
          create: async () => workspace,
        }
      }
      if (name === 'sessionPersistence') return { list: async () => [] }
      return undefined
    },
    on: (...args) => lifecycle.on(...args),
  }

  await apply(ctx, config(root))

  assert.deepEqual(connected, ['healthy'])
  await closeHost()
  assert.deepEqual(disconnected, ['healthy'])
})
