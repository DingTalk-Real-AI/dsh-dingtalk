import assert from 'node:assert/strict'
import test from 'node:test'

import { Commands, isSessionControl } from '../lib/commands.js'

function store(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

function inbound(text) {
  return {
    msgId: 'm1',
    conversationId: 'c1',
    conversationType: 'direct',
    senderStaffId: 'u1',
    senderNick: 'Raph',
    text,
    createAt: '1',
    sessionWebhook: 'https://example.test',
  }
}

test('/new 取消运行中的旧 Agent 后解除会话绑定', async () => {
  const sent = []
  const bindings = store({ c1: 'session-1' })
  let cancelled = 0
  let cleared = 0
  const commands = new Commands({
    agents: {
      get: (id) =>
        id === 'session-1'
          ? {
              status: 'running',
              cancel: () => {
                cancelled++
              },
            }
          : undefined,
    },
    outbound: {
      async sendMarkdown(_webhook, _title, text) {
        sent.push(text)
        return true
      },
    },
    bindings,
    modelOverrides: store(),
    queue: {
      depth: () => 0,
      clear: () => {
        cleared++
      },
    },
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    connectorStatus: () => ['管理员：已绑定', 'AI Card：已降级'],
    markdownTitle: 'DSH',
    log() {},
  })
  commands.markBusyNotice('c1', { queuedMsg: inbound('旧排队消息'), skip() {} })

  assert.equal(await commands.handle(inbound('/new')), true)
  assert.equal(cancelled, 1)
  assert.equal(cleared, 1)
  assert.equal(bindings.get('c1'), undefined)
  assert.match(sent[0], /上下文已清空/)
  assert.equal(await commands.handle(inbound('1')), false)
})

test('等待交互时 /new 和 /stop 必须先走会话控制而不是作为问题答案', () => {
  assert.equal(isSessionControl('/new'), true)
  assert.equal(isSessionControl(' /stop '), true)
  assert.equal(isSessionControl('/help'), false)
  assert.equal(isSessionControl('1'), false)
})

test('/status 包含 Connector 安全和载体状态', async () => {
  const sent = []
  const commands = new Commands({
    agents: { get: () => undefined },
    outbound: {
      async sendMarkdown(_webhook, _title, text) {
        sent.push(text)
        return true
      },
    },
    bindings: store(),
    modelOverrides: store(),
    queue: { depth: () => 0, clear() {} },
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    connectorStatus: () => ['管理员：已绑定', '允许群聊：0 个', 'AI Card：已降级', '敏感审批：fail-closed'],
    markdownTitle: 'DSH',
    log() {},
  })
  await commands.handle(inbound('/status'))
  assert.match(sent[0], /管理员：已绑定/)
  assert.match(sent[0], /AI Card：已降级/)
  assert.match(sent[0], /敏感审批：fail-closed/)
})
