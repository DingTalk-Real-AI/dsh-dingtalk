import assert from 'node:assert/strict'
import test from 'node:test'

import { Bridge } from '../lib/bridge.js'

test('Bridge 创建并持久化会话、注入消息且等待渲染完成', async () => {
  const followups = []
  const bindings = new Map()
  let settle
  const settled = new Promise((resolve) => {
    settle = resolve
  })
  let createdSessionId
  const agent = { id: '', followup: (message) => followups.push(message) }
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('unexpected resume')
    },
    create: async (options) => {
      assert.equal(options.meta.cwd, '/workspace')
      createdSessionId = options.sessionId
      agent.id = options.sessionId
      return { agent }
    },
  }
  const bridge = new Bridge(
    agents,
    { onInbound: () => settled },
    { get: (key) => bindings.get(key), set: (key, value) => bindings.set(key, value) },
    {
      cwd: '/workspace',
      log: () => {},
      modelOverrides: { get: () => undefined },
      workspaceOverrides: { get: () => undefined },
      modelSelection: () => ({ provider: 'test', model: 'latest' }),
      compose: async () => ({}),
      onAgentMessage: () => {},
    },
  )
  const message = {
    msgId: 'msg-1',
    conversationId: 'chat-1',
    conversationType: 'direct',
    senderStaffId: 'owner-1',
    senderNick: 'Owner',
    text: '你好',
    createAt: '1',
    sessionWebhook: 'https://example.invalid/session',
  }

  let completed = false
  const processing = bridge.process(message, 'chat-1').then(() => {
    completed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  assert.equal(bindings.get('chat-1'), createdSessionId)
  assert.equal(followups.length, 1)
  assert.deepEqual(followups[0].content, [{ type: 'text', text: '你好' }])

  settle()
  await processing
  assert.equal(completed, true)
})

test('Bridge 按 richText 原始顺序将全部图片与文字一次性注入模型', async () => {
  const followups = []
  const agent = { id: '', followup: (message) => followups.push(message) }
  const bridge = new Bridge(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('unexpected resume')
      },
      create: async (options) => {
        agent.id = options.sessionId
        return { agent }
      },
    },
    { onInbound: () => Promise.resolve() },
    { get: () => undefined, set: () => {} },
    {
      cwd: '/workspace',
      log: () => {},
      modelOverrides: { get: () => undefined },
      workspaceOverrides: { get: () => undefined },
      modelSelection: () => ({ provider: 'test', model: 'vision' }),
      compose: async () => ({}),
      onAgentMessage: () => {},
      resolveImage: async (downloadCode) => ({
        type: 'image',
        attachment: {
          attachmentId: downloadCode,
          mediaType: 'image/png',
          bytes: 4,
          width: 1,
          height: 1,
        },
      }),
    },
  )

  await bridge.process(
    {
      msgId: 'msg-images',
      conversationId: 'chat-images',
      conversationType: 'direct',
      senderStaffId: 'owner-1',
      senderNick: 'Owner',
      text: '这是啥',
      createAt: '1',
      imageDownloadCodes: ['image-1', 'image-2'],
      contentParts: [
        { type: 'text', text: '第一张' },
        { type: 'image', downloadCode: 'image-1' },
        { type: 'text', text: '第二张' },
        { type: 'image', downloadCode: 'image-2' },
      ],
      sessionWebhook: 'https://example.invalid/session',
    },
    'chat-images',
  )

  assert.deepEqual(followups[0].content, [
    { type: 'text', text: '第一张' },
    {
      type: 'image',
      attachment: {
        attachmentId: 'image-1',
        mediaType: 'image/png',
        bytes: 4,
        width: 1,
        height: 1,
      },
    },
    { type: 'text', text: '第二张' },
    {
      type: 'image',
      attachment: {
        attachmentId: 'image-2',
        mediaType: 'image/png',
        bytes: 4,
        width: 1,
        height: 1,
      },
    },
  ])
})
