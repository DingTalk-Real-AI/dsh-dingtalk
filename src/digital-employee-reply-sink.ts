import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { DigitalEmployeeAuditFields } from './digital-employee-audit.js'
import type { DigitalEmployeeLedger } from './digital-employee-ledger.js'
import type { DigitalEmployeeConfig } from './setup-state.js'
import type { DigitalEmployeeEvent, DigitalEmployeeReplyResult } from './digital-employee-types.js'

const MAX_JSON_OUTPUT_BYTES = 256 * 1024

interface DwsCapabilities {
  schemaVersion: 1
  protocolVersion: 1
  auditMode: 'local_required'
  capabilities: {
    eventConsume: true
    replyStdin: true
    operatorPrivateStdin: true
  }
}

export interface DigitalEmployeeReplySink {
  reply(
    event: DigitalEmployeeEvent,
    sessionId: string,
    text: string,
    purpose?: string,
  ): Promise<DigitalEmployeeReplyResult>
  operatorPrivate(text: string, operationType: string): Promise<DigitalEmployeeReplyResult>
}

export interface DigitalEmployeeAuditSink {
  audit(fields: DigitalEmployeeAuditFields): Promise<void>
}

export interface DigitalEmployeeControlSink extends DigitalEmployeeReplySink, DigitalEmployeeAuditSink {}

interface DwsDigitalEmployeeReplySinkOptions {
  employee: DigitalEmployeeConfig
  dwsCommand?: string
  ledger: DigitalEmployeeLedger
  auditSink: DigitalEmployeeAuditSink
  onFailure(code: string): void
  onReply(): void
  onAudit(): void
}

export function sanitizedDwsEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (/(TOKEN|AUTH_?CODE|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete result[key]
  }
  return result
}

function idempotencyKey(employee: DigitalEmployeeConfig, event: DigitalEmployeeEvent, operation: string): string {
  return createHash('sha256').update(`${employee.agentUuid}\u0000${event.eventId}\u0000${operation}`).digest('hex')
}

/** DWS 的安全 stdin 回复、operator 私聊、审计与能力探测客户端。 */
export class DwsDigitalEmployeeReplySink implements DigitalEmployeeControlSink {
  private readonly pendingReplies = new Map<string, Set<Promise<unknown>>>()

  constructor(private readonly options: DwsDigitalEmployeeReplySinkOptions) {}

  async reply(
    event: DigitalEmployeeEvent,
    sessionId: string,
    text: string,
    purpose = 'reply',
  ): Promise<DigitalEmployeeReplyResult> {
    const key = idempotencyKey(this.options.employee, event, purpose)
    let result: unknown
    const delivery = this.execJson(
      [
        '--profile',
        this.options.employee.dwsProfile,
        'dingtalk-tag',
        'channel',
        'reply',
        '--channel',
        'dsh',
        '--stdin',
        '--format',
        'json',
      ],
      {
        schemaVersion: 1,
        protocolVersion: 1,
        agentUuid: this.options.employee.agentUuid,
        eventId: event.eventId,
        sessionId,
        conversationId: event.conversationId,
        referenceMessageId: event.messageId,
        text,
        idempotencyKey: key,
      },
    )
    this.trackPendingReply(event.conversationId, delivery)
    try {
      result = await delivery
    } catch (error) {
      this.untrackPendingReply(event.conversationId, delivery)
      this.options.onFailure('reply_failed')
      throw error
    }
    const raw = result as Record<string, unknown>
    if (
      typeof raw.openMessageId !== 'string' ||
      raw.conversationId !== event.conversationId ||
      (raw.deliveryStatus !== 'delivered' && raw.deliveryStatus !== 'unknown') ||
      raw.idempotencyKey !== key
    ) {
      this.untrackPendingReply(event.conversationId, delivery)
      this.options.onFailure('invalid_reply_result')
      throw new Error('invalid_reply_result')
    }
    this.options.ledger.markSentMessage(raw.openMessageId)
    this.untrackPendingReply(event.conversationId, delivery)
    this.options.onReply()
    await this.audit({
      eventId: event.eventId,
      sessionId,
      operationType: purpose,
      status: raw.deliveryStatus,
      replyMessageId: raw.openMessageId,
    })
    return raw as unknown as DigitalEmployeeReplyResult
  }

  async operatorPrivate(text: string, operationType: string): Promise<DigitalEmployeeReplyResult> {
    const key = createHash('sha256')
      .update(`${this.options.employee.agentUuid}\u0000${operationType}\u0000${Date.now()}`)
      .digest('hex')
    let result: unknown
    try {
      result = await this.execJson(
        [
          '--profile',
          this.options.employee.dwsProfile,
          'dingtalk-tag',
          'channel',
          'operator-private',
          '--channel',
          'dsh',
          '--stdin',
          '--format',
          'json',
        ],
        {
          schemaVersion: 1,
          protocolVersion: 1,
          agentUuid: this.options.employee.agentUuid,
          operatorOpenDingTalkId: this.options.employee.operatorOpenDingTalkId,
          text,
          idempotencyKey: key,
        },
      )
    } catch (error) {
      this.options.onFailure('operator_private_failed')
      throw error
    }
    const raw = result as Record<string, unknown>
    if (
      typeof raw.openMessageId !== 'string' ||
      typeof raw.conversationId !== 'string' ||
      (raw.deliveryStatus !== 'delivered' && raw.deliveryStatus !== 'unknown') ||
      raw.idempotencyKey !== key
    ) {
      this.options.onFailure('invalid_operator_reply_result')
      throw new Error('invalid_operator_reply_result')
    }
    this.options.ledger.markSentMessage(raw.openMessageId)
    return raw as unknown as DigitalEmployeeReplyResult
  }

  async audit(fields: DigitalEmployeeAuditFields): Promise<void> {
    try {
      await this.options.auditSink.audit(fields)
    } catch (error) {
      this.options.onFailure('audit_unavailable')
      throw error
    }
    this.options.onAudit()
  }

  async probe(): Promise<void> {
    let result: Partial<DwsCapabilities>
    try {
      result = (await this.execJson([
        '--profile',
        this.options.employee.dwsProfile,
        'dingtalk-tag',
        'channel',
        'capabilities',
        '--channel',
        'dsh',
        '--format',
        'json',
      ])) as Partial<DwsCapabilities>
    } catch (error) {
      this.options.onFailure('dws_capability_probe_failed')
      throw error
    }
    const capabilities = result.capabilities
    if (
      result.schemaVersion !== 1 ||
      result.protocolVersion !== 1 ||
      result.auditMode !== 'local_required' ||
      capabilities?.eventConsume !== true ||
      capabilities.replyStdin !== true ||
      capabilities.operatorPrivateStdin !== true
    ) {
      this.options.onFailure('incompatible_dws_capabilities')
      throw new Error('incompatible_dws_capabilities')
    }
    await this.audit({ operationType: 'runtime_start', status: 'ready' })
  }

  async waitForPendingReplies(conversationId: string): Promise<void> {
    const pending = [...(this.pendingReplies.get(conversationId) ?? [])]
    if (pending.length) await Promise.allSettled(pending)
  }

  private trackPendingReply(conversationId: string, delivery: Promise<unknown>): void {
    const pending = this.pendingReplies.get(conversationId) ?? new Set<Promise<unknown>>()
    pending.add(delivery)
    this.pendingReplies.set(conversationId, pending)
  }

  private untrackPendingReply(conversationId: string, delivery: Promise<unknown>): void {
    const pending = this.pendingReplies.get(conversationId)
    if (!pending) return
    pending.delete(delivery)
    if (!pending.size) this.pendingReplies.delete(conversationId)
  }

  private execJson(args: string[], input?: unknown): Promise<unknown> {
    const command = this.options.dwsCommand ?? 'dws'
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sanitizedDwsEnvironment(process.env),
      })
      let stdout = ''
      let stderrBytes = 0
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (Buffer.byteLength(stdout) > MAX_JSON_OUTPUT_BYTES) child.kill('SIGTERM')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > MAX_JSON_OUTPUT_BYTES) child.kill('SIGTERM')
      })
      child.once('error', () => reject(new Error('dws_spawn_failed')))
      child.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`dws_exit_${code ?? 'unknown'}`))
          return
        }
        try {
          const envelope = JSON.parse(stdout) as Record<string, unknown>
          if (envelope.ok !== true || envelope.outcome !== 'success' || !('data' in envelope)) {
            reject(new Error('invalid_dws_envelope'))
            return
          }
          resolve(envelope.data)
        } catch {
          reject(new Error('invalid_dws_json'))
        }
      })
      if (input === undefined) child.stdin.end()
      else child.stdin.end(`${JSON.stringify(input)}\n`)
    })
  }
}
