import type { InboundMessage } from './stream.js'

export interface DigitalEmployeeEvent {
  schemaVersion: 1
  eventId: string
  messageId: string
  conversationId: string
  conversationType: 'direct' | 'group'
  senderOpenDingTalkId: string
  senderName: string
  text: string
  createdAt: string
}

export interface DigitalEmployeeInbound {
  event: DigitalEmployeeEvent
  message: InboundMessage
  scopeKey: string
}

export interface DigitalEmployeeReplyResult {
  openMessageId: string
  conversationId: string
  deliveryStatus: 'delivered' | 'unknown'
  idempotencyKey: string
}
