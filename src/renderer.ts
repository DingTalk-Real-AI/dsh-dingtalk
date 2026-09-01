/**
 * Outbound orchestration: one active turn per session, rendered to the
 * conversation through the configured carrier — AI Card (streaming or
 * settle-once), markdown, plain text, or asyncMode (ack now, push later).
 * Consumes the `session/event` feed; the live streaming view is assembled
 * from `assistant/chunk` deltas plus tool-progress lines, while the settled
 * reply prefers the clean aggregated `assistant/message` texts.
 */
import type { Config, ReplyMode } from './config.js'
import type { HostSession, HostSessionEvent } from './host.js'
import type { InboundMessage } from './stream.js'
import type { Emotion } from './emotion.js'
import type { ReplySink } from './reply-sink.js'
import { AICard, CardCapabilityError, type CardTarget } from './aicard.js'
import { cardTarget } from './targets.js'
import { describeTurnError } from './errors.js'

const EMPTY_MODEL_RESPONSE =
  '⚠️ **模型本次未产出正文**\n> 可能是输出额度被推理占满，请调大 `max_tokens` 或更换模型后重试。'

interface Segment {
  kind: 'text' | 'tool'
  text: string
  callId?: string
  name?: string
}

interface TurnState {
  msg: InboundMessage
  mode: ReplyMode
  async: boolean
  /** Live view segments: chunk text and tool lines, in arrival order. */
  live: Segment[]
  /** Clean final texts from assistant/message events. */
  finalParts: string[]
  cardPromise?: Promise<AICard | null>
  flushTimer?: ReturnType<typeof setTimeout>
  lastFlushed: string
  flushing: boolean
  /**
   * A newer bubble (user message / system notice) sits below the live card;
   * the next frame rolls output over to a fresh card at the bottom.
   */
  needsRollover: boolean
  cardUnavailable: boolean
  /** Chars already settled onto earlier cards; the live card shows the remainder. */
  carryOffset: number
  /** Resolves when the turn settles; the queue serializes on this. */
  settle: () => void
}

/**
 * Render live segments to markdown: consecutive tool lines merge into one
 * compact blockquote (one line per tool, no blank lines between them), text
 * flows as-is, and blocks are separated by a single blank line.
 */
function renderLive(segments: Segment[]): string {
  const parts: string[] = []
  let toolGroup: string[] = []
  const flushTools = () => {
    if (toolGroup.length) {
      parts.push(toolGroup.map((line) => `> ${line}`).join('\n'))
      toolGroup = []
    }
  }
  for (const seg of segments) {
    if (seg.kind === 'tool') toolGroup.push(seg.text)
    else {
      flushTools()
      if (seg.text.trim()) parts.push(seg.text.trim())
    }
  }
  flushTools()
  return parts.join('\n\n')
}

export interface RendererDeps {
  config: Pick<Config, 'replyMode' | 'streaming' | 'asyncMode' | 'ackText' | 'markdownTitle' | 'emotionFirstResponse'>
  outbound: ReplySink
  emotion: Emotion
  createCard(target: CardTarget): Promise<AICard | null>
  log(line: string): void
}

export class Renderer {
  private states = new Map<string, TurnState>()

  constructor(private readonly deps: RendererDeps) {}

  /**
   * Register the reply context for the turn this inbound message will drive.
   * The emotion was already added at message intake (before queueing).
   * @returns a promise resolving when the turn settles.
   */
  onInbound(sessionId: string, msg: InboundMessage): Promise<void> {
    const { config } = this.deps
    const isDirect = msg.conversationType === 'direct'
    const mode = isDirect ? config.replyMode.direct : config.replyMode.group

    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })

    const state: TurnState = {
      msg,
      mode,
      async: config.asyncMode,
      live: [],
      finalParts: [],
      lastFlushed: '',
      flushing: false,
      needsRollover: false,
      cardUnavailable: false,
      carryOffset: 0,
      settle,
    }

    if (config.asyncMode) {
      // Ack now; the settled result is pushed at turn end, no streaming card.
      void this.deps.outbound.sendText(msg, config.ackText)
    } else if (mode === 'aicard') {
      state.cardPromise = this.deps.createCard(cardTarget(msg))
    }

    this.states.set(sessionId, state)
    return settled
  }

  /**
   * A new bubble entered the conversation below any live card — mark its
   * turn(s) so the next frame rolls output over to a fresh card at the bottom.
   */
  notifyInterleaved(conversationId: string): void {
    for (const st of this.states.values()) {
      if (st.msg.conversationId === conversationId && st.mode === 'aicard' && !st.async) {
        st.needsRollover = true
      }
    }
  }

  /** Settle the old card with a pointer note and continue on a fresh one. */
  private async rollover(st: TurnState, card: AICard, content: string): Promise<AICard | null> {
    st.needsRollover = false
    try {
      await card.finish(`${content || st.lastFlushed || '…'}\n\n> ⤵️ 输出继续，见下方新卡片`)
      this.deps.log('card rolled over')
    } catch (err) {
      this.deps.log(`rollover finish failed: ${err instanceof Error ? err.message : err}`)
    }
    st.lastFlushed = ''
    st.cardPromise = this.deps.createCard(cardTarget(st.msg))
    return st.cardPromise
  }

  onSessionEvent(session: HostSession, event: HostSessionEvent): void {
    const st = this.states.get(session.id)
    if (!st) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          const last = st.live[st.live.length - 1]
          if (last?.kind === 'text') last.text += chunk.text
          else st.live.push({ kind: 'text', text: chunk.text })
          this.scheduleFlush(session.id, st)
        }
        break
      }
      case 'tool/call': {
        const name = event.data?.name ?? 'tool'
        st.live.push({ kind: 'tool', callId: event.data?.callId, name, text: `⚙️ ${name} 执行中…` })
        this.scheduleFlush(session.id, st)
        break
      }
      case 'tool/result': {
        const callId = event.data?.callId ?? event.data?.message?.source?.callId
        if (callId) {
          const seg = st.live.find((s) => s.kind === 'tool' && s.callId === callId)
          if (seg) {
            seg.text = `⚙️ ${seg.name} ✓`
            this.scheduleFlush(session.id, st)
          }
        }
        break
      }
      case 'assistant/message': {
        const blocks = event.data?.message?.content
        if (Array.isArray(blocks)) {
          const text = blocks
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('')
          if (text.trim()) st.finalParts.push(text)
        }
        break
      }
      case 'turn/end': {
        void this.finalize(session.id, st, event.data?.reason)
        break
      }
    }
  }

  private scheduleFlush(sessionId: string, st: TurnState): void {
    if (st.async || st.mode !== 'aicard' || st.cardUnavailable || !this.deps.config.streaming.enabled) return
    if (st.flushTimer) return
    st.flushTimer = setTimeout(() => {
      st.flushTimer = undefined
      void this.flush(sessionId, st)
    }, this.deps.config.streaming.throttleMs)
  }

  private async flush(sessionId: string, st: TurnState): Promise<void> {
    if (st.flushing || st.cardUnavailable || !this.states.has(sessionId)) return
    st.flushing = true
    try {
      let card = st.cardPromise ? await st.cardPromise : null
      if (!card || !this.states.has(sessionId)) return
      const full = renderLive(st.live)
      let content = full.slice(st.carryOffset)
      if (!content.trim()) return
      // Over-length roll-over (Feishu streamMaxElementChars analog): settle the
      // full current card and continue the remainder on a fresh one.
      if (content.length > this.deps.config.streaming.maxCardChars) {
        st.needsRollover = true
      }
      if (st.needsRollover) {
        card = await this.rollover(st, card, content)
        if (!card || !this.states.has(sessionId)) return
        st.carryOffset = full.length
        content = ''
        return
      } else if (content === st.lastFlushed) {
        return
      }
      await card.stream(content)
      st.lastFlushed = content
    } catch (err) {
      this.deps.log(`stream flush error: ${err instanceof Error ? err.message : err}`)
      if (err instanceof CardCapabilityError) st.cardUnavailable = true
    } finally {
      st.flushing = false
    }
  }

  private async finalize(sessionId: string, st: TurnState, reason: any): Promise<void> {
    // Snapshot-and-delete first: turn/end and a late flush may race, and a
    // second finalize on the same state must be impossible.
    this.states.delete(sessionId)
    if (st.flushTimer) clearTimeout(st.flushTimer)

    const { config, outbound, emotion } = this.deps
    if (config.emotionFirstResponse) await emotion.recall(st.msg.msgId, st.msg.conversationId)
    // Release the queue lane no matter how rendering below fares.
    st.settle()

    const kind = reason?.kind
    const failure = reason?.failure ?? reason?.error
    const failureMessage = typeof failure === 'string' ? failure : failure?.message
    const failureCode =
      typeof failure === 'object' && failure !== null && failure.code !== undefined ? String(failure.code) : undefined
    const errText = kind === 'error' ? describeTurnError(failureMessage, failureCode) : ''
    if (errText) this.deps.log(`turn ended in error: ${failureMessage ?? failureCode ?? 'unknown'}`)
    // 'aborted' is the host's cancellation variant (TurnEndReasonMap) — the
    // user already got its confirmation elsewhere, settle without publishing.
    const interrupted = kind === 'aborted'

    const substance = st.finalParts.join('\n\n').trim()
    const liveText = renderLive(st.live)

    if (interrupted) {
      // Quiet settle: freeze the old card in place, never roll over or add
      // bubbles for a dead turn (a canceled task once spawned a ghost card
      // holding a single tool line).
      const card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
      if (card) {
        try {
          await card.finish(`${liveText ? `${liveText}\n\n` : ''}⏹️ 任务已打断`)
          this.deps.log('card settled (interrupted)')
        } catch (err) {
          this.deps.log(`interrupted settle failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      return
    }

    // After earlier roll-overs the settled cards already hold the prefix；
    // the final card carries the remainder (clean substance replaces the live
    // view only when no roll-over consumed part of it).
    let text = st.carryOffset > 0 ? liveText.slice(st.carryOffset) : substance || liveText
    if (st.carryOffset > 0 && !text.trim()) text = substance ? '（完整内容见上方卡片）' : ''
    if (errText) text = text ? `${text}\n\n${errText}` : errText
    if (!text.trim()) text = EMPTY_MODEL_RESPONSE

    let card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
    if (card && st.needsRollover && (substance || errText)) {
      // Newer bubbles sit below the old card: settle it with a pointer and
      // land the final answer on a fresh card at the bottom. Tool-lines-only
      // output is not worth a fresh card.
      card = await this.rollover(st, card, st.lastFlushed)
    }
    if (card) {
      try {
        if (errText) await card.fail(text)
        else await card.finish(text)
        this.deps.log(`card settled (${text.length} chars)`)
        return
      } catch (err) {
        this.deps.log(`card settle failed, falling back to markdown: ${err instanceof Error ? err.message : err}`)
      }
    }
    // markdown / text / asyncMode / card-fallback all land here.
    if (st.mode === 'text' && !errText) await outbound.sendText(st.msg, text)
    else await outbound.sendMarkdown(st.msg, config.markdownTitle, text)
  }
}
