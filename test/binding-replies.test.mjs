import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

function config(workspace) {
  return {
    accounts: [{ id: 'default', enabled: true, clientId: 'client-id', clientSecret: 'client-secret' }],
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

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function delivery(messageId, text, sessionWebhook, createAt) {
  return {
    headers: { messageId: `delivery-${messageId}` },
    data: {
      msgId: messageId,
      createAt,
      conversationId: 'direct-1',
      conversationType: '1',
      senderStaffId: 'owner-1',
      text: { content: text },
      sessionWebhook,
    },
  }
}

test('同一私聊按顺序回复格式错误、Unicode 绑定成功和后续状态', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-binding-replies-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previousStateDir = process.env.DSH_DINGTALK_STATE_DIR
  process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'state')
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
    else process.env.DSH_DINGTALK_STATE_DIR = previousStateDir
  })

  let robotListener
  class FakeClient {
    constructor() {
      this.socket = new EventEmitter()
      this.socket.readyState = 1
      this.socket.ping = () => this.socket.emit('pong')
    }
    registerCallbackListener(topic, listener) {
      if (topic === '/robot') robotListener = listener
    }
    async connect() {}
    async disconnect() {}
    socketCallBackResponse() {}
  }
  mock.module('dingtalk-stream', {
    namedExports: {
      DWClient: FakeClient,
      TOPIC_ROBOT: '/robot',
      TOPIC_CARD: '/card',
    },
  })
  t.after(() => mock.restoreAll())

  const deniedReply = deferred()
  const boundReply = deferred()
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return { ok: true, json: async () => ({ accessToken: 'redacted', expireIn: 7200 }) }
    }
    requests.push({ url, body: JSON.parse(init.body) })
    if (url === 'https://reply.test/denied') return deniedReply.promise
    if (url === 'https://reply.test/bound') return boundReply.promise
    return { ok: true }
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { issueBindingChallenge } = await import('../lib/owner.js')
  const challenge = issueBindingChallenge(path.join(root, 'state', 'owner.json'), 60_000)
  const { apply } = await import(`../lib/index.js?binding-replies=${Date.now()}`)
  const dispose = []
  const workspace = { path: root, sessionIds: [], async attachSession() {} }
  const ctx = {
    credentials: { async resolve() {} },
    agents: {},
    agentDefaultModel: { currentSelection: () => undefined },
    get(name) {
      if (name === 'workspaceRegistry') {
        return { resolveByPath: async () => workspace, create: async () => workspace }
      }
      if (name === 'sessionPersistence') return { list: async () => [] }
      return undefined
    },
    on(event, listener) {
      if (event === 'dispose') dispose.push(listener)
    },
  }

  await apply(ctx, config(root))
  t.after(() => dispose.forEach((listener) => listener()))

  await robotListener(delivery('malformed-1', '/bind', 'https://reply.test/malformed', '500'))
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://reply.test/malformed'],
  )
  assert.match(requests[0].body.markdown.text, /绑定指令格式不正确/)
  assert.match(requests[0].body.markdown.text, /\/bind <口令>/)

  const denied = robotListener(delivery('ordinary-1', 'hi', 'https://reply.test/denied', '1000'))
  while (requests.length < 2) await new Promise((resolve) => setImmediate(resolve))

  const binding = robotListener(
    delivery('binding-1', `／ｂｉｎｄ\u200B　${challenge.code}`, 'https://reply.test/bound', '2000'),
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://reply.test/malformed', 'https://reply.test/denied'],
  )

  deniedReply.resolve({ ok: true })
  while (requests.length < 3) await new Promise((resolve) => setImmediate(resolve))

  const status = robotListener(delivery('status-1', '/status', 'https://reply.test/status', '3000'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://reply.test/malformed', 'https://reply.test/denied', 'https://reply.test/bound'],
  )

  boundReply.resolve({ ok: true })
  await Promise.all([denied, binding, status])

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://reply.test/malformed',
      'https://reply.test/denied',
      'https://reply.test/bound',
      'https://reply.test/status',
    ],
  )
  assert.match(requests[1].body.markdown.text, /无需重新运行 setup/)
  assert.match(requests[2].body.markdown.text, /无需重复发送/)
})
