import type { Outbound } from './outbound.js'
import type { InboundMessage } from './stream.js'

/** Channel 上层只依赖回复能力，不感知机器人 Webhook 或数字员工 DWS 协议。 */
export interface ReplySink {
  sendText(message: InboundMessage, text: string): Promise<boolean>
  sendMarkdown(message: InboundMessage, title: string, text: string): Promise<boolean>
}

/** 现有机器人 Outbound 的 ReplySink 适配器。 */
export class BotReplySink implements ReplySink {
  constructor(private readonly outbound: Pick<Outbound, 'sendText' | 'sendMarkdown'>) {}

  sendText(message: InboundMessage, text: string): Promise<boolean> {
    return this.outbound.sendText(message.sessionWebhook, text)
  }

  sendMarkdown(message: InboundMessage, title: string, text: string): Promise<boolean> {
    return this.outbound.sendMarkdown(message.sessionWebhook, title, text)
  }
}
