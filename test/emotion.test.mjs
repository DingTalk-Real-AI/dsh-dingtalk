import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { Emotion } from '../lib/emotion.js'

function captureRequests(t) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return new Response(null, { status: 200 })
  })
  return requests
}

async function addAndRecall(emotion) {
  emotion.add('fixture-message', 'fixture-chat')
  await new Promise((resolve) => setImmediate(resolve))
  await emotion.recall('fixture-message', 'fixture-chat')
}

test('表情配置保留默认值，接受自定义文本并拒绝非字符串', () => {
  assert.equal(Config({}).emotionFirstResponse, true)
  assert.equal(Config({}).emotionFirstResponseText, '🤔思考中')
  assert.equal(Config({ emotionFirstResponseText: '正在处理' }).emotionFirstResponseText, '正在处理')
  assert.equal(Config({ emotionFirstResponse: false }).emotionFirstResponse, false)
  for (const value of [123, true, {}, []]) {
    assert.throws(() => Config({ emotionFirstResponseText: value }))
  }
})

for (const [label, text] of [
  ['未配置', undefined],
  ['空字符串', ''],
  ['全空白', ' \t\n　'],
]) {
  test(`表情内容${label}时保留原有请求体`, async (t) => {
    const requests = captureRequests(t)
    const emotion = new Emotion(
      async () => 'fixture-token',
      'fixture-bot',
      () => {},
      text,
    )
    await addAndRecall(emotion)
    assert.equal(requests.length, 2)
    assert.deepEqual(
      requests.map(({ url }) => url),
      ['https://api.dingtalk.com/v1.0/robot/emotion/reply', 'https://api.dingtalk.com/v1.0/robot/emotion/recall'],
    )
    for (const { body, headers } of requests) {
      assert.equal(headers['x-acs-dingtalk-access-token'], 'fixture-token')
      assert.deepEqual(body, {
        robotCode: 'fixture-bot',
        openMsgId: 'fixture-message',
        openConversationId: 'fixture-chat',
        emotionType: 2,
        emotionName: '🤔思考中',
        textEmotion: {
          emotionId: '2659900',
          emotionName: '🤔思考中',
          text: '🤔思考中',
          backgroundId: 'im_bg_1',
        },
      })
    }
  })
}

for (const text of ['正在处理', '🔍正在查代码', '🧑‍💻检查中']) {
  test(`添加和撤回使用相同自定义内容：${text}`, async (t) => {
    const requests = captureRequests(t)
    const emotion = new Emotion(
      async () => 'fixture-token',
      'fixture-bot',
      () => {},
      `  ${text}　`,
    )
    await addAndRecall(emotion)
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[0].body, requests[1].body)
    assert.equal(requests[0].body.emotionName, text)
    assert.deepEqual(requests[0].body.textEmotion, {
      emotionId: '2659900',
      emotionName: text,
      text,
      backgroundId: 'im_bg_1',
    })
  })
}

test('不同实例的表情内容相互独立', async (t) => {
  const requests = captureRequests(t)
  const first = new Emotion(
    async () => 'fixture-token',
    'first-bot',
    () => {},
    '处理中',
  )
  const second = new Emotion(
    async () => 'fixture-token',
    'second-bot',
    () => {},
    '检查中',
  )
  await addAndRecall(first)
  await addAndRecall(second)
  assert.deepEqual(
    requests.map(({ body }) => [body.robotCode, body.emotionName]),
    [
      ['first-bot', '处理中'],
      ['first-bot', '处理中'],
      ['second-bot', '检查中'],
      ['second-bot', '检查中'],
    ],
  )
})

test('消息或会话 ID 缺失时不请求表情接口', async (t) => {
  const requests = captureRequests(t)
  const emotion = new Emotion(
    async () => 'fixture-token',
    'fixture-bot',
    () => {},
    '检查中',
  )
  emotion.add('', 'fixture-chat')
  emotion.add('fixture-message', '')
  await emotion.recall('', 'fixture-chat')
  await emotion.recall('fixture-message', '')
  assert.equal(requests.length, 0)
})

test('添加和撤回失败仅记录日志，不中断调用方', async (t) => {
  const logs = []
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fixture-network-error')
  })
  const emotion = new Emotion(
    async () => 'fixture-token',
    'fixture-bot',
    (line) => logs.push(line),
    '检查中',
  )
  await addAndRecall(emotion)
  assert.deepEqual(logs, ['emotion add error: fixture-network-error', 'emotion recall error: fixture-network-error'])
})
