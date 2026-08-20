/**
 * DingTalk AI Card lifecycle: create + deliver, streaming frames, finish/fail.
 * Ported from dingtalk-openclaw-connector `src/services/messaging/card.ts`
 * (same template, endpoints, flowStatus machine, QPS backoff-and-retry-once,
 * and the trailing-newline trim that prevents <br> flicker on unfinished
 * frames). Simplified: renderer-level throttling replaces the global token
 * bucket.
 */

const DINGTALK_API = 'https://api.dingtalk.com'
/** DingTalk's official built-in AI Card template (same id the connector uses). */
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema'

const FLOW = { PROCESSING: '1', INPUTING: '2', FINISHED: '3', FAILED: '5' } as const

const QPS_BACKOFF_MS = 2_000

const STREAMING_PERMISSION = 'Card.Streaming.Write'

/** A non-transient card capability failure; callers must stop retrying this carrier. */
export class CardCapabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardCapabilityError'
  }
}

/** Process-lifetime circuit breaker for AI Card permission/configuration failures. */
export class CardCapability {
  private blockedReason?: string

  constructor(private readonly onBlocked?: (reason: string) => void) {}

  get available(): boolean {
    return this.blockedReason === undefined
  }

  get reason(): string | undefined {
    return this.blockedReason
  }

  assertAvailable(): void {
    if (this.blockedReason) throw new CardCapabilityError(this.blockedReason)
  }

  /** @returns true when this is a permanent capability failure and the breaker opened. */
  recordFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    if (!/403|AccessTokenPermissionDenied|AccessDenied/.test(message)) return false
    if (!/Card\.(?:Streaming|Instance)|card/i.test(message)) return false
    this.blockedReason = message.includes(STREAMING_PERMISSION)
      ? `缺少钉钉应用权限 ${STREAMING_PERMISSION}`
      : `钉钉 AI Card 权限不可用：${message.slice(0, 180)}`
    this.onBlocked?.(this.blockedReason)
    return true
  }
}

export type CardTarget = { type: 'user'; userId: string } | { type: 'group'; openConversationId: string }

/**
 * DingTalk markdown needs a blank line before a table or it does not render
 * (connector's ensureTableBlankLines lesson, feedback「markdown 格式不好看」).
 */
function ensureTableBlankLines(text: string): string {
  const lines = text.split('\n')
  const divider = /^\s*\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?\s*$/
  const row = /^\s*\|?.*\|.*\|?\s*$/
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]
    const next = lines[i + 1] ?? ''
    if (row.test(current) && next.includes('|') && divider.test(next) && i > 0 && out[out.length - 1].trim() !== '') {
      out.push('')
    }
    out.push(current)
  }
  return out.join('\n')
}

function normalize(content: string): string {
  return ensureTableBlankLines(content.replace(/\r\n/g, '\n'))
}

function isQpsLimit(status: number, body: string): boolean {
  return status === 429 || /qps|too\s*many|limit/i.test(body)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class AICard {
  #inputingStarted = false

  private constructor(
    readonly outTrackId: string,
    private readonly token: () => Promise<string>,
    private readonly capability: CardCapability,
    private readonly log: (line: string) => void,
  ) {}

  private async call(method: 'POST' | 'PUT', path: string, body: unknown): Promise<void> {
    this.capability.assertAvailable()
    const exec = async () => {
      const resp = await fetch(`${DINGTALK_API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await this.token() },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const text = await resp.text()
        return { ok: false as const, status: resp.status, text }
      }
      return { ok: true as const }
    }
    let result = await exec()
    if (!result.ok && isQpsLimit(result.status, result.text)) {
      // Transient rate limit: back off and retry once so finalize frames survive.
      this.log(`card ${path} rate-limited, backing off ${QPS_BACKOFF_MS}ms`)
      await sleep(QPS_BACKOFF_MS)
      result = await exec()
    }
    if (!result.ok) {
      const error = new Error(`card ${method} ${path} failed ${result.status}: ${result.text.slice(0, 300)}`)
      if (this.capability.recordFailure(error)) throw new CardCapabilityError(this.capability.reason ?? error.message)
      throw error
    }
  }

  private instancesBody(flowStatus: string, content: string, finalize: boolean) {
    return {
      outTrackId: this.outTrackId,
      cardData: {
        cardParamMap: {
          flowStatus,
          msgContent: normalize(content),
          staticMsgContent: '',
          sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
          config: JSON.stringify({ autoLayout: true }),
        },
      },
      ...(finalize ? { cardUpdateOptions: { updateCardDataByKey: true } } : {}),
    }
  }

  /** Stream one full-content frame; `finished` marks the last frame. */
  async stream(content: string, finished = false): Promise<void> {
    if (!this.#inputingStarted) {
      await this.call('PUT', '/v1.0/card/instances', this.instancesBody(FLOW.INPUTING, content, false))
      this.#inputingStarted = true
    }
    const fixed = normalize(content)
    await this.call('PUT', '/v1.0/card/streaming', {
      outTrackId: this.outTrackId,
      guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      key: 'msgContent',
      // Unfinished frames drop trailing newlines: they render as <br> and then
      // get corrected by the next frame, which reads as flicker.
      content: finished ? fixed : fixed.replace(/\n+$/, ''),
      isFull: true,
      isFinalize: finished,
      isError: false,
    })
  }

  /** Final content + FINISHED state. */
  async finish(content: string): Promise<void> {
    await this.stream(content, true)
    await this.call('PUT', '/v1.0/card/instances', this.instancesBody(FLOW.FINISHED, content, true))
  }

  /**
   * Overwrite a settled card's content in place (notice cards: the busy
   * prompt morphs into its outcome instead of spawning another bubble).
   * A bare instances PUT on a FINISHED card can 200 without any visual
   * change, so replay the full finalize path: a fresh finalize streaming
   * frame first, then the FINISHED instances update.
   */
  async updateStatic(content: string): Promise<void> {
    await this.call('PUT', '/v1.0/card/streaming', {
      outTrackId: this.outTrackId,
      guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      key: 'msgContent',
      content: normalize(content),
      isFull: true,
      isFinalize: true,
      isError: false,
    })
    await this.call('PUT', '/v1.0/card/instances', this.instancesBody(FLOW.FINISHED, content, true))
  }

  /** Freeze the card in FAILED state with a human-readable error text. */
  async fail(content: string): Promise<void> {
    try {
      if (this.#inputingStarted) await this.stream(content, true)
    } catch {
      // The failure text still lands via the instances update below.
    }
    await this.call('PUT', '/v1.0/card/instances', this.instancesBody(FLOW.FAILED, content, true))
  }

  /**
   * Create a card instance and deliver it into the conversation.
   * @returns the card, or null on failure (caller falls back to markdown).
   */
  static async create(opts: {
    token: () => Promise<string>
    robotCode: string
    target: CardTarget
    capability?: CardCapability
    log: (line: string) => void
  }): Promise<AICard | null> {
    const capability = opts.capability ?? new CardCapability()
    if (!capability.available) return null
    const outTrackId = `dshdt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const card = new AICard(outTrackId, opts.token, capability, opts.log)
    const deliverBody =
      opts.target.type === 'group'
        ? {
            outTrackId,
            openSpaceId: `dtv1.card//IM_GROUP.${opts.target.openConversationId}`,
            imGroupOpenDeliverModel: { robotCode: opts.robotCode },
          }
        : {
            outTrackId,
            openSpaceId: `dtv1.card//IM_ROBOT.${opts.target.userId}`,
            imRobotOpenDeliverModel: {
              spaceType: 'IM_ROBOT',
              robotCode: opts.robotCode,
              extension: { dynamicSummary: 'true' },
            },
          }
    try {
      await card.call('POST', '/v1.0/card/instances', {
        cardTemplateId: AI_CARD_TEMPLATE_ID,
        outTrackId,
        cardData: { cardParamMap: { config: JSON.stringify({ autoLayout: true }) } },
        callbackType: 'STREAM',
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
      })
      await card.call('POST', '/v1.0/card/instances/deliver', deliverBody)
      return card
    } catch (err) {
      opts.log(`card create/deliver failed: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }
}
