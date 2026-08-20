/**
 * Outbound replies: POST the conversation's sessionWebhook with a markdown
 * body. Port of dingtalk-openclaw-connector `src/services/messaging/send.ts`
 * (fetch instead of axios; access token cached until near expiry).
 */
import type { DingTalkAppCredentials } from './credentials.js'

interface CachedToken {
  value: string
  expiresAt: number
}

function markdownSummary(text: string, fallback: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
  if (!firstLine) return fallback
  const summary = firstLine
    .replace(/^(?:#{1,6}|>|[-+])\s+/, '')
    .replace(/^(\*\*|__|~~|`|\*|_)(.+)\1$/, '$2')
    .trim()
  return summary || fallback
}

export class Outbound {
  #token: CachedToken | undefined

  constructor(
    private readonly credentials: DingTalkAppCredentials,
    private readonly log: (line: string) => void,
  ) {}

  /** Cached app access token, shared by emotion/card modules. */
  async token(): Promise<string> {
    return this.accessToken()
  }

  private async accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt - 60_000) return this.#token.value
    const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.credentials.clientId, appSecret: this.credentials.clientSecret }),
    })
    if (!resp.ok) throw new Error(`accessToken failed ${resp.status}: ${await resp.text()}`)
    const data: any = await resp.json()
    this.#token = {
      value: data.accessToken,
      expiresAt: Date.now() + (data.expireIn ?? 7200) * 1000,
    }
    return this.#token.value
  }

  private async send(sessionWebhook: string, payload: unknown, chars: number): Promise<boolean> {
    try {
      const token = await this.accessToken()
      const resp = await fetch(sessionWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) {
        this.log(`reply failed ${resp.status}: ${await resp.text()}`)
        return false
      }
      this.log(`reply sent (${chars} chars)`)
      return true
    } catch (err) {
      this.log(`reply error: ${err instanceof Error ? err.message : err}`)
      return false
    }
  }

  async sendMarkdown(sessionWebhook: string, title: string, text: string): Promise<boolean> {
    return this.send(
      sessionWebhook,
      {
        msgtype: 'markdown',
        markdown: { title: markdownSummary(text, title), text },
      },
      text.length,
    )
  }

  async sendText(sessionWebhook: string, content: string): Promise<boolean> {
    return this.send(sessionWebhook, { msgtype: 'text', text: { content } }, content.length)
  }
}
