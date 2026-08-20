import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

test('Stream 去重状态不会落盘绑定指令明文', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-stream-security-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seenFile = path.join(root, 'seen.json')
  const sensitiveCommand = '/bind never-persist-this-token'
  await writeFile(seenFile, JSON.stringify({ [`ct:direct-1:500:30:${sensitiveCommand}`]: Date.now() }))

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

  const { startStream } = await import(`../lib/stream.js?stream-security=${Date.now()}`)
  const received = []
  const stop = await startStream({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    seenFile,
    log() {},
    onMessage(message) {
      received.push(message.text)
    },
  })
  t.after(stop)

  const delivery = {
    headers: { messageId: 'delivery-1' },
    data: {
      msgId: 'message-1',
      createAt: '1000',
      conversationId: 'direct-1',
      conversationType: '1',
      senderStaffId: 'owner-1',
      text: { content: sensitiveCommand },
      sessionWebhook: 'https://reply.test/session',
    },
  }

  await robotListener(delivery)
  await robotListener({ ...delivery, headers: { messageId: 'delivery-2' } })

  assert.deepEqual(received, [sensitiveCommand])
  assert.equal((await readFile(seenFile, 'utf8')).includes(sensitiveCommand), false)
})
