/**
 * Outbound replies: POST the conversation's sessionWebhook with a markdown
 * body. Port of dingtalk-openclaw-connector `src/services/messaging/send.ts`
 * (fetch instead of axios; access token cached until near expiry).
 */
import type { DingTalkAppCredentials } from './credentials.js'
import path from 'node:path'
import { FILE_TYPES, IMAGE_TYPES, MAX_MEDIA_BYTES } from './media.js'

export interface MediaTarget {
  conversationType: 'direct' | 'group'
  conversationId: string
  senderStaffId: string
}

export interface OutboundMedia {
  kind: 'file' | 'image'
  name: string
  data: Uint8Array
}

export interface MediaReceipt {
  status: 'accepted'
  processQueryKey: string
}

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

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt - 60_000) return this.#token.value
    const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.credentials.clientId, appSecret: this.credentials.clientSecret }),
      signal,
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

  /** 应用机器人原会话回发；API 接受不等于客户端送达，不自动重试未知结果。 */
  async sendMedia(target: MediaTarget, media: OutboundMedia, signal?: AbortSignal): Promise<MediaReceipt> {
    const extension = path.extname(media.name).slice(1).toLowerCase()
    if (!(media.kind === 'file' ? FILE_TYPES : IMAGE_TYPES).has(extension)) throw new Error('unsupported_file_type')
    if (!media.data.length || media.data.length > MAX_MEDIA_BYTES) throw new Error('media_too_large_or_empty')
    if (target.conversationType === 'direct' ? !target.senderStaffId : !target.conversationId)
      throw new Error('media_target_unavailable')
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
    bounded.throwIfAborted()
    let token: string
    let mediaId: string
    try {
      token = await this.accessToken(bounded)
      bounded.throwIfAborted()
      const form = new FormData()
      form.set('type', media.kind)
      form.set('media', new Blob([new Uint8Array(media.data)]), media.name)
      const url = new URL('https://oapi.dingtalk.com/media/upload')
      url.searchParams.set('access_token', token)
      const response = await fetch(url, { method: 'POST', body: form, signal: bounded })
      if (!response.ok) throw new Error('upload_failed')
      const result = (await response.json()) as { errcode?: number; media_id?: string }
      if (result.errcode !== 0 || typeof result.media_id !== 'string' || !result.media_id)
        throw new Error('upload_failed')
      mediaId = result.media_id
    } catch {
      this.log('media upload failed')
      throw new Error('media_upload_failed')
    }
    const direct = target.conversationType === 'direct'
    try {
      const response = await fetch(
        `https://api.dingtalk.com/v1.0/robot/${direct ? 'oToMessages/batchSend' : 'groupMessages/send'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify({
            robotCode: this.credentials.clientId,
            ...(direct ? { userIds: [target.senderStaffId] } : { openConversationId: target.conversationId }),
            msgKey: media.kind === 'file' ? 'sampleFile' : 'sampleImageMsg',
            msgParam: JSON.stringify(
              media.kind === 'file' ? { mediaId, fileName: media.name, fileType: extension } : { photoURL: mediaId },
            ),
          }),
          signal: bounded,
        },
      )
      if (!response.ok) throw new Error('send_failed')
      const result = (await response.json()) as { processQueryKey?: string; code?: string; errcode?: number }
      if (typeof result.processQueryKey !== 'string' || !result.processQueryKey || result.code || result.errcode)
        throw new Error('send_failed')
      this.log(`media send accepted (${media.kind}, ${media.data.length} bytes)`)
      return { status: 'accepted', processQueryKey: result.processQueryKey }
    } catch {
      this.log('media send unconfirmed; no automatic retry')
      throw new Error('media_send_unconfirmed')
    }
  }
}
