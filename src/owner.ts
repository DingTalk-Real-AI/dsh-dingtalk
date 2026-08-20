import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { InboundMessage } from './stream.js'
import type { GroupAccess, SenderAccess } from './setup-state.js'

interface BindingChallenge {
  salt: string
  hash: string
  expiresAt: number
}

interface OwnerState {
  ownerStaffId?: string
  challenge?: BindingChallenge
}

export interface BindingChallengeResult {
  code: string
  expiresAt: number
}

export interface OwnerBindingOptions {
  file: string
  configuredOwner: string
  legacyAllowedSenders: string[]
  senderAccess?: SenderAccess
  allowedSenders?: string[]
  groupAccess?: GroupAccess
  allowedGroups: string[]
  now?: () => number
}

export type AccessDecision =
  { kind: 'allowed' } | { kind: 'bound'; ownerStaffId: string } | { kind: 'denied'; reason: string }

export interface OwnerBindingStatus {
  bound: boolean
  ownerStaffId?: string
  senderAccess: SenderAccess
  allowedSenderCount: number
  groupAccess: GroupAccess
  allowedGroupCount: number
  challengeReady: boolean
}

function hashCode(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex')
}

function readState(file: string): OwnerState {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as OwnerState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(file: string, state: OwnerState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

function codeMatches(challenge: BindingChallenge, candidate: string): boolean {
  const expected = Buffer.from(challenge.hash, 'hex')
  const actual = Buffer.from(hashCode(challenge.salt, candidate), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function normalizeBindingCommand(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .trim()
}

/**
 * 创建一次性管理员绑定口令。明文口令只通过返回值交给本机调用者，磁盘仅保存加盐摘要。
 */
export function issueBindingChallenge(file: string, ttlMs = 10 * 60_000, now = Date.now()): BindingChallengeResult {
  const code = randomBytes(4).toString('hex').toUpperCase()
  const salt = randomBytes(16).toString('hex')
  const expiresAt = now + ttlMs
  const state = readState(file)
  state.challenge = { salt, hash: hashCode(salt, code), expiresAt }
  writeState(file, state)
  return { code, expiresAt }
}

export class OwnerBinding {
  private readonly file: string
  private readonly configuredOwner: string
  private readonly senderAccess: SenderAccess
  private readonly allowedSenders: Set<string>
  private readonly groupAccess: GroupAccess
  private readonly allowedGroups: Set<string>
  private readonly now: () => number
  private state: OwnerState

  constructor(options: OwnerBindingOptions) {
    this.file = options.file
    this.configuredOwner = options.configuredOwner.trim()
    this.senderAccess = options.senderAccess ?? 'owner'
    this.allowedSenders = new Set((options.allowedSenders ?? []).filter(Boolean))
    this.allowedGroups = new Set(options.allowedGroups.filter(Boolean))
    this.groupAccess = options.groupAccess ?? (this.allowedGroups.size ? 'allowlist' : 'none')
    this.now = options.now ?? Date.now
    this.state = readState(this.file)

    // 兼容旧配置：只有一个 allowedSender 时，可无歧义地迁移为管理员。
    if (
      this.senderAccess === 'owner' &&
      !this.configuredOwner &&
      !this.state.ownerStaffId &&
      options.legacyAllowedSenders.length === 1
    ) {
      this.state.ownerStaffId = options.legacyAllowedSenders[0]
      delete this.state.challenge
      writeState(this.file, this.state)
    }
  }

  authorize(
    message: Pick<InboundMessage, 'conversationType' | 'conversationId' | 'senderStaffId' | 'text'>,
  ): AccessDecision {
    // setup 通常从独立 CLI 进程写入 challenge；每条消息重读这个极小文件，
    // 使正在运行的 Connector 无需重启即可完成首次绑定。
    if (!this.configuredOwner) this.state = readState(this.file)
    const ownerStaffId = this.configuredOwner || this.state.ownerStaffId
    if (!ownerStaffId) return this.tryBind(message)

    const senderAllowed =
      message.senderStaffId === ownerStaffId ||
      this.senderAccess === 'all' ||
      (this.senderAccess === 'allowlist' && this.allowedSenders.has(message.senderStaffId))
    if (!senderAllowed) {
      return { kind: 'denied', reason: 'sender-not-allowed' }
    }
    if (message.conversationType === 'direct') return { kind: 'allowed' }
    if (this.groupAccess === 'all') return { kind: 'allowed' }
    if (this.groupAccess === 'allowlist' && this.allowedGroups.has(message.conversationId)) {
      return { kind: 'allowed' }
    }
    return { kind: 'denied', reason: 'group-not-allowed' }
  }

  status(): OwnerBindingStatus {
    const challenge = this.state.challenge
    return {
      bound: Boolean(this.configuredOwner || this.state.ownerStaffId),
      ownerStaffId: this.configuredOwner || this.state.ownerStaffId,
      senderAccess: this.senderAccess,
      allowedSenderCount: this.allowedSenders.size,
      groupAccess: this.groupAccess,
      allowedGroupCount: this.allowedGroups.size,
      challengeReady: Boolean(challenge && challenge.expiresAt >= this.now()),
    }
  }

  private tryBind(
    message: Pick<InboundMessage, 'conversationType' | 'conversationId' | 'senderStaffId' | 'text'>,
  ): AccessDecision {
    if (message.conversationType !== 'direct') {
      return { kind: 'denied', reason: 'binding-requires-direct-message' }
    }

    const command = normalizeBindingCommand(message.text)
    const match = command.match(/^\/bind\s+([A-Za-z0-9]+)$/)
    if (!match) {
      return {
        kind: 'denied',
        reason: /^\/bind(?:\s|$)/.test(command) ? 'binding-command-malformed' : 'owner-not-bound',
      }
    }

    const challenge = this.state.challenge
    if (!challenge || challenge.expiresAt < this.now()) {
      return { kind: 'denied', reason: 'binding-code-expired-or-missing' }
    }
    if (!codeMatches(challenge, match[1].toUpperCase())) {
      return { kind: 'denied', reason: 'binding-code-invalid' }
    }

    this.state.ownerStaffId = message.senderStaffId
    delete this.state.challenge
    writeState(this.file, this.state)
    return { kind: 'bound', ownerStaffId: message.senderStaffId }
  }
}
