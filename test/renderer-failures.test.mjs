import assert from 'node:assert/strict'
import test from 'node:test'

import { Renderer } from '../lib/renderer.js'

function createHarness() {
  const finished = []
  const failed = []
  const sent = []
  const card = {
    async stream() {},
    async finish(text) {
      finished.push(text)
    },
    async fail(text) {
      failed.push(text)
    },
  }
  const renderer = new Renderer({
    config: {
      replyMode: { direct: 'aicard', group: 'aicard' },
      streaming: { enabled: true, throttleMs: 1, maxCardChars: 20_000 },
      asyncMode: false,
      ackText: 'ack',
      markdownTitle: 'DSH',
      emotionFirstResponse: false,
    },
    outbound: {
      async sendMarkdown(_webhook, _title, text) {
        sent.push(text)
        return true
      },
      async sendText(_webhook, text) {
        sent.push(text)
        return true
      },
    },
    emotion: { async recall() {} },
    async createCard() {
      return card
    },
    log() {},
  })
  const msg = {
    msgId: 'm1',
    conversationId: 'c1',
    conversationType: 'direct',
    senderStaffId: 'u1',
    senderNick: 'Raph',
    text: '你好',
    createAt: '1',
    sessionWebhook: 'https://example.test',
  }
  return { renderer, msg, finished, failed, sent }
}

async function settleTurn(harness, reason) {
  const settled = harness.renderer.onInbound('s1', harness.msg)
  harness.renderer.onSessionEvent({ id: 's1' }, { type: 'turn/end', data: { reason } })
  await settled
  await new Promise((resolve) => setImmediate(resolve))
}

test('模型回合失败时向卡片透传 code、message 和可执行提示', async () => {
  const harness = createHarness()
  const message =
    'llm-pi-ai: no credential for provider route "idealab-peach"; its profile resolves IDEALAB_PEACH_API_KEY, which is not set — store IDEALAB_PEACH_API_KEY through the credentials service (the web Models page writes it) or export it'

  await settleTurn(harness, {
    kind: 'error',
    failure: { code: 'MISSING_CREDENTIAL', message },
  })

  assert.equal(harness.failed.length, 1)
  assert.equal(harness.finished.length, 0)
  assert.match(harness.failed[0], /模型凭据未配置/)
  assert.match(harness.failed[0], /MISSING_CREDENTIAL/)
  assert.match(harness.failed[0], /idealab-peach/)
  assert.match(harness.failed[0], /IDEALAB_PEACH_API_KEY/)
  assert.match(harness.failed[0], /credentials service/)
  assert.match(harness.failed[0], /dsh web/)
})

test('模型正常结束但最终正文为空时给出可读说明', async () => {
  const harness = createHarness()

  await settleTurn(harness, { kind: 'completed' })

  assert.equal(harness.failed.length, 0)
  assert.equal(harness.finished.length, 1)
  assert.match(harness.finished[0], /模型本次未产出正文/)
  assert.match(harness.finished[0], /max_tokens/)
  assert.match(harness.finished[0], /更换模型/)
})

test('模型失败但拿不到错误详情时仍不发送空白卡片', async () => {
  const harness = createHarness()

  await settleTurn(harness, { kind: 'error', failure: {} })

  assert.equal(harness.failed.length, 1)
  assert.equal(harness.failed[0], '⚠️ 本次回复失败，请查看 dsh web 日志')
})
