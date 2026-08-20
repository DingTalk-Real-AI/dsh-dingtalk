import type { CardTarget } from './aicard.js'
import type { InboundMessage } from './stream.js'

type TargetRoute = Pick<InboundMessage, 'conversationType' | 'conversationId' | 'senderStaffId'>

export function cardTarget(route: TargetRoute): CardTarget {
  return route.conversationType === 'direct'
    ? { type: 'user', userId: route.senderStaffId }
    : { type: 'group', openConversationId: route.conversationId }
}
