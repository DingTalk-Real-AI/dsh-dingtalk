import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('图片接收在 Auto 模式下覆盖拒绝提示与下载、存储、注入成功链路', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-image-intake-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
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

  const reply = deferred()
  const requests = []
  const downloadRequests = []
  const savedImages = []
  const followups = []
  let modelModalities = ['text']
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return { ok: true, json: async () => ({ accessToken: 'redacted', expireIn: 7200 }) }
    }
    if (url === 'https://api.dingtalk.com/v1.0/robot/messageFiles/download') {
      downloadRequests.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ downloadUrl: 'https://media.test/image.png' }) }
    }
    if (url === 'https://media.test/image.png') {
      const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => data.buffer,
      }
    }
    requests.push({ url, body: JSON.parse(init.body) })
    return reply.promise
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { apply, inject } = await import(`../lib/index.js?image-intake=${Date.now()}`)
  const runtimeLogs = []
  mock.method(console, 'log', (...args) => runtimeLogs.push(args.join(' ')))
  const dispose = []
  let sessionEvent
  const workspace = { path: root, sessionIds: [], async attachSession() {} }
  const agentContext = {
    agent: undefined,
    tools: { register() {} },
    on() {},
  }
  const agent = {
    id: '',
    status: 'idle',
    ctx: agentContext,
    followup(message) {
      followups.push(message)
      queueMicrotask(() =>
        sessionEvent({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }),
      )
    },
  }
  const ctx = {
    credentials: { async resolve() {} },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      resume: async () => {
        throw new Error('unexpected resume')
      },
      create: async (options) => {
        agent.id = options.sessionId
        agentContext.agent = agent
        await options.setup?.(agentContext)
        return { agent }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'custom', model: 'text-only' }) },
    get(name) {
      if (name === 'workspaceRegistry') {
        return { resolveByPath: async () => workspace, create: async () => workspace }
      }
      if (name === 'sessionPersistence') return { list: async () => [] }
      if (name === 'attachments') {
        return {
          async saveImage(image) {
            savedImages.push(image)
            return {
              attachmentId: 'stored-image-1',
              mediaType: image.mediaType,
              bytes: image.data.length,
              width: 1,
              height: 1,
            }
          },
        }
      }
      return undefined
    },
    on(event, listener) {
      if (event === 'dispose') dispose.push(listener)
      if (event === 'session/event') sessionEvent = listener
    },
  }
  Object.defineProperty(ctx, 'llm', {
    get() {
      if (!inject.includes('llm')) throw new Error('cannot get property "llm" without inject')
      return { resolveModelInfo: async () => ({ inputModalities: modelModalities }) }
    },
  })
  const config = {
    accounts: [
      {
        id: 'default',
        enabled: true,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        ownerStaffId: 'owner-1',
      },
    ],
    clientId: '',
    clientSecret: '',
    workspace: root,
    markdownTitle: 'DSH',
    interactionCardTemplateId: '',
    ownerStaffId: '',
    allowedSenders: [],
    groupAllowlist: [],
    replyMode: { direct: 'markdown', group: 'markdown' },
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

  await apply(ctx, config)
  t.after(() => dispose.forEach((listener) => listener()))

  let completed = false
  const handling = robotListener({
    headers: { messageId: 'delivery-1' },
    data: {
      msgId: 'message-1',
      msgtype: 'picture',
      conversationType: '1',
      conversationId: 'direct-1',
      senderStaffId: 'owner-1',
      createAt: '1',
      sessionWebhook: 'https://reply.test/image-rejected',
      content: { downloadCode: 'image-code-1' },
    },
  }).then(() => {
    completed = true
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.doesNotMatch(runtimeLogs.join('\n'), /cannot get property "llm" without inject/)
  assert.equal(requests.length, 1)
  assert.equal(completed, false)
  assert.match(requests[0].body.markdown.text, /input: \[text, image\]/)

  reply.resolve({ ok: true })
  await handling

  modelModalities = ['text', 'image']
  await robotListener({
    headers: { messageId: 'delivery-2' },
    data: {
      msgId: 'message-2',
      msgtype: 'picture',
      conversationType: '1',
      conversationId: 'direct-1',
      senderStaffId: 'owner-1',
      createAt: '2',
      sessionWebhook: 'https://reply.test/image-accepted',
      content: { downloadCode: 'image-code-2' },
    },
  })
  while (followups.length === 0) await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(downloadRequests, [{ downloadCode: 'image-code-2', robotCode: 'client-id' }])
  assert.equal(savedImages.length, 1)
  assert.equal(savedImages[0].mediaType, 'image/png')
  assert.deepEqual(followups[0].content, [
    {
      type: 'image',
      attachment: {
        attachmentId: 'stored-image-1',
        mediaType: 'image/png',
        bytes: 4,
        width: 1,
        height: 1,
      },
    },
  ])

  await robotListener({
    headers: { messageId: 'delivery-3' },
    data: {
      msgId: 'message-3',
      msgtype: 'text',
      conversationType: '1',
      conversationId: 'direct-1',
      senderStaffId: 'owner-1',
      createAt: '3',
      sessionWebhook: 'https://reply.test/text-after-image',
      text: { content: '这是啥' },
    },
  })
  while (followups.length < 2) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(followups[1].content, [{ type: 'text', text: '这是啥' }])
})
