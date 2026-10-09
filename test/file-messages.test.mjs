import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { startStream } from '../lib/stream.js'
import { Outbound } from '../lib/outbound.js'

test('取消媒体发送也取消凭据请求，避免卸载等待悬空 Token 获取', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let observedSignal
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      observedSignal = init.signal
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  const controller = new AbortController()
  const outbound = new Outbound({ clientId: 'fixture', clientSecret: 'fixture' }, () => {})
  const pending = outbound.sendMedia(
    { conversationType: 'direct', conversationId: 'chat', senderStaffId: 'user' },
    { kind: 'file', name: 'file.pdf', data: new Uint8Array([1]) },
    controller.signal,
  )
  const rejected = assert.rejects(pending, /media_upload_failed/)
  controller.abort()
  await rejected
  assert.equal(observedSignal.aborted, true)
})

test('Stream 接受对象/JSON 文件消息，去重且不把群文件或缺失下载码交给模型', async (t) => {
  let callback
  class Client {
    socket = Object.assign(new EventEmitter(), { readyState: 1, ping() {} })
    registerCallbackListener(topic, fn) {
      if (topic === '/robot') callback = fn
    }
    async connect() {}
    async disconnect() {}
    socketCallBackResponse() {}
  }
  mock.module('dingtalk-stream', {
    namedExports: { DWClient: Client, TOPIC_ROBOT: '/robot', TOPIC_CARD: '/card' },
  })
  t.after(() => mock.restoreAll())
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-file-stream-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const messages = [],
    unsupported = [],
    logs = []
  const stop = await startStream({
    clientId: 'fixture',
    clientSecret: 'fixture',
    seenFile: path.join(root, 'seen.json'),
    log: (line) => logs.push(line),
    onMessage: (msg) => messages.push(msg),
    onUnsupported: (type) => unsupported.push(type),
  })
  t.after(stop)
  const send = (id, content, conversationType = '1') =>
    callback({
      headers: { messageId: id },
      data: {
        msgId: id,
        msgtype: 'file',
        content,
        conversationType,
        conversationId: 'chat',
        senderStaffId: 'user',
        createAt: id,
        sessionWebhook: 'https://fixture.invalid/reply',
      },
    })
  await send('1', { downloadCode: 'private-file-code', fileName: '报告.pdf' })
  await send('1', { downloadCode: 'private-file-code', fileName: '报告.pdf' })
  await send('2', JSON.stringify({ downloadCode: 'code-2', fileName: '表格.xlsx' }))
  await send('3', { fileName: 'private-name.pdf' })
  await send('4', { downloadCode: 'code-4', fileName: '群文件.pdf' }, '2')
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0].contentParts, [
    { type: 'file', downloadCode: 'private-file-code', fileName: '报告.pdf' },
  ])
  assert.deepEqual(messages[1].contentParts, [{ type: 'file', downloadCode: 'code-2', fileName: '表格.xlsx' }])
  assert.deepEqual(unsupported, ['file', 'file'])
  assert.doesNotMatch(logs.join('\n'), /private-file-code|private-name/)
})

for (const kind of ['file', 'image']) {
  for (const conversationType of ['direct', 'group']) {
    test(`Outbound 上传并回发 ${kind} 到原 ${conversationType}，使用官方模板参数`, async (t) => {
      const requests = []
      const original = globalThis.fetch
      t.after(() => {
        globalThis.fetch = original
      })
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).includes('oauth2/accessToken')) return Response.json({ accessToken: 'fixture-token' })
        if (String(url).includes('/media/upload')) return Response.json({ errcode: 0, media_id: 'fixture-media' })
        return Response.json({ processQueryKey: 'fixture-receipt' })
      }
      const outbound = new Outbound({ clientId: 'fixture-robot', clientSecret: 'fixture-secret' }, () => {})
      const target = { conversationType, conversationId: 'fixture-chat', senderStaffId: 'fixture-user' }
      const result = await outbound.sendMedia(target, {
        kind,
        name: kind === 'file' ? '报告.pdf' : '图.png',
        data: new Uint8Array([1, 2]),
      })
      const upload = requests[1]
      assert.ok(upload.init.body instanceof FormData)
      assert.equal(upload.init.body.get('type'), kind)
      assert.equal(upload.init.body.get('media').name, kind === 'file' ? '报告.pdf' : '图.png')
      const sent = requests[2]
      assert.equal(
        sent.url,
        `https://api.dingtalk.com/v1.0/robot/${conversationType === 'direct' ? 'oToMessages/batchSend' : 'groupMessages/send'}`,
      )
      const body = JSON.parse(sent.init.body)
      assert.equal(body.robotCode, 'fixture-robot')
      assert.equal(body.msgKey, kind === 'file' ? 'sampleFile' : 'sampleImageMsg')
      assert.deepEqual(
        JSON.parse(body.msgParam),
        kind === 'file'
          ? { mediaId: 'fixture-media', fileName: '报告.pdf', fileType: 'pdf' }
          : { photoURL: 'fixture-media' },
      )
      if (conversationType === 'direct') assert.deepEqual(body.userIds, ['fixture-user'])
      else assert.equal(body.openConversationId, 'fixture-chat')
      assert.deepEqual(result, { status: 'accepted', processQueryKey: 'fixture-receipt' })
    })
  }
}

test('上传业务错误、发送业务错误和超时均不误报送达，也不自动重发', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  for (const failure of ['upload', 'send', 'timeout']) {
    let uploads = 0,
      sends = 0
    const logs = []
    globalThis.fetch = async (url) => {
      if (String(url).includes('oauth2')) return Response.json({ accessToken: 'private-token' })
      if (String(url).includes('/media/upload')) {
        uploads++
        return Response.json(
          failure === 'upload'
            ? { errcode: 40004, errmsg: 'private-error' }
            : { errcode: 0, media_id: 'private-media' },
        )
      }
      sends++
      if (failure === 'timeout') throw new Error('private-url?token=private-token')
      return Response.json({ code: 'invalidParameter', message: 'private-message' }, { status: 400 })
    }
    const outbound = new Outbound({ clientId: 'fixture', clientSecret: 'fixture' }, (line) => logs.push(line))
    await assert.rejects(
      outbound.sendMedia(
        { conversationType: 'direct', conversationId: 'chat', senderStaffId: 'user' },
        { kind: 'file', name: 'file.pdf', data: new Uint8Array([1]) },
      ),
      /media_(upload_failed|send_unconfirmed)/,
    )
    assert.equal(uploads, 1)
    assert.equal(sends, failure === 'upload' ? 0 : 1)
    assert.doesNotMatch(logs.join('\n'), /private-/)
  }
})
