/**
 * DingTalk Stream inbound: DWClient WebSocket long connection, robot messages
 * normalized and deduplicated. Patterns adapted from
 * dingtalk-openclaw-connector `src/core/connection.ts`; see
 * THIRD_PARTY_NOTICES.md for source and license details.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { DingTalkAppCredentials } from './credentials.js'

export type InboundContentPart =
  { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly downloadCode: string }

/** One normalized inbound robot message. */
export interface InboundMessage {
  msgId: string
  conversationId: string
  conversationType: 'direct' | 'group'
  senderStaffId: string
  senderNick: string
  text: string
  /** Original send time (ms); stable across gateway redeliveries. */
  createAt: string
  /** Present on picture/richText messages; each code is exchanged for one image binary. */
  imageDownloadCodes?: readonly string[]
  /** Original picture/richText block order for model-facing multimodal content. */
  contentParts?: readonly InboundContentPart[]
  /** Conversation-scoped reply URL carried by each robot message (expires after hours). */
  sessionWebhook: string
}

/** One actionable interactive-card callback delivered through Stream mode. */
export interface InboundCardCallback {
  outTrackId: string
  userId: string
  actionIds: string[]
  params: Record<string, unknown>
}

/** Normalize DingTalk's string-encoded card callback content. */
export function normalizeCardCallback(data: any): InboundCardCallback | undefined {
  if (!data || typeof data.outTrackId !== 'string' || typeof data.userId !== 'string') return undefined
  let content = data.content ?? data.value
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content)
    } catch {
      return undefined
    }
  }
  const privateData = content?.cardPrivateData
  const actionIds = Array.isArray(privateData?.actionIds)
    ? privateData.actionIds.filter((value: unknown): value is string => typeof value === 'string')
    : []
  if (!actionIds.length) return undefined
  const params = privateData?.params
  return {
    outTrackId: data.outTrackId,
    userId: data.userId,
    actionIds,
    params: typeof params === 'object' && params !== null ? params : {},
  }
}

export interface StreamOptions extends DingTalkAppCredentials {
  debug?: boolean
  /** Persisted dedup store path; survives restarts so gateway redeliveries stay suppressed. */
  seenFile: string
  log(line: string): void
  onMessage(msg: InboundMessage): void | Promise<void>
  /** Fired for message types the channel cannot process (file/audio/video/richText…). */
  onUnsupported?(msgtype: string, sessionWebhook: string): void
  onCardCallback?(callback: InboundCardCallback): unknown | Promise<unknown>
  onStatus?(status: 'connecting' | 'connected' | 'reconnecting' | 'stopped'): void
}

const DEDUP_TTL_MS = 30 * 60 * 1000

function valueType(value: unknown): string {
  if (value === undefined) return 'absent'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const SAFE_MESSAGE_TYPES = new Set(['text', 'picture', 'image', 'richText', 'audio', 'voice', 'video', 'file', 'link'])
const SAFE_DATA_FIELDS = new Set([
  'atUsers',
  'chatbotUserId',
  'content',
  'conversationId',
  'conversationTitle',
  'conversationType',
  'createAt',
  'createTime',
  'isAdmin',
  'msgId',
  'msgtype',
  'robotCode',
  'senderNick',
  'senderStaffId',
  'sessionWebhook',
  'sessionWebhookExpiredTime',
  'text',
])
const SAFE_CONTENT_FIELDS = new Set([
  'downloadCode',
  'fileId',
  'fileName',
  'mediaId',
  'photoURL',
  'pictureDownloadCode',
  'richText',
  'text',
  'type',
])

interface FieldShape {
  fieldTypes: Map<string, Set<string>>
  unknownTypes: Map<string, number>
}

function fieldType(value: unknown): string {
  return Array.isArray(value) ? `array(${value.length})` : valueType(value)
}

function describeFields(value: unknown, safeFields: ReadonlySet<string>): FieldShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { fieldTypes: new Map(), unknownTypes: new Map() }
  }

  const fieldTypes = new Map<string, Set<string>>()
  const unknownTypes = new Map<string, number>()
  for (const [key, fieldValue] of Object.entries(value)) {
    const type = fieldType(fieldValue)
    if (safeFields.has(key)) {
      fieldTypes.set(key, new Set([type]))
    } else {
      unknownTypes.set(type, (unknownTypes.get(type) ?? 0) + 1)
    }
  }
  return { fieldTypes, unknownTypes }
}

function describeRichTextItems(value: unknown): FieldShape {
  if (!Array.isArray(value)) return { fieldTypes: new Map(), unknownTypes: new Map() }
  const fieldTypes = new Map<string, Set<string>>()
  const unknownTypes = new Map<string, number>()
  for (const item of value) {
    const shape = describeFields(item, SAFE_CONTENT_FIELDS)
    for (const [key, itemTypes] of shape.fieldTypes) {
      const types = fieldTypes.get(key) ?? new Set<string>()
      for (const type of itemTypes) types.add(type)
      fieldTypes.set(key, types)
    }
    for (const [type, count] of shape.unknownTypes) {
      unknownTypes.set(type, (unknownTypes.get(type) ?? 0) + count)
    }
  }
  return { fieldTypes, unknownTypes }
}

function formatFields(shape: FieldShape): string[] {
  return [...shape.fieldTypes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, types]) => `${key}:${[...types].sort().join('|')}`)
}

function formatUnknownTypes(shape: FieldShape): string[] {
  return [...shape.unknownTypes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}:${count}`)
}

function unknownFieldCount(shape: FieldShape): number {
  return [...shape.unknownTypes.values()].reduce((total, count) => total + count, 0)
}

/**
 * Describe only callback structure. Values are intentionally excluded so this
 * diagnostic cannot expose message text, download codes, user ids or webhooks.
 */
function describeInboundShape(data: any, rawContent: unknown, parsedContent: any): string {
  const richText = parsedContent?.richText
  const dataShape = describeFields(data, SAFE_DATA_FIELDS)
  const contentShape = describeFields(parsedContent, SAFE_CONTENT_FIELDS)
  const richTextShape = describeRichTextItems(richText)

  return JSON.stringify({
    msgtype: SAFE_MESSAGE_TYPES.has(data?.msgtype) ? data.msgtype : valueType(data?.msgtype),
    dataFields: formatFields(dataShape),
    dataUnknownFieldCount: unknownFieldCount(dataShape),
    dataUnknownFieldTypes: formatUnknownTypes(dataShape),
    rawContentType: valueType(rawContent),
    parsedContentType: valueType(parsedContent),
    contentFields: formatFields(contentShape),
    contentUnknownFieldCount: unknownFieldCount(contentShape),
    contentUnknownFieldTypes: formatUnknownTypes(contentShape),
    richTextType: valueType(richText),
    richTextCount: Array.isArray(richText) ? richText.length : 0,
    richTextItemFields: formatFields(richTextShape),
    richTextUnknownFieldCount: unknownFieldCount(richTextShape),
    richTextUnknownFieldTypes: formatUnknownTypes(richTextShape),
  })
}

/**
 * Restart-surviving dedup. The gateway redelivers messages it considers
 * unacked every ~2-3 minutes, and a redelivery may cross a plugin restart or
 * (observed) carry a fresh delivery id — so we key on BOTH the message id and
 * a SHA-256 content fingerprint (conversation + original createAt + type + content), and
 * persist only that digest. In particular, one-time binding commands must never
 * be written to disk in plaintext.
 */
class SeenStore {
  private map = new Map<string, number>()

  constructor(
    private readonly file: string,
    log: (line: string) => void,
  ) {
    if (existsSync(file)) {
      try {
        const entries = Object.entries(JSON.parse(readFileSync(file, 'utf8'))) as Array<[string, number]>
        const safeEntries = entries.filter(([key]) => !key.startsWith('ct:'))
        this.map = new Map(safeEntries)
        if (safeEntries.length !== entries.length) {
          this.persist()
          log('legacy plaintext dedup fingerprints removed')
        }
      } catch (err) {
        log(`seen store unreadable, starting empty: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  private keys(data: any, fallbackId: string): string[] {
    const keys: string[] = []
    const msgId = data?.msgId ?? fallbackId
    if (msgId) keys.push(`id:${msgId}`)
    const createAt = data?.createAt ?? data?.createTime
    if (createAt && data?.conversationId) {
      const content = data?.msgtype === 'text' ? (data?.text?.content ?? '') : (data?.content ?? '')
      const fingerprint = JSON.stringify([data.conversationId, String(createAt), data?.msgtype ?? '', content])
      keys.push(`fp:${createHash('sha256').update(fingerprint).digest('hex')}`)
    }
    return keys
  }

  /** @returns true when this delivery was seen before (suppress it). */
  checkAndMark(data: any, fallbackId: string): boolean {
    const now = Date.now()
    for (const [k, t] of this.map) if (now - t > DEDUP_TTL_MS) this.map.delete(k)
    const keys = this.keys(data, fallbackId)
    const dup = keys.some((k) => this.map.has(k))
    for (const k of keys) this.map.set(k, now)
    this.persist()
    return dup
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)))
    } catch {
      // Persistence is best-effort; in-memory dedup still holds for this process.
    }
  }
}

/** Heartbeat cadence; timeout threshold is two missed beats. */
const HEARTBEAT_INTERVAL_MS = 10_000
const TIMEOUT_THRESHOLD_MS = 20_000
/** Grace period after (re)connect before socket-state checks may reconnect. */
const CONNECT_GRACE_MS = 15_000

/**
 * Open the Stream connection and subscribe robot messages.
 *
 * Connection reliability is self-managed (SDK keepAlive/autoReconnect are
 * DISABLED), ported from dingtalk-openclaw-connector `core/connection.ts`:
 * one 10s timer sends a native WS ping and checks both "no pong for 20s" and
 * "socket not OPEN"; the server's SYSTEM/disconnect topic and the close event
 * trigger immediate reconnects; reconnects back off exponentially with jitter
 * and re-register socket listeners right away (a pong arriving before the
 * listener is attached would otherwise be dropped).
 *
 * @returns a disposer closing the connection.
 */
export async function startStream(opts: StreamOptions): Promise<() => void> {
  const emitStatus = (status: 'connecting' | 'connected' | 'reconnecting' | 'stopped'): void => {
    try {
      opts.onStatus?.(status)
    } catch (error) {
      opts.log(`stream status observer error: ${error instanceof Error ? error.message : error}`)
    }
  }
  // Defensive dynamic import: dingtalk-stream is CJS; named exports vary by loader.
  const mod: any = await import('dingtalk-stream')
  const DWClient = mod.DWClient ?? mod.default?.DWClient
  const TOPIC_ROBOT = mod.TOPIC_ROBOT ?? mod.default?.TOPIC_ROBOT ?? '/v1.0/im/bot/messages/get'
  const TOPIC_CARD = mod.TOPIC_CARD ?? mod.default?.TOPIC_CARD ?? '/v1.0/card/instances/callback'
  if (!DWClient) throw new Error('failed to import DWClient from dingtalk-stream')

  emitStatus('connecting')
  const client = new DWClient({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    debug: opts.debug ?? false,
    keepAlive: false,
    autoReconnect: false,
  })

  const seen = new SeenStore(opts.seenFile, opts.log)

  client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
    const callbackId = res?.headers?.messageId
    try {
      const data = typeof res?.data === 'string' ? JSON.parse(res.data) : res?.data
      const msgId: string = data?.msgId ?? callbackId ?? ''
      if (seen.checkAndMark(data, callbackId ?? '')) {
        opts.log(`duplicate delivery suppressed (msgId=${String(msgId).slice(-12)} createAt=${data?.createAt ?? '?'})`)
        return
      }

      const rawConversationType = String(data?.conversationType ?? '')
      if (rawConversationType !== '1' && rawConversationType !== '2') {
        opts.log('unsupported inbound conversation type')
        return
      }
      const conversationType = rawConversationType === '1' ? 'direct' : 'group'
      // content may arrive as an object or a JSON string (connector's
      // resolveContent defense) — accept both.
      const rawContent = data?.content
      let contentObj: any = rawContent
      if (typeof contentObj === 'string') {
        try {
          contentObj = JSON.parse(contentObj)
        } catch {
          contentObj = undefined
        }
      }
      const richTextItems: any[] =
        data?.msgtype === 'richText' && Array.isArray(contentObj?.richText) ? contentObj.richText : []
      const richTextParts: InboundContentPart[] = richTextItems.flatMap((item) => {
        const parts: InboundContentPart[] = []
        if (typeof item?.text === 'string' && item.text.trim()) {
          parts.push({ type: 'text', text: item.text.trim() })
        }
        if (typeof item?.downloadCode === 'string') {
          parts.push({ type: 'image', downloadCode: item.downloadCode })
        }
        return parts
      })
      const text =
        data?.msgtype === 'richText'
          ? richTextParts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
          : String(data?.text?.content ?? '').trim()
      const imageDownloadCodes =
        data?.msgtype === 'picture' && typeof contentObj?.downloadCode === 'string'
          ? [contentObj.downloadCode]
          : richTextParts.flatMap((part) => (part.type === 'image' ? [part.downloadCode] : []))
      const contentParts: InboundContentPart[] =
        data?.msgtype === 'picture' && imageDownloadCodes[0]
          ? [{ type: 'image', downloadCode: imageDownloadCodes[0] }]
          : richTextParts
      if (!text && imageDownloadCodes.length === 0) {
        opts.log(`unsupported inbound shape=${describeInboundShape(data, rawContent, contentObj)}`)
        if (data?.sessionWebhook) opts.onUnsupported?.(String(data?.msgtype ?? 'unknown'), data.sessionWebhook)
        return
      }
      await opts.onMessage({
        msgId,
        conversationId: data?.conversationId ?? '',
        conversationType,
        senderStaffId: data?.senderStaffId ?? '',
        senderNick: data?.senderNick ?? '',
        text,
        createAt: String(data?.createAt ?? data?.createTime ?? ''),
        ...(imageDownloadCodes.length ? { imageDownloadCodes } : {}),
        ...(contentParts.length ? { contentParts } : {}),
        sessionWebhook: data?.sessionWebhook ?? '',
      })
    } catch (err) {
      opts.log(`inbound handler error: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
    } finally {
      // Ack so the gateway does not redeliver (connector does the same).
      try {
        client.socketCallBackResponse?.(callbackId, { success: true })
      } catch {
        // Ack failure only risks a redelivery, which dedup absorbs.
      }
    }
  })

  client.registerCallbackListener(TOPIC_CARD, async (res: any) => {
    const callbackId = res?.headers?.messageId
    let response: unknown = {}
    try {
      const data = typeof res?.data === 'string' ? JSON.parse(res.data) : res?.data
      const callback = normalizeCardCallback(data)
      if (callback && opts.onCardCallback) response = await opts.onCardCallback(callback)
    } catch (err) {
      opts.log(`card callback error: ${err instanceof Error ? err.message : err}`)
    } finally {
      try {
        client.socketCallBackResponse?.(callbackId, response ?? {})
      } catch {
        // A failed callback acknowledgement may redeliver; interaction ids are idempotent.
      }
    }
  })

  // ==== self-managed connection reliability ====
  let lastAlive = Date.now()
  let establishedAt = Date.now()
  let reconnecting = false
  let attempts = 0
  let stopped = false

  const socket = (): any => (client as any).socket

  const setupSocketListeners = (): void => {
    const sock = socket()
    if (!sock) return
    sock.on('pong', () => {
      lastAlive = Date.now()
      // Refresh the cross-process doctor heartbeat, not only state changes.
      emitStatus('connected')
    })
    sock.on('message', (data: any) => {
      try {
        const m = JSON.parse(String(data))
        // Protocol, not failure: the server asks clients to reconnect on LB /
        // instance switches via a SYSTEM/disconnect topic.
        if (m?.type === 'SYSTEM' && m?.headers?.topic === 'disconnect') {
          opts.log('server requested disconnect; reconnecting now')
          void reconnect(true)
        }
      } catch {
        // Non-JSON frames are the SDK's business.
      }
    })
    sock.on('close', (code: number) => {
      if (stopped) return
      opts.log(`socket closed (code=${code}); reconnecting now`)
      setTimeout(() => void reconnect(true), 0)
    })
  }

  const waitOpen = (): Promise<boolean> =>
    new Promise((resolve) => {
      if (socket()?.readyState === 1) return resolve(true)
      const sock = socket()
      if (!sock) return resolve(false)
      const timer = setTimeout(() => {
        sock.removeListener('open', onOpen)
        resolve(false)
      }, 10_000)
      const onOpen = () => {
        clearTimeout(timer)
        resolve(true)
      }
      sock.once('open', onOpen)
    })

  const backoffDelay = (attempt: number): number => Math.min(1_000 * 2 ** attempt + Math.random() * 1_000, 60_000)

  const reconnect = async (immediate = false): Promise<void> => {
    if (reconnecting || stopped) return
    reconnecting = true
    emitStatus('reconnecting')
    try {
      if (!immediate && attempts > 0) {
        const delay = backoffDelay(attempts)
        opts.log(`reconnect backoff ${Math.round(delay / 1000)}s (attempt ${attempts + 1})`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      const state = socket()?.readyState
      if (state === 1 || state === 3) {
        try {
          await client.disconnect?.()
        } catch {
          // A dead socket refusing to close cleanly is expected here.
        }
      }
      await client.connect()
      // Attach listeners immediately: a pong arriving before they exist is
      // dropped and would push us toward the timeout threshold.
      setupSocketListeners()
      if (!(await waitOpen())) throw new Error('connection did not reach OPEN within 10s')
      lastAlive = Date.now()
      establishedAt = Date.now()
      attempts = 0
      emitStatus('connected')
      opts.log('reconnected')
    } catch (err) {
      attempts++
      opts.log(`reconnect failed (attempt ${attempts}): ${err instanceof Error ? err.message : err}`)
    } finally {
      reconnecting = false
    }
  }

  await client.connect()
  setupSocketListeners()
  emitStatus('connected')
  opts.log('stream connected (self-managed heartbeat)')

  const heartbeat = setInterval(() => {
    if (stopped || reconnecting) return
    const elapsed = Date.now() - lastAlive
    if (elapsed > TIMEOUT_THRESHOLD_MS) {
      opts.log(`heartbeat timeout (${Math.round(elapsed / 1000)}s without pong); reconnecting`)
      void reconnect()
      return
    }
    const state = socket()?.readyState
    if (state !== 1) {
      if (Date.now() - establishedAt < CONNECT_GRACE_MS) return
      opts.log(`socket not open (state=${state}); reconnecting`)
      void reconnect(true)
      return
    }
    try {
      // Send-only: lastAlive refreshes exclusively on the pong reply.
      socket()?.ping()
    } catch {
      // A failed ping counts toward the timeout via the missing pong.
    }
  }, HEARTBEAT_INTERVAL_MS)

  return () => {
    stopped = true
    emitStatus('stopped')
    clearInterval(heartbeat)
    try {
      client.disconnect?.()
    } catch {
      // Closing an already-dead socket is fine; nothing else holds it.
    }
  }
}
