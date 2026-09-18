import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { LocalDigitalEmployeeAuditLog } from './digital-employee-audit.js'
import { atomicPrivateJsonWrite, DigitalEmployeeLedger } from './digital-employee-ledger.js'
import { DwsDigitalEmployeeReplySink, sanitizedDwsEnvironment } from './digital-employee-reply-sink.js'
import type { DigitalEmployeeEvent, DigitalEmployeeInbound } from './digital-employee-types.js'
import type { InboundSource } from './inbound-source.js'
import type { DigitalEmployeeConfig } from './setup-state.js'
import type { InboundMessage } from './stream.js'

export type {
  DigitalEmployeeEvent,
  DigitalEmployeeInbound,
  DigitalEmployeeReplyResult,
} from './digital-employee-types.js'

const READY_LINE = /^\[event\] ready(?:\s|$)/
const MAX_LINE_BYTES = 1024 * 1024
const STATUS_HEARTBEAT_MS = 10_000

export interface DigitalEmployeeRuntimeStatus {
  state: 'probing' | 'connecting' | 'ready' | 'stopped' | 'failed'
  observedAt: number
  lastEventAt?: number
  lastReplyAt?: number
  lastAuditAt?: number
  capabilitiesVerifiedAt?: number
  subscriptionTopics?: string[]
  failureCode?: string
}

export interface DigitalEmployeeRuntimeOptions {
  employee: DigitalEmployeeConfig
  stateDir: string
  dwsCommand?: string
  dwsArgsPrefix?: readonly string[]
  readyTimeoutMs?: number
  log(line: string): void
  onMessage(input: DigitalEmployeeInbound): void | Promise<void>
  onCardAction?(event: unknown): void
  /** 仅订阅启动失败且尚未发卡时调用，撤销 A2UI 后再启动原文字订阅。 */
  onCardUnavailable?(): void
  onStatus?(status: DigitalEmployeeRuntimeStatus): void
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`invalid_${field}`)
  }
  return value
}

function parseEvent(value: unknown): DigitalEmployeeEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_event')
  const raw = value as Record<string, unknown>
  const eventType = raw.type ?? raw.event_type
  const conversationType =
    eventType === 'user_im_message_receive_o2o_all'
      ? 'direct'
      : eventType === 'user_im_message_receive_group_all'
        ? 'group'
        : undefined
  if (!conversationType) throw new Error('invalid_event_type')
  if (typeof raw.content !== 'string' || raw.content.length > MAX_LINE_BYTES) throw new Error('invalid_text')
  const createdAt = raw.create_time ?? raw.event_time ?? raw.timestamp
  return {
    schemaVersion: 1,
    eventId: safeId(raw.event_id, 'event_id'),
    messageId: safeId(raw.message_id, 'message_id'),
    conversationId: safeId(raw.conversation_id, 'conversation_id'),
    conversationType,
    senderOpenDingTalkId: safeId(raw.sender_open_dingtalk_id, 'sender'),
    senderName: typeof raw.sender === 'string' ? raw.sender.slice(0, 128) : '',
    text: raw.content,
    createdAt: typeof createdAt === 'string' || typeof createdAt === 'number' ? String(createdAt) : String(Date.now()),
  }
}

export function authorizeDigitalEmployeeEvent(employee: DigitalEmployeeConfig, event: DigitalEmployeeEvent): boolean {
  if (event.conversationType === 'direct') {
    return (
      event.senderOpenDingTalkId === employee.operatorOpenDingTalkId ||
      employee.allowedDirectSenders.includes(event.senderOpenDingTalkId)
    )
  }
  return employee.allowedGroups.includes(event.conversationId)
}

function scopeKey(employee: DigitalEmployeeConfig, event: DigitalEmployeeEvent): string {
  const chat = `${employee.agentUuid}:${event.conversationId}`
  return employee.sessionScope === 'chat-sender' && event.conversationType === 'group'
    ? `${chat}#${event.senderOpenDingTalkId}`
    : chat
}

function normalizeInbound(event: DigitalEmployeeEvent): InboundMessage {
  return {
    msgId: event.messageId,
    conversationId: event.conversationId,
    conversationType: event.conversationType,
    senderStaffId: event.senderOpenDingTalkId,
    senderNick: event.senderName,
    text: event.text,
    createAt: event.createdAt,
    sessionWebhook: '',
  }
}

export class DwsDigitalEmployeeSource implements InboundSource {
  private child?: ChildProcessWithoutNullStreams
  private readonly childClosed = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>()
  private stopped = false
  private cardsDisabled = false
  private cardSubscriptionReady = false
  private status: DigitalEmployeeRuntimeStatus = { state: 'probing', observedAt: Date.now() }
  private readonly ledger: DigitalEmployeeLedger
  private eventChain = Promise.resolve()
  private retryCount = 0
  private restarting = false
  private lastRetryable: boolean | undefined
  private heartbeat?: ReturnType<typeof setInterval>
  readonly replySink: DwsDigitalEmployeeReplySink

  constructor(private readonly options: DigitalEmployeeRuntimeOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
    chmodSync(options.stateDir, 0o700)
    try {
      this.ledger = new DigitalEmployeeLedger(path.join(options.stateDir, 'ledger.json'))
    } catch {
      this.status = { state: 'failed', observedAt: Date.now(), failureCode: 'ledger_corrupt' }
      atomicPrivateJsonWrite(path.join(options.stateDir, 'runtime.json'), this.status)
      options.onStatus?.({ ...this.status })
      throw new Error('digital_employee_ledger_corrupt')
    }
    this.replySink = new DwsDigitalEmployeeReplySink({
      employee: options.employee,
      dwsCommand: options.dwsCommand,
      dwsArgsPrefix: options.dwsArgsPrefix,
      ledger: this.ledger,
      auditSink: new LocalDigitalEmployeeAuditLog(options.stateDir, options.employee.agentUuid),
      onFailure: (code) => this.fail(code),
      onReply: () => this.updateStatus({ state: 'ready', lastReplyAt: Date.now() }),
      onAudit: () => this.updateStatus({ lastAuditAt: Date.now() }),
    })
  }

  async start(): Promise<void> {
    try {
      await this.probe()
      if (this.stopped) return
      this.updateStatus({ state: 'connecting' })
      try {
        await this.startConsumer()
      } catch (error) {
        if (
          this.options.onCardAction &&
          this.options.onCardUnavailable &&
          !this.cardSubscriptionReady &&
          !this.stopped
        ) {
          if (this.child) await this.terminateChild(this.child)
          this.cardsDisabled = true
          this.options.onCardUnavailable()
          this.options.log('a2ui subscription unavailable before delivery; using text interactions')
          await this.startConsumer()
          return
        }
        if (!(await this.retryConsumer(this.lastRetryable))) throw error
      }
    } catch (error) {
      if (!this.stopped && this.status.state !== 'failed') this.fail('digital_employee_start_failed')
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopHeartbeat()
    const child = this.child
    this.child = undefined
    if (child) await this.terminateChild(child)
    await this.eventChain
    this.updateStatus({ state: 'stopped' })
  }

  currentStatus(): DigitalEmployeeRuntimeStatus {
    return { ...this.status }
  }

  private async probe(): Promise<void> {
    await this.replySink.probe()
    this.updateStatus({
      capabilitiesVerifiedAt: Date.now(),
      subscriptionTopics: this.subscriptionTopics(),
    })
  }

  private async startConsumer(): Promise<void> {
    const command = this.options.dwsCommand ?? 'dws'
    const args = [
      ...(this.options.dwsArgsPrefix ?? []),
      '--profile',
      this.options.employee.dwsProfile,
      'event',
      'consume',
      ...this.subscriptionTopics(),
      '--flatten',
      '--format',
      'ndjson',
    ]
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedDwsEnvironment(process.env),
    })
    this.child = child
    // 从创建时记录 close；信号退出的 exitCode 仍为 null，不能重新等待已发出的事件。
    this.childClosed.set(child, new Promise<void>((resolve) => child.once('close', () => resolve())))
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let ready = false
    let retryable: boolean | undefined
    let readyTimedOut = false
    const consumeLine = (line: string, stream: 'stdout' | 'stderr') => {
      if (this.stopped) return
      if (READY_LINE.test(line)) {
        ready = true
        if (this.options.onCardAction && !this.cardsDisabled) this.cardSubscriptionReady = true
        this.updateStatus({ state: 'ready', subscriptionTopics: this.subscriptionTopics() })
        this.startHeartbeat()
        return
      }
      if (stream === 'stderr') {
        if (/retryable\s*=\s*true/i.test(line)) retryable = true
        if (/retryable\s*=\s*false/i.test(line)) retryable = false
        return
      }
      if (!ready) throw new Error('event_before_ready')
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('event_line_too_large')
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        this.options.log('event parse rejected (invalid_json)')
        return
      }
      // 卡片控制事件不得等待正在阻塞于审批/问答的普通消息队列。
      if ((value as { type?: string })?.type === 'user_card_action_triggered') {
        if (!this.stopped && !this.cardsDisabled) this.options.onCardAction?.(value)
        return
      }
      this.eventChain = this.eventChain
        .then(() => this.handleEvent(parseEvent(value)))
        .catch((error) => this.options.log(`event rejected (${error instanceof Error ? error.message : 'unknown'})`))
    }
    const drain = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      let buffer = (stream === 'stdout' ? stdoutBuffer : stderrBuffer) + chunk.toString('utf8')
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        try {
          consumeLine(line, stream)
        } catch (error) {
          this.fail(error instanceof Error ? error.message : 'consume_failed')
          child.stdin.end()
          child.kill('SIGTERM')
          break
        }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        this.fail('event_line_too_large')
        child.stdin.end()
        child.kill('SIGTERM')
        buffer = ''
      }
      if (stream === 'stdout') stdoutBuffer = buffer
      else stderrBuffer = buffer
    }
    child.stdout.on('data', (chunk: Buffer) => drain(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => drain(chunk, 'stderr'))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        readyTimedOut = true
        this.lastRetryable = undefined
        this.fail('ready_timeout_unknown')
        void this.terminateChild(child)
      }, this.options.readyTimeoutMs ?? 15_000)
      const poll = setInterval(() => {
        if (!ready) return
        clearTimeout(timer)
        clearInterval(poll)
        resolve()
      }, 5)
      child.once('error', (error) => {
        clearTimeout(timer)
        clearInterval(poll)
        this.lastRetryable = undefined
        this.fail('dws_spawn_failed_unknown')
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        clearInterval(poll)
        this.lastRetryable = retryable
        if (!this.stopped && !readyTimedOut) {
          this.fail(`event_consumer_exit_${code ?? 'unknown'}_${retryable ?? 'unknown'}`)
        }
        if (!ready) reject(new Error(readyTimedOut ? 'ready_timeout' : 'event_consumer_exited_before_ready'))
        else if (!this.stopped) void this.retryConsumer(retryable)
      })
    })
  }

  private retryBudget(retryable: boolean | undefined): number {
    return retryable === false ? 0 : retryable === true ? 2 : 1
  }

  private subscriptionTopics(): string[] {
    return [
      'user_im_message_receive_o2o_all',
      'user_im_message_receive_group_all',
      ...(this.options.onCardAction && !this.cardsDisabled ? ['user_card_action_triggered'] : []),
    ]
  }

  private async retryConsumer(retryable: boolean | undefined): Promise<boolean> {
    if (this.restarting || this.stopped) return false
    this.restarting = true
    let hint = retryable
    try {
      for (;;) {
        const budget = this.retryBudget(hint)
        if (this.retryCount >= budget || this.stopped) return false
        this.retryCount++
        this.options.log(`event consumer retry ${this.retryCount}/${budget}`)
        this.updateStatus({ state: 'connecting' })
        try {
          await this.startConsumer()
          return true
        } catch {
          hint = this.lastRetryable
        }
      }
    } finally {
      this.restarting = false
    }
  }

  private async handleEvent(event: DigitalEmployeeEvent): Promise<void> {
    if (this.stopped) return
    if (this.ledger.hasEvent(event.eventId) || this.ledger.hasSentMessage(event.messageId)) return
    const allowed = authorizeDigitalEmployeeEvent(this.options.employee, event)
    if (!allowed) {
      await this.replySink.audit({ eventId: event.eventId, operationType: 'access_check', status: 'denied' })
      this.ledger.markEvent(event.eventId)
      return
    }
    // 本地审计不可写时不开始新任务。成功后才占用 eventId，允许上游重放暂时失败的事件。
    await this.replySink.audit({ eventId: event.eventId, operationType: 'access_check', status: 'accepted' })
    await this.replySink.waitForPendingReplies(event.conversationId)
    if (this.ledger.hasEvent(event.eventId) || this.ledger.hasSentMessage(event.messageId)) return
    if (this.stopped) return
    if (this.status.state === 'failed') throw new Error('digital_employee_fail_closed')
    this.ledger.markEvent(event.eventId)
    this.updateStatus({ state: 'ready', lastEventAt: Date.now() })
    void Promise.resolve(
      this.options.onMessage({
        event,
        message: normalizeInbound(event),
        scopeKey: scopeKey(this.options.employee, event),
      }),
    ).catch((error) => this.options.log(`task callback failed (${error instanceof Error ? error.message : 'unknown'})`))
  }

  private fail(code: string): void {
    this.stopHeartbeat()
    this.updateStatus({ state: 'failed', failureCode: code })
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const closed = this.childClosed.get(child)
    if (!closed) throw new Error('untracked_event_consumer')
    if (child.exitCode !== null || child.signalCode !== null) {
      await closed
      return
    }
    child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
    // 不使用 SIGKILL；仍等待进程及 stdio 真正关闭后才允许重试或完成 stop。
    await closed
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.status.state === 'ready') this.updateStatus({ state: 'ready' })
    }, STATUS_HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private updateStatus(next: Partial<Omit<DigitalEmployeeRuntimeStatus, 'observedAt'>>): void {
    this.status = { ...this.status, ...next, observedAt: Date.now() }
    if (next.state && next.state !== 'failed') delete this.status.failureCode
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    const file = path.join(this.options.stateDir, 'runtime.json')
    atomicPrivateJsonWrite(file, this.status)
    this.options.onStatus?.({ ...this.status })
  }
}
