import assert from 'node:assert/strict'
import test from 'node:test'

import { DigitalEmployeeApprovalManager, DigitalEmployeeTextRenderer } from '../lib/digital-employee-renderer.js'

const event = {
  schemaVersion: 1,
  eventId: 'event-renderer-1',
  messageId: 'message-renderer-1',
  conversationId: 'conversation-1',
  conversationType: 'direct',
  senderOpenDingTalkId: 'allowed-user',
  senderName: '用户',
  text: '执行任务',
  createdAt: '1',
}

const message = {
  msgId: event.messageId,
  conversationId: event.conversationId,
  conversationType: 'direct',
  senderStaffId: event.senderOpenDingTalkId,
  senderNick: event.senderName,
  text: event.text,
  createAt: event.createdAt,
  sessionWebhook: '',
}

test('数字员工文本 Renderer 只在 turn/end 发送一次引用回复并等待投递结束', async () => {
  const replies = []
  const runtime = {
    async reply(receivedEvent, sessionId, text) {
      replies.push({ receivedEvent, sessionId, text })
      return {
        openMessageId: 'outgoing-renderer-1',
        conversationId: event.conversationId,
        deliveryStatus: 'unknown',
        idempotencyKey: 'key',
      }
    },
  }
  const renderer = new DigitalEmployeeTextRenderer(runtime, () => {})
  renderer.accept({ event, message, scopeKey: 'employee:conversation-1' })
  let settled = false
  const promise = renderer.onInbound('session-1', message).then(() => {
    settled = true
  })
  renderer.onSessionEvent(
    { id: 'session-1' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终文本' }] } } },
  )
  assert.equal(settled, false)
  renderer.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: {} } })
  await promise

  assert.equal(replies.length, 1)
  assert.equal(replies[0].receivedEvent, event)
  assert.equal(replies[0].sessionId, 'session-1')
  assert.equal(replies[0].text, '最终文本')
})

test('敏感审批只接受 operator 私聊中的精确一次性确认码', async () => {
  const delivered = []
  const audits = []
  const runtime = {
    async operatorPrivate(text, operationType) {
      delivered.push({ text, operationType })
      return {
        openMessageId: 'operator-message',
        conversationId: 'operator-chat',
        deliveryStatus: 'delivered',
        idempotencyKey: 'key',
      }
    },
    async audit(fields) {
      audits.push(fields)
    },
  }
  const manager = new DigitalEmployeeApprovalManager(runtime, 'operator-open-id', 1_000, () => {})
  let listener
  manager.install({
    on(name, value) {
      if (name === 'approval/request') listener = value
      return () => {}
    },
  })
  manager.bindSession('session-approval', event)
  const approval = listener(
    {
      agent: { id: 'session-approval' },
      toolName: 'bash',
      reason: '修改文件',
    },
    async () => 'unavailable',
  )
  while (!delivered.length) await new Promise((resolve) => setImmediate(resolve))
  const code = delivered[0].text.match(/确认 ([A-F0-9]{6})/)?.[1]
  assert.ok(code)
  assert.equal(delivered[0].operationType, 'approval_request')

  assert.equal(
    await manager.handleInbound({
      event: { ...event, senderOpenDingTalkId: 'allowed-user', text: `确认 ${code}` },
      message,
      scopeKey: 'x',
    }),
    false,
  )
  assert.equal(
    await manager.handleInbound({
      event: {
        ...event,
        conversationType: 'group',
        senderOpenDingTalkId: 'operator-open-id',
        text: `确认 ${code}`,
      },
      message,
      scopeKey: 'x',
    }),
    false,
  )
  assert.equal(
    await manager.handleInbound({
      event: {
        ...event,
        conversationType: 'direct',
        senderOpenDingTalkId: 'operator-open-id',
        text: `确认 ${code}`,
      },
      message,
      scopeKey: 'x',
    }),
    true,
  )
  assert.equal(await approval, 'allowed-once')
  assert.deepEqual(
    audits.map(({ sessionId, toolName, operationType, status }) => ({ sessionId, toolName, operationType, status })),
    [
      { sessionId: 'session-approval', toolName: 'bash', operationType: 'approval_request', status: 'delivered' },
      { sessionId: 'session-approval', toolName: 'bash', operationType: 'approval_response', status: 'allowed_once' },
    ],
  )
})

test('DSH 原生用户问题通过文本 ReplySink 提问，并只消费原会话原发送者回答', async () => {
  const prompts = []
  const listeners = new Map()
  const runtime = {
    async reply(receivedEvent, sessionId, text, purpose) {
      prompts.push({ receivedEvent, sessionId, text, purpose })
      return {
        openMessageId: 'question-prompt',
        conversationId: receivedEvent.conversationId,
        deliveryStatus: 'delivered',
        idempotencyKey: 'key',
      }
    },
  }
  const manager = new DigitalEmployeeApprovalManager(runtime, 'operator-open-id', 1_000, () => {})
  manager.install({
    agent: { id: 'session-question' },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  })
  manager.bindSession('session-question', event)
  const response = listeners.get('user-questions/request')(
    {
      agent: { id: 'session-question' },
      questions: [
        {
          id: 'choice',
          question: '选择执行方式',
          options: [{ label: '安全模式' }, { label: '快速模式' }],
        },
      ],
    },
    async () => ({ answers: [] }),
  )
  while (!prompts.length) await new Promise((resolve) => setImmediate(resolve))
  assert.match(prompts[0].text, /1\) 安全模式/)
  assert.match(prompts[0].purpose, /^question_prompt_/)

  const answerEvent = { ...event, text: '2' }
  assert.equal(manager.expects(answerEvent), true)
  assert.equal(
    await manager.handleInbound({
      event: { ...answerEvent, senderOpenDingTalkId: 'someone-else' },
      message,
      scopeKey: 'x',
    }),
    false,
  )
  assert.equal(await manager.handleInbound({ event: answerEvent, message, scopeKey: 'x' }), true)
  assert.deepEqual(await response, { answers: [{ id: 'choice', selected: ['快速模式'] }] })
})
