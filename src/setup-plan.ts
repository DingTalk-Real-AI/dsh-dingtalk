import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { accountCredentialRefs, accountStateDir, assertAccountId, DEFAULT_ACCOUNT_ID } from './accounts.js'
import { isSupportedNodeVersion } from './node-version.js'
import { loadDingTalkAccountCredentials, loadWebProfileConfig, type WebProfileAccount } from './setup-state.js'
import type { CommandResult, CommandRunner } from './setup.js'

export interface SetupServiceStatus {
  webStatus: 'running' | 'stopped' | 'unknown'
}

export interface InspectSetupOptions {
  runner: CommandRunner
  dshHome: string
  stateDir: string
  installSpec: string
  service: SetupServiceStatus
  nodeVersion?: string
}

export interface SetupSnapshotAccount {
  id: string
  enabled: boolean
  credentialsConfigured: boolean
  bound: boolean
}

export interface SetupSnapshot {
  schemaVersion: 1
  kind: 'setup-snapshot'
  node: { version: string; supported: boolean }
  dsh: { installed: boolean; version: string | null }
  pnpm: { installed: boolean; version: string | null; supported: boolean }
  accounts: SetupSnapshotAccount[]
  web: { status: 'running' | 'stopped' | 'unknown' }
  plugin: { installSpecFingerprint: string }
}

export interface SetupPlanRequest {
  accountId?: string
}

export type SetupPlanActionId =
  | 'install-dsh'
  | 'install-pnpm'
  | 'install-plugin'
  | 'private-credentials'
  | 'write-profile'
  | 'private-binding'
  | 'start-web'
  | 'restart-web'

export interface SetupPlanAction {
  id: SetupPlanActionId
  type: 'install' | 'write' | 'private' | 'service'
  executor: 'machine' | 'human'
  requiresApproval: boolean
  accountId?: string
}

export type SetupPlanQuestion =
  { id: 'account'; type: 'select'; options: string[] } | { id: 'credentials'; type: 'credentials'; accountId: string }

export interface SetupPlanBlocker {
  id: 'unsupported-node' | 'invalid-account'
  detail: string
}

export interface SetupAnswerTemplate {
  schemaVersion: 1
  planId: string
  accountId: string
  approvals: {
    installDsh: boolean | null
    installPnpm: boolean | null
    installPlugin: boolean | null
    writeProfile: boolean | null
  }
  features: {
    dwsEnabled: null
    imageMode: null
    senderAccess: null
    allowedSenders: string[]
    groupAccess: null
    groupAllowlist: string[]
  }
}

export interface SetupAnswerContract {
  secretsAccepted: false
  missingValues: 'reject'
  imageMode: readonly ['auto', 'always', 'never']
  senderAccess: readonly ['all', 'owner', 'allowlist']
  groupAccess: readonly ['all', 'none', 'allowlist']
}

export interface SetupPlan {
  schemaVersion: 1
  kind: 'setup-plan'
  planId: string
  fingerprint: string
  status: 'ready' | 'needs_input' | 'blocked'
  accountId?: string
  snapshot: SetupSnapshot
  actions: SetupPlanAction[]
  questions: SetupPlanQuestion[]
  requiredApprovals: SetupPlanActionId[]
  blockers: SetupPlanBlocker[]
  answerTemplate?: SetupAnswerTemplate
  answerContract: SetupAnswerContract
}

function cleanVersion(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  let candidate = trimmed
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string') candidate = parsed.trim()
  } catch {
    // 普通版本输出不是 JSON，继续按首个 token 处理。
  }
  const version = candidate.replace(/^v/, '').split(/\s+/)[0] ?? ''
  return /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version) ? version : ''
}

function probeVersion(runner: CommandRunner, command: string): { installed: boolean; version: string | null } {
  let result: CommandResult
  try {
    result = runner.run(command, ['--version'])
  } catch {
    return { installed: false, version: null }
  }
  if (result.code !== 0) return { installed: false, version: null }
  const version = cleanVersion(result.stdout)
  return { installed: true, version: version || null }
}

async function hasBoundOwner(file: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const ownerStaffId = (value as Record<string, unknown>).ownerStaffId
    return typeof ownerStaffId === 'string' && Boolean(ownerStaffId.trim())
  } catch {
    return false
  }
}

function snapshotAccounts(profileAccounts: WebProfileAccount[]): WebProfileAccount[] {
  if (profileAccounts.length) {
    return [...profileAccounts].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }
  return [
    {
      id: DEFAULT_ACCOUNT_ID,
      enabled: true,
      ...accountCredentialRefs(DEFAULT_ACCOUNT_ID),
    },
  ]
}

export async function inspectSetup(options: InspectSetupOptions): Promise<SetupSnapshot> {
  const rawNodeVersion = options.nodeVersion ?? process.versions.node
  const nodeVersion = cleanVersion(rawNodeVersion) || 'unknown'
  const dsh = probeVersion(options.runner, 'dsh')
  const pnpmProbe = probeVersion(options.runner, 'pnpm')
  const pnpmMajor = Number(pnpmProbe.version?.split('.')[0])
  const profile = await loadWebProfileConfig(options.dshHome)
  const accounts = await Promise.all(
    snapshotAccounts(profile.accounts).map(async (account): Promise<SetupSnapshotAccount> => {
      const credentials = await loadDingTalkAccountCredentials(options.dshHome, account.id, account)
      const configuredOwner = account.ownerStaffId || (account.id === DEFAULT_ACCOUNT_ID ? profile.ownerStaffId : '')
      const bound =
        Boolean(configuredOwner?.trim()) ||
        (await hasBoundOwner(path.join(accountStateDir(options.stateDir, account.id), 'owner.json')))
      return {
        id: account.id,
        enabled: account.enabled,
        credentialsConfigured: Boolean(credentials?.clientId && credentials.clientSecret),
        bound,
      }
    }),
  )

  return {
    schemaVersion: 1,
    kind: 'setup-snapshot',
    node: { version: nodeVersion, supported: nodeVersion !== 'unknown' && isSupportedNodeVersion(nodeVersion) },
    dsh,
    pnpm: {
      ...pnpmProbe,
      supported: pnpmProbe.installed && Number.isFinite(pnpmMajor) && pnpmMajor >= 11,
    },
    accounts,
    web: { status: options.service.webStatus },
    plugin: {
      installSpecFingerprint: createHash('sha256').update(options.installSpec).digest('hex'),
    },
  }
}

function action(id: SetupPlanActionId, type: SetupPlanAction['type'], accountId?: string): SetupPlanAction {
  const executor = type === 'private' || type === 'service' ? 'human' : 'machine'
  const requiresApproval = executor === 'machine'
  const value: SetupPlanAction = { id, type, executor, requiresApproval }
  return accountId ? { ...value, accountId } : value
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function createSetupPlan(snapshot: SetupSnapshot, request: SetupPlanRequest = {}): SetupPlan {
  const blockers: SetupPlanBlocker[] = []
  let accountId: string | undefined
  if (request.accountId !== undefined) {
    try {
      accountId = assertAccountId(request.accountId)
    } catch {
      blockers.push({ id: 'invalid-account', detail: 'accountId 不符合钉钉机器人标识规则' })
    }
  } else if (snapshot.accounts.length === 1) {
    accountId = snapshot.accounts[0].id
  }
  if (!snapshot.node.supported) {
    blockers.push({ id: 'unsupported-node', detail: 'Node.js 版本不满足 ^22.19.0 或 >=24.0.0' })
  }

  const actions: SetupPlanAction[] = []
  const questions: SetupPlanQuestion[] = []
  if (!blockers.length) {
    if (!snapshot.dsh.installed) actions.push(action('install-dsh', 'install'))
    if (!snapshot.pnpm.supported) actions.push(action('install-pnpm', 'install'))
    actions.push(action('install-plugin', 'install'))

    if (!accountId) {
      questions.push({
        id: 'account',
        type: 'select',
        options: snapshot.accounts.map((account) => account.id),
      })
    } else {
      const account = snapshot.accounts.find((candidate) => candidate.id === accountId)
      if (!account?.credentialsConfigured) {
        actions.push(action('private-credentials', 'private', accountId))
        questions.push({ id: 'credentials', type: 'credentials', accountId })
      }
      actions.push(action('write-profile', 'write', accountId))
      if (!account?.bound) actions.push(action('private-binding', 'private', accountId))
    }
    actions.push(action(snapshot.web.status === 'stopped' ? 'start-web' : 'restart-web', 'service'))
  }

  const status: SetupPlan['status'] = blockers.length ? 'blocked' : questions.length ? 'needs_input' : 'ready'
  const requiredApprovals = actions.filter((item) => item.requiresApproval).map((item) => item.id)
  const fingerprintInput = {
    schemaVersion: 1,
    kind: 'setup-plan',
    status,
    accountId,
    snapshot,
    actions,
    questions,
    requiredApprovals,
    blockers,
  }
  const fingerprint = createHash('sha256').update(stableJson(fingerprintInput)).digest('hex')
  const planId = `setup-plan-${fingerprint.slice(0, 16)}`
  const actionIds = new Set(actions.map((item) => item.id))
  const answerTemplate: SetupAnswerTemplate | undefined =
    accountId && !blockers.length
      ? {
          schemaVersion: 1,
          planId,
          accountId,
          approvals: {
            installDsh: actionIds.has('install-dsh') ? null : false,
            installPnpm: actionIds.has('install-pnpm') ? null : false,
            installPlugin: actionIds.has('install-plugin') ? null : false,
            writeProfile: actionIds.has('write-profile') ? null : false,
          },
          features: {
            dwsEnabled: null,
            imageMode: null,
            senderAccess: null,
            allowedSenders: [],
            groupAccess: null,
            groupAllowlist: [],
          },
        }
      : undefined
  return {
    schemaVersion: 1,
    kind: 'setup-plan',
    planId,
    fingerprint,
    status,
    ...(accountId ? { accountId } : {}),
    snapshot,
    actions,
    questions,
    requiredApprovals,
    blockers,
    ...(answerTemplate ? { answerTemplate } : {}),
    answerContract: {
      secretsAccepted: false,
      missingValues: 'reject',
      imageMode: ['auto', 'always', 'never'],
      senderAccess: ['all', 'owner', 'allowlist'],
      groupAccess: ['all', 'none', 'allowlist'],
    },
  }
}

export async function inspectAndPlanSetup(
  options: InspectSetupOptions,
  request: SetupPlanRequest = {},
): Promise<SetupPlan> {
  return createSetupPlan(await inspectSetup(options), request)
}
