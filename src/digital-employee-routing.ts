import { isSessionControl } from './commands.js'
import type { DigitalEmployeeInbound } from './digital-employee-types.js'
import type { InboundMessage } from './stream.js'

interface DigitalEmployeeCommandRouter {
  handle(message: InboundMessage, scopeKey?: string): Promise<boolean>
}

interface DigitalEmployeeInteractiveRouter {
  handleInbound(input: DigitalEmployeeInbound): Promise<boolean>
}

/** 会话控制永远优先于待回答问题，避免 /new 和 /stop 被当成自由文本答案。 */
export async function routeDigitalEmployeePreTask(
  input: DigitalEmployeeInbound,
  commands: DigitalEmployeeCommandRouter,
  interactive: DigitalEmployeeInteractiveRouter,
): Promise<boolean> {
  if (isSessionControl(input.message.text) && (await commands.handle(input.message, input.scopeKey))) return true
  if (await interactive.handleInbound(input)) return true
  return commands.handle(input.message, input.scopeKey)
}
