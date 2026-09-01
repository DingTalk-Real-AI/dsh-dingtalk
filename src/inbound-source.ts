import { startStream, type StreamOptions } from './stream.js'

/** 机器人与数字员工共同遵循的可托管入站源生命周期。 */
export interface InboundSource {
  start(): Promise<void>
  stop(): void | Promise<void>
}

/** 保持现有 DingTalk Robot Stream 行为的生命周期适配器。 */
export class RobotStreamSource implements InboundSource {
  private dispose?: () => void

  constructor(private readonly options: StreamOptions) {}

  async start(): Promise<void> {
    if (this.dispose) return
    this.dispose = await startStream(this.options)
  }

  stop(): void {
    this.dispose?.()
    this.dispose = undefined
  }
}
