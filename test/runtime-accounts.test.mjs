import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-runtime-accounts-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const previousStateDir = process.env.DSH_DINGTALK_STATE_DIR
  process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'state')
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
    else process.env.DSH_DINGTALK_STATE_DIR = previousStateDir
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

  const dispose = []
  const workspace = {
    path: root,
    sessionIds: [],
    async attachSession() {},
  }
  const ctx = {
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
    on(event, listener) {
      if (event === 'dispose') dispose.push(listener)
    },
  }

  await apply(ctx, config(root))

  assert.deepEqual(connected, ['healthy'])
  assert.equal(dispose.length, 1)
  for (const listener of dispose) listener()
  assert.deepEqual(disconnected, ['healthy'])
})
