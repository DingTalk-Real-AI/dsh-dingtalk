/** DingTalk interactive-card delivery for Plan Review and sensitive approvals. */
/** One authenticated button press relayed from the TOPIC_CARD stream callback. */
export interface InteractionCardCallback {
  outTrackId: string
  userId: string
  actionIds: string[]
  params: Record<string, unknown>
}

/** Card creation input whose action ids are fixed to `approve` and `reject`. */
export interface InteractionCardRequest {
  outTrackId: string
  kind: 'approval' | 'plan-review' | 'queue-choice' | 'question'
  target: { type: 'user'; userId: string } | { type: 'group'; openConversationId: string }
  title: string
  detail: string
  approveLabel: string
  rejectLabel: string
}

/** Delivery adapter for the configured DingTalk interactive-card template. */
export interface InteractionCardSender {
  create(request: InteractionCardRequest): Promise<boolean>
}

const DINGTALK_API = 'https://api.dingtalk.com'

export class InteractionCards implements InteractionCardSender {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly robotCode: string,
    private readonly templateId: string,
    private readonly log: (line: string) => void,
  ) {}

  private async call(method: 'POST' | 'PUT', path: string, body: unknown): Promise<void> {
    const resp = await fetch(`${DINGTALK_API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': await this.token(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      throw new Error(`interaction card ${method} ${path} failed ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    }
  }

  async create(request: InteractionCardRequest): Promise<boolean> {
    const deliverBody =
      request.target.type === 'group'
        ? {
            outTrackId: request.outTrackId,
            openSpaceId: `dtv1.card//IM_GROUP.${request.target.openConversationId}`,
            imGroupOpenDeliverModel: { robotCode: this.robotCode },
          }
        : {
            outTrackId: request.outTrackId,
            openSpaceId: `dtv1.card//IM_ROBOT.${request.target.userId}`,
            imRobotOpenDeliverModel: {
              spaceType: 'IM_ROBOT',
              robotCode: this.robotCode,
            },
          }
    try {
      await this.call('POST', '/v1.0/card/instances', {
        cardTemplateId: this.templateId,
        outTrackId: request.outTrackId,
        callbackType: 'STREAM',
        userIdType: 1,
        cardData: {
          cardParamMap: {
            title: request.title,
            detail: request.detail,
            approveLabel: request.approveLabel,
            rejectLabel: request.rejectLabel,
            status: 'pending',
            kind: request.kind,
            interactionId: request.outTrackId,
          },
        },
        imGroupOpenSpaceModel: { supportForward: false },
        imRobotOpenSpaceModel: { supportForward: false },
      })
      await this.call('POST', '/v1.0/card/instances/deliver', deliverBody)
      return true
    } catch (err) {
      this.log(`interaction card create/deliver failed: ${err instanceof Error ? err.message : err}`)
      return false
    }
  }
}
