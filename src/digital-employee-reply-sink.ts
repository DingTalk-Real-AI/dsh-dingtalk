import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { DigitalEmployeeAuditFields } from './digital-employee-audit.js'
import type { DigitalEmployeeLedger } from './digital-employee-ledger.js'
import type { DigitalEmployeeConfig } from './setup-state.js'
import type { DigitalEmployeeEvent, DigitalEmployeeReplyResult } from './digital-employee-types.js'

const MAX_JSON_OUTPUT_BYTES = 256 * 1024

class DwsCommandError extends Error {
  constructor(
    code: number | null,
    readonly deliveryUnknown: boolean,
  ) {
    super(`dws_exit_${code ?? 'unknown'}`)
  }
}

// 仅信任当前 DWS 的结构化分类，不保留或传播服务端自由文本。
function isDeliveryUnknown(stderr: string): boolean {
  try {
    const envelope = JSON.parse(stderr)
    const error = envelope?.error
    return (
      error?.code === 5 &&
      error.category === 'internal' &&
      error.reason === 'delivery_unknown' &&
      error.retryable === false
    )
  } catch {
    return false
  }
}

function validReply(result: unknown, conversationId: string, key: string): result is DigitalEmployeeReplyResult {
  if (!result || typeof result !== 'object') return false
  const raw = result as Record<string, unknown>
  return (
    typeof raw.openMessageId === 'string' &&
    raw.openMessageId.trim() !== '' &&
    raw.conversationId === conversationId &&
    (raw.deliveryStatus === 'delivered' || raw.deliveryStatus === 'unknown') &&
    raw.idempotencyKey === key
  )
}

interface DwsCapabilities {
  schemaVersion: 1
  protocolVersion: 1
  auditMode: 'local_required'
  capabilities: {
    eventConsume: true
    chatDelivery: true
    bindingAccessPolicy: true
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
  log?: (line: string) => void
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
  private bindingAccessPolicySupported = false
  private accessPolicy?: 'platform' | 'local_allowlist'
  private selfOpenDingTalkId?: string
  private readonly activeCalls = new Set<Promise<unknown>>()
  private readonly pendingReplies = new Map<string, Set<Promise<unknown>>>()

  constructor(private readonly options: DwsDigitalEmployeeReplySinkOptions) {}

  reply(
    event: DigitalEmployeeEvent,
    sessionId: string,
    text: string,
    purpose = 'reply',
  ): Promise<DigitalEmployeeReplyResult> {
    // 等待整个处理链，避免原命令结束到通知启动之间被 drain 或后续消息越过。
    const operation = this.trackCall(this.runReply(event, sessionId, text, purpose))
    this.trackPendingReply(event.conversationId, operation)
    void operation.finally(() => this.untrackPendingReply(event.conversationId, operation)).catch(() => undefined)
    return operation
  }

  private replyArgs(event: DigitalEmployeeEvent, key: string): string[] {
    return [
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
    ]
  }

  private async runReply(
    event: DigitalEmployeeEvent,
    sessionId: string,
    text: string,
    purpose: string,
  ): Promise<DigitalEmployeeReplyResult> {
    const key = idempotencyKey(this.options.employee, event, purpose)
    let result: unknown
    try {
      result = await this.execJson(this.replyArgs(event, key), text)
    } catch (error) {
      this.options.onFailure('reply_failed')
      if (error instanceof DwsCommandError && error.deliveryUnknown) {
        await this.notifyDeliveryUnknown(event, sessionId)
      }
      throw error
    }
    if (!validReply(result, event.conversationId, key)) {
      this.options.onFailure('invalid_reply_result')
      throw new Error('invalid_reply_result')
    }
    this.options.ledger.markSentMessage(result.openMessageId)
    this.options.onReply()
    await this.audit({
      eventId: event.eventId,
      sessionId,
      operationType: purpose,
      status: result.deliveryStatus,
      replyMessageId: result.openMessageId,
    })
    return result
  }

  private async notifyDeliveryUnknown(event: DigitalEmployeeEvent, sessionId: string): Promise<void> {
    const key = idempotencyKey(this.options.employee, event, 'delivery-failure-notice')
    const diagnosticId = `DE-${key.slice(0, 16)}`
    const fields = { eventId: event.eventId, sessionId, diagnosticId, failureCode: 'delivery_unknown' }
    this.logFailureNotice(diagnosticId, 'original_delivery_unknown')
    // 无审计或无持久去重时不发送；所有通知失败都保留原业务错误，不再次进入 reply。
    try {
      await this.audit({ ...fields, operationType: 'reply_delivery_unknown', status: 'failed' })
      if (!this.options.ledger.claimFailureNotice(key)) {
        this.logFailureNotice(diagnosticId, 'already_attempted')
        return
      }
      await this.audit({ ...fields, operationType: 'delivery_failure_notice', status: 'claimed' })
    } catch {
      this.logFailureNotice(diagnosticId, 'preparation_failed')
      return
    }
    const text =
      '限定时间内（最长2秒）仍无法确认回复是否送达，数字员工已暂停后续处理。' +
      '原回复可能已经送达，请先核对会话，请勿重复执行。' +
      `请联系维护者，并提供错误类型 delivery_unknown 及排查编号：${diagnosticId}`
    let status = 'failed'
    let replyMessageId: string | undefined
    try {
      const result = await this.execJson(this.replyArgs(event, key), text)
      if (validReply(result, event.conversationId, key)) {
        this.options.ledger.markSentMessage(result.openMessageId)
        status = result.deliveryStatus
        replyMessageId = result.openMessageId
      }
    } catch (error) {
      if (error instanceof DwsCommandError && error.deliveryUnknown) status = 'unknown'
    }
    this.logFailureNotice(diagnosticId, status)
    try {
      await this.audit({ ...fields, operationType: 'delivery_failure_notice', status, replyMessageId })
    } catch {
      this.logFailureNotice(diagnosticId, 'result_audit_failed')
    }
  }

  private logFailureNotice(diagnosticId: string, status: string): void {
    try {
      this.options.log?.(
        `delivery_failure_notice diagnosticId=${diagnosticId} failureCode=delivery_unknown status=${status}`,
      )
    } catch {
      // 日志回调异常不能覆盖原错误，或触发额外 IM 消息。
    }
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
      capabilities.chatDelivery !== true ||
      capabilities.bindingAccessPolicy !== true
    ) {
      this.options.onFailure('incompatible_dws_capabilities')
      throw new Error(
        'incompatible_dws_capabilities: 请升级 DWS，数字员工要求 chatDelivery=true 和 bindingAccessPolicy=true',
      )
    }
    this.bindingAccessPolicySupported = true
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

  private async queryBinding(): Promise<Record<string, unknown>> {
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
    this.accessPolicy = undefined
    this.selfOpenDingTalkId = undefined
    if (!this.bindingAccessPolicySupported) {
      throw new Error('incompatible_dws_capabilities: 请先探测并升级支持 bindingAccessPolicy=true 的 DWS')
    }
    const result = await this.queryBinding()
    if (result.accessPolicy !== 'platform' && result.accessPolicy !== 'local_allowlist') {
      throw new Error('invalid_binding_access_policy: 请升级 DWS，绑定须返回 platform 或 local_allowlist')
    }
    const self = result.selfOpenDingTalkId
    if (
      (result.accessPolicy === 'platform' || self !== undefined) &&
      (typeof self !== 'string' ||
        !self.trim() ||
        self.trim() !== self ||
        self.length > 512 ||
        /[\u0000-\u001f]/.test(self))
    ) {
      throw new Error('invalid_binding_self_identity: 请检查 DWS 员工自身身份后重启')
    }
    this.selfOpenDingTalkId = self as string | undefined
    this.accessPolicy = result.accessPolicy
  }

  isSelfMessage(event: DigitalEmployeeEvent): boolean {
    return event.senderOpenDingTalkId === this.selfOpenDingTalkId
  }

  requiresGroupMention(): boolean {
    return this.bindingAccessPolicy() === 'platform'
  }

  bindingAccessPolicy(): 'platform' | 'local_allowlist' {
    if (!this.accessPolicy) throw new Error('binding_access_policy_unverified')
    return this.accessPolicy
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
    return this.trackCall(this.runJson(args, input))
  }

  private trackCall<T>(call: Promise<T>): Promise<T> {
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
      const stderrChunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (Buffer.byteLength(stdout) > MAX_JSON_OUTPUT_BYTES) child.kill('SIGTERM')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > MAX_JSON_OUTPUT_BYTES) child.kill('SIGTERM')
        else stderrChunks.push(chunk)
      })
      child.once('error', () => reject(new Error('dws_spawn_failed')))
      child.once('close', (code) => {
        if (code !== 0) {
          reject(
            new DwsCommandError(
              code,
              code === 5 &&
                stderrBytes <= MAX_JSON_OUTPUT_BYTES &&
                isDeliveryUnknown(Buffer.concat(stderrChunks).toString('utf8')),
            ),
          )
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
