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
    chatDelivery: true
    visibilityAccess?: boolean
    groupMembershipAccess?: boolean
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
  dwsArgsPrefix?: readonly string[]
  ledger: DigitalEmployeeLedger
  auditSink: DigitalEmployeeAuditSink
  onFailure(code: string): void
  onReply(): void
  onAudit(): void
}

export function sanitizedDwsEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (/(TOKEN|AUTH_?CODE|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || key === 'DWS_DUMP_RAW') delete result[key]
  }
  return result
}

function idempotencyKey(employee: DigitalEmployeeConfig, event: DigitalEmployeeEvent, operation: string): string {
  return createHash('sha256').update(`${employee.agentUuid}\u0000${event.eventId}\u0000${operation}`).digest('hex')
}

/** DWS 的安全 stdin 回复、operator 私聊、审计与能力探测客户端。 */
export class DwsDigitalEmployeeReplySink implements DigitalEmployeeControlSink {
  private useVisibilityAccess = false
  private useGroupMembershipAccess = false
  private readonly activeCalls = new Set<Promise<unknown>>()
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
        'chat',
        '+messages-reply',
        '--group',
        event.conversationId,
        '--message-id',
        event.messageId,
        '--content',
        '-',
        '--body-stdin',
        '--wait-delivery',
        '--employee-context',
        this.employeeContext(),
        '--idempotency-key',
        key,
        '--yes',
        '--format',
        'json',
      ],
      text,
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
      raw.openMessageId.trim() === '' ||
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
          'chat',
          '+messages-send',
          '--open-dingtalk-id',
          this.options.employee.operatorOpenDingTalkId,
          '--markdown',
          '-',
          '--title',
          '数字员工审批',
          '--body-stdin',
          '--wait-delivery',
          '--employee-context',
          this.employeeContext(),
          '--idempotency-key',
          key,
          '--yes',
          '--format',
          'json',
        ],
        text,
      )
    } catch (error) {
      this.options.onFailure('operator_private_failed')
      throw error
    }
    const raw = result as Record<string, unknown>
    if (
      typeof raw.openMessageId !== 'string' ||
      raw.openMessageId.trim() === '' ||
      typeof raw.conversationId !== 'string' ||
      raw.conversationId.trim() === '' ||
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
      capabilities.chatDelivery !== true
    ) {
      this.options.onFailure('incompatible_dws_capabilities')
      throw new Error('incompatible_dws_capabilities: 请升级 DWS，数字员工要求 chatDelivery=true')
    }
    this.useVisibilityAccess = capabilities.visibilityAccess === true
    this.useGroupMembershipAccess = capabilities.groupMembershipAccess === true
    await this.audit({ operationType: 'runtime_start', status: 'ready' })
  }

  // 这是 connect 已授权自动回传的绑定约束；主管不能从普通用户白名单推断。
  private employeeContext(): string {
    const employee = this.options.employee
    return JSON.stringify({
      agentUuid: employee.agentUuid,
      channel: 'dsh',
      bindingRevision: employee.bindingRevision ?? 0,
    })
  }

  async waitForPendingReplies(conversationId: string): Promise<void> {
    const pending = [...(this.pendingReplies.get(conversationId) ?? [])]
    if (pending.length) await Promise.allSettled(pending)
  }

  private async queryBinding(event?: DigitalEmployeeEvent): Promise<Record<string, unknown>> {
    const employee = this.options.employee
    const result = (await this.execJson(
      [
        '--profile',
        employee.dwsProfile,
        'dingtalk-tag',
        'channel',
        'binding',
        '--channel',
        'dsh',
        '--stdin',
        '--format',
        'json',
      ],
      {
        agentUuid: employee.agentUuid,
        bindingRevision: employee.bindingRevision ?? 0,
        ...(event ? { senderOpenDingTalkId: event.senderOpenDingTalkId, senderName: event.senderName } : {}),
        ...(event && this.useGroupMembershipAccess ? { conversationType: event.conversationType } : {}),
      },
    )) as Record<string, unknown>
    if (
      result.agentUuid !== employee.agentUuid ||
      result.dwsProfile !== employee.dwsProfile ||
      result.channel !== 'dsh' ||
      result.bindingRevision !== (employee.bindingRevision ?? 0) ||
      result.bindingState !== 'bound' ||
      result.desiredState !== 'running'
    )
      throw new Error('binding_not_authorized')
    return result
  }

  async verifyBinding(): Promise<void> {
    await this.queryBinding()
  }

  async visibilityAccess(event: DigitalEmployeeEvent): Promise<boolean | undefined> {
    if (!this.useVisibilityAccess) return undefined
    const result = await this.queryBinding(event)
    if (result.accessPolicy === 'local_allowlist') return undefined
    if (result.accessPolicy !== 'deap_visibility' || typeof result.allowed !== 'boolean') {
      throw new Error('invalid_visibility_access')
    }
    return result.allowed
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

  async drain(): Promise<void> {
    while (this.activeCalls.size) await Promise.allSettled([...this.activeCalls])
  }

  private execJson(args: string[], input?: unknown): Promise<unknown> {
    const call = this.runJson(args, input)
    this.activeCalls.add(call)
    void call.finally(() => this.activeCalls.delete(call)).catch(() => undefined)
    return call
  }

  private runJson(args: string[], input?: unknown): Promise<unknown> {
    const command = this.options.dwsCommand ?? 'dws'
    const commandArgs = [...(this.options.dwsArgsPrefix ?? []), ...args]
    return new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
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
          // chat 仍使用其当前输出契约；两个通用 chat 发送入口接受直接回执。
          if (
            args.includes('--wait-delivery') &&
            (args.includes('+messages-reply') || args.includes('+messages-send')) &&
            !('ok' in envelope) &&
            !('error' in envelope) &&
            typeof envelope.openMessageId === 'string'
          ) {
            resolve(envelope)
            return
          }
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
      else if (typeof input === 'string') child.stdin.end(input)
      else child.stdin.end(`${JSON.stringify(input)}\n`)
    })
  }
}
