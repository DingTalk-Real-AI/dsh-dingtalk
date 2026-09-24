import assert from 'node:assert/strict'
import test from 'node:test'

import { Bridge } from '../lib/bridge.js'

async function bridgeWithOwnedHandle(handle) {
  const bridge = new Bridge(
    { get: () => undefined, create: async () => handle },
    { onInbound: async () => {} },
    { get: () => undefined, set: () => {} },
    {
      exclusiveOwnership: true,
      cwd: '/workspace',
      log: () => {},
      modelOverrides: { get: () => undefined },
      workspaceOverrides: { get: () => undefined },
      modelSelection: () => undefined,
      compose: async () => ({}),
      onAgentMessage: () => {},
    },
  )
  await bridge.process({ msgId: 'fixture-message', conversationId: 'fixture-chat', text: 'fixture' }, 'fixture-chat')
  return bridge
}

test('宿主先释放 inbox 后，Bridge 仍等待所属 handle 的幂等关闭，不重复 cancel', async () => {
  let disposals = 0
  const agent = {
    id: 'fixture-session',
    followup() {},
    cancel() {
      throw new Error('cannot read inbox state: its projection registration is not active')
    },
  }
  const bridge = await bridgeWithOwnedHandle({
    agent,
    dispose: async () => {
      disposals++
    },
  })
  assert.deepEqual(await bridge.close(), ['fixture-session'])
  assert.equal(disposals, 1)
})

test('Bridge 关闭等待 handle 完成，不能把未完成或失败的销毁视为释放', async () => {
  let finish
  const closing = new Promise((resolve) => {
    finish = resolve
  })
  const agent = { id: 'fixture-session', followup() {}, cancel() {} }
  const bridge = await bridgeWithOwnedHandle({ agent, dispose: () => closing })
  let completed = false
  const result = bridge.close().then(() => {
    completed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  finish()
  await result
  assert.equal(completed, true)

  const failing = await bridgeWithOwnedHandle({
    agent,
    dispose: async () => {
      throw new Error('release_unconfirmed')
    },
  })
  await assert.rejects(failing.close(), /release_unconfirmed/)
})

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
