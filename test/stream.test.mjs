import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { normalizeCardCallback, startStream } from '../lib/stream.js'

test('Stream 将 picture 与 richText 图片标准化后交给连接器', async (t) => {
  let robotCallback
  class FakeClient {
    constructor() {
      this.socket = new EventEmitter()
      this.socket.readyState = 1
      this.socket.ping = () => this.socket.emit('pong')
    }
    registerCallbackListener(topic, callback) {
      if (topic === '/robot') robotCallback = callback
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

  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-richtext-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const messages = []
  const unsupported = []
  const logs = []
  const stop = await startStream({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    seenFile: path.join(root, 'seen.json'),
    log: (line) => logs.push(line),
    onMessage: (message) => messages.push(message),
    onUnsupported: (msgtype) => unsupported.push(msgtype),
  })
  t.after(stop)

  await robotCallback({
    headers: { messageId: 'delivery-1' },
    data: {
      msgId: 'message-1',
      msgtype: 'richText',
      conversationType: '1',
      conversationId: 'conversation-1',
      senderStaffId: 'user-1',
      senderNick: 'Raph',
      createAt: '1',
      sessionWebhook: 'https://example.invalid/session',
      content: {
        richText: [
          { text: '第一张' },
          { downloadCode: 'image-code-1' },
          { text: '第二张' },
          { downloadCode: 'image-code-1b' },
        ],
      },
    },
  })
  await robotCallback({
    headers: { messageId: 'delivery-2' },
    data: {
      msgId: 'message-2',
      msgtype: 'picture',
      conversationType: '1',
      conversationId: 'conversation-1',
      senderStaffId: 'user-1',
      senderNick: 'Raph',
      createAt: '2',
      sessionWebhook: 'https://example.invalid/session',
      content: { downloadCode: 'image-code-2' },
    },
  })
  await robotCallback({
    headers: { messageId: 'delivery-3' },
    data: {
      msgId: 'message-3',
      msgtype: 'richText',
      conversationType: '1',
      conversationId: 'conversation-1',
      senderStaffId: 'user-1',
      senderNick: 'Raph',
      createAt: '1',
      sessionWebhook: 'https://example.invalid/session',
      content: {
        richText: [{ downloadCode: 'image-code-3' }, { text: '同一毫秒的另一条消息' }],
      },
    },
  })
  await robotCallback({
    headers: { messageId: 'delivery-unsupported' },
    data: {
      msgId: 'message-unsupported',
      msgtype: 'image',
      conversationType: '1',
      conversationId: 'private-conversation',
      senderStaffId: 'private-user',
      senderNick: 'private-nick',
      createAt: '4',
      sessionWebhook: 'https://private.invalid/webhook',
      'private-top-secret': 'private-top-secret-value',
      content: {
        downloadCode: ['private-download-code-1', 'private-download-code-2'],
        fileName: 'private-image.png',
        nested: { privateText: 'private-content' },
        'private-content-secret': 'private-content-secret-value',
      },
    },
  })
  await robotCallback({
    headers: { messageId: 'delivery-string-content' },
    data: {
      msgId: 'message-string-content',
      msgtype: 'richText',
      conversationType: '1',
      conversationId: 'private-string-conversation',
      senderStaffId: 'private-string-user',
      senderNick: 'private-string-nick',
      createAt: '5',
      sessionWebhook: 'https://private-string.invalid/webhook',
      content: JSON.stringify({
        richText: { downloadCode: 'private-string-download-code', text: 'private-string-content' },
        extra: 'private-string-extra',
      }),
    },
  })
  await robotCallback({
    headers: { messageId: 'delivery-richtext-item-shape' },
    data: {
      msgId: 'message-richtext-item-shape',
      msgtype: 'richText',
      conversationType: '1',
      conversationId: 'private-item-conversation',
      senderStaffId: 'private-item-user',
      senderNick: 'private-item-nick',
      createAt: '6',
      sessionWebhook: 'https://private-item.invalid/webhook',
      content: {
        richText: [
          {
            downloadCode: ['private-item-download-code'],
            text: { content: 'private-item-content' },
            'private-item-secret': 'private-item-secret-value',
          },
        ],
      },
    },
  })

  assert.deepEqual(unsupported, ['image', 'richText', 'richText'])
  const diagnostics = logs.filter((line) => line.startsWith('unsupported inbound shape='))
  assert.equal(
    diagnostics[0],
    'unsupported inbound shape={"msgtype":"image","dataFields":["content:object","conversationId:string","conversationType:string","createAt:string","msgId:string","msgtype:string","senderNick:string","senderStaffId:string","sessionWebhook:string"],"dataUnknownFieldCount":1,"dataUnknownFieldTypes":["string:1"],"rawContentType":"object","parsedContentType":"object","contentFields":["downloadCode:array(2)","fileName:string"],"contentUnknownFieldCount":2,"contentUnknownFieldTypes":["object:1","string:1"],"richTextType":"absent","richTextCount":0,"richTextItemFields":[],"richTextUnknownFieldCount":0,"richTextUnknownFieldTypes":[]}',
  )
  assert.equal(
    diagnostics[1],
    'unsupported inbound shape={"msgtype":"richText","dataFields":["content:string","conversationId:string","conversationType:string","createAt:string","msgId:string","msgtype:string","senderNick:string","senderStaffId:string","sessionWebhook:string"],"dataUnknownFieldCount":0,"dataUnknownFieldTypes":[],"rawContentType":"string","parsedContentType":"object","contentFields":["richText:object"],"contentUnknownFieldCount":1,"contentUnknownFieldTypes":["string:1"],"richTextType":"object","richTextCount":0,"richTextItemFields":[],"richTextUnknownFieldCount":0,"richTextUnknownFieldTypes":[]}',
  )
  assert.equal(
    diagnostics[2],
    'unsupported inbound shape={"msgtype":"richText","dataFields":["content:object","conversationId:string","conversationType:string","createAt:string","msgId:string","msgtype:string","senderNick:string","senderStaffId:string","sessionWebhook:string"],"dataUnknownFieldCount":0,"dataUnknownFieldTypes":[],"rawContentType":"object","parsedContentType":"object","contentFields":["richText:array(1)"],"contentUnknownFieldCount":0,"contentUnknownFieldTypes":[],"richTextType":"array","richTextCount":1,"richTextItemFields":["downloadCode:array(1)","text:object"],"richTextUnknownFieldCount":1,"richTextUnknownFieldTypes":["string:1"]}',
  )
  assert.doesNotMatch(
    logs.join('\n'),
    /private-conversation|private-user|private-nick|private-download-code|private-image|private-content|private\.invalid|private-string|private-top-secret|private-item-secret/,
  )
  assert.deepEqual(messages, [
    {
      msgId: 'message-1',
      conversationId: 'conversation-1',
      conversationType: 'direct',
      senderStaffId: 'user-1',
      senderNick: 'Raph',
      text: '第一张\n第二张',
      createAt: '1',
      imageDownloadCodes: ['image-code-1', 'image-code-1b'],
      contentParts: [
        { type: 'text', text: '第一张' },
        { type: 'image', downloadCode: 'image-code-1' },
        { type: 'text', text: '第二张' },
        { type: 'image', downloadCode: 'image-code-1b' },
      ],
      sessionWebhook: 'https://example.invalid/session',
    },
    {
      msgId: 'message-2',
      conversationId: 'conversation-1',
      conversationType: 'direct',
      senderStaffId: 'user-1',
      senderNick: 'Raph',
      text: '',
      createAt: '2',
      imageDownloadCodes: ['image-code-2'],
      contentParts: [{ type: 'image', downloadCode: 'image-code-2' }],
      sessionWebhook: 'https://example.invalid/session',
    },
    {
      msgId: 'message-3',
      conversationId: 'conversation-1',
      conversationType: 'direct',
      senderStaffId: 'user-1',
      senderNick: 'Raph',
      text: '同一毫秒的另一条消息',
      createAt: '1',
      imageDownloadCodes: ['image-code-3'],
      contentParts: [
        { type: 'image', downloadCode: 'image-code-3' },
        { type: 'text', text: '同一毫秒的另一条消息' },
      ],
      sessionWebhook: 'https://example.invalid/session',
    },
  ])
})

test('卡片 Stream 回调解析并保留审批动作和绑定用户', () => {
  const callback = normalizeCardCallback({
    outTrackId: 'approval-1',
    userId: 'user-1',
    content: JSON.stringify({
      cardPrivateData: {
        actionIds: ['approve'],
        params: { interactionId: 'approval-1' },
      },
    }),
  })

  assert.deepEqual(callback, {
    outTrackId: 'approval-1',
    userId: 'user-1',
    actionIds: ['approve'],
    params: { interactionId: 'approval-1' },
  })
})

test('无有效卡片动作的回调不会进入交互处理器', () => {
  assert.equal(
    normalizeCardCallback({
      outTrackId: 'approval-1',
      userId: 'user-1',
      content: '{}',
    }),
    undefined,
  )
})
