/**
 * First-response emotion: put a "🤔思考中" reaction on the user's message the
 * moment it arrives, and withdraw it when the turn settles. Ported from
 * dingtalk-openclaw-connector `src/utils/utils-legacy.ts:394-445` (same
 * endpoints, payload, and non-blocking failure policy).
 */

const DINGTALK_API = 'https://api.dingtalk.com'

const EMOTION_BODY = {
  emotionType: 2,
  emotionName: '🤔思考中',
  textEmotion: {
    emotionId: '2659900',
    emotionName: '🤔思考中',
    text: '🤔思考中',
    backgroundId: 'im_bg_1',
  },
}

export class Emotion {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly robotCode: string,
    private readonly log: (line: string) => void,
  ) {}

  private async post(path: 'reply' | 'recall', openMsgId: string, openConversationId: string): Promise<void> {
    const token = await this.token()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const resp = await fetch(`${DINGTALK_API}/v1.0/robot/emotion/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({ robotCode: this.robotCode, openMsgId, openConversationId, ...EMOTION_BODY }),
        signal: controller.signal,
      })
      if (!resp.ok) this.log(`emotion ${path} failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Fire-and-forget add; a failure never blocks the main flow. */
  add(openMsgId: string, openConversationId: string): void {
    if (!openMsgId || !openConversationId) return
    this.post('reply', openMsgId, openConversationId).catch((err) =>
      this.log(`emotion add error: ${err instanceof Error ? err.message : err}`),
    )
  }

  /** Awaited recall so the face never lingers after the turn settles. */
  async recall(openMsgId: string, openConversationId: string): Promise<void> {
    if (!openMsgId || !openConversationId) return
    try {
      await this.post('recall', openMsgId, openConversationId)
    } catch (err) {
      this.log(`emotion recall error: ${err instanceof Error ? err.message : err}`)
    }
  }
}
