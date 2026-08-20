import path from 'node:path'

import type { AccountConfig, Config } from './config.js'
import type { GroupAccess, SenderAccess } from './setup-state.js'

export const DEFAULT_ACCOUNT_ID = 'default'
const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

export interface AccountCredentialRefs {
  clientIdRef: string
  clientSecretRef: string
}

export interface ConfiguredAccountSpec extends AccountCredentialRefs {
  id: string
  enabled: boolean
  clientId: string
  clientSecret: string
  ownerStaffId: string
  senderAccess: SenderAccess
  allowedSenders: string[]
  groupAccess: GroupAccess
  groupAllowlist: string[]
  sessionScope: 'chat' | 'chat-sender'
}

export interface RuntimeAccount extends ConfiguredAccountSpec {
  clientId: string
  clientSecret: string
}

export interface RuntimeAccountResolution {
  accounts: RuntimeAccount[]
  duplicateAccountIds: string[]
  missingCredentialAccountIds: string[]
}

export function assertAccountId(accountId: string): string {
  const id = accountId.trim()
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new Error(
      `机器人标识 ${JSON.stringify(accountId)} 无效；请使用小写字母开头的字母、数字或连字符（最长 32 位）`,
    )
  }
  return id
}

export function accountCredentialRefs(accountId: string): AccountCredentialRefs {
  const id = assertAccountId(accountId)
  if (id === DEFAULT_ACCOUNT_ID) {
    return { clientIdRef: 'DINGTALK_CLIENT_ID', clientSecretRef: 'DINGTALK_CLIENT_SECRET' }
  }
  const prefix = `DINGTALK_ACCOUNT_${id.toUpperCase().replaceAll('-', '_')}`
  return { clientIdRef: `${prefix}_CLIENT_ID`, clientSecretRef: `${prefix}_CLIENT_SECRET` }
}

export function accountStateDir(baseStateDir: string, accountId: string): string {
  const id = assertAccountId(accountId)
  return id === DEFAULT_ACCOUNT_ID ? baseStateDir : path.join(baseStateDir, 'accounts', id)
}

type AccountConfigInput = Partial<AccountConfig> & Pick<AccountConfig, 'id'>
type ConfigInput = Pick<Config, 'clientId' | 'clientSecret' | 'ownerStaffId' | 'groupAllowlist'> &
  Partial<Pick<Config, 'senderAccess' | 'allowedSenders' | 'groupAccess' | 'sessionScope'>> & {
    accounts: AccountConfigInput[]
  }

/**
 * 把新版 accounts[] 与旧版根级单账号配置归一成统一运行规格。
 * 根级配置只作为 accounts[] 为空时的兼容入口。
 */
export function configuredAccountSpecs(config: ConfigInput): ConfiguredAccountSpec[] {
  if (!config.accounts?.length) {
    return [
      {
        id: DEFAULT_ACCOUNT_ID,
        enabled: true,
        clientId: config.clientId.trim(),
        clientSecret: config.clientSecret.trim(),
        ...accountCredentialRefs(DEFAULT_ACCOUNT_ID),
        ownerStaffId: config.ownerStaffId.trim(),
        senderAccess: config.senderAccess ?? 'owner',
        allowedSenders: config.allowedSenders?.filter(Boolean) ?? [],
        groupAccess: config.groupAccess ?? (config.groupAllowlist.length ? 'allowlist' : 'none'),
        groupAllowlist: config.groupAllowlist.filter(Boolean),
        sessionScope: config.sessionScope ?? 'chat',
      },
    ]
  }

  const seen = new Set<string>()
  const result: ConfiguredAccountSpec[] = []
  for (const raw of config.accounts) {
    const id = assertAccountId(raw.id)
    if (seen.has(id)) throw new Error(`检测到重复的钉钉机器人标识：${id}`)
    seen.add(id)
    if (raw.enabled === false) continue
    const refs = accountCredentialRefs(id)
    const useLegacyRoot = id === DEFAULT_ACCOUNT_ID
    const groupAllowlist = raw.groupAllowlist?.filter(Boolean) ?? (useLegacyRoot ? config.groupAllowlist : [])
    const groupAccess =
      raw.groupAccess ??
      (useLegacyRoot
        ? (config.groupAccess ?? (groupAllowlist.length ? 'allowlist' : 'none'))
        : groupAllowlist.length
          ? 'allowlist'
          : 'none')
    result.push({
      id,
      enabled: true,
      clientId: raw.clientId?.trim() ?? '',
      clientSecret: raw.clientSecret?.trim() ?? '',
      clientIdRef: raw.clientIdRef?.trim() || refs.clientIdRef,
      clientSecretRef: raw.clientSecretRef?.trim() || refs.clientSecretRef,
      ownerStaffId: raw.ownerStaffId?.trim() ?? '',
      senderAccess: raw.senderAccess ?? (useLegacyRoot ? (config.senderAccess ?? 'owner') : 'owner'),
      allowedSenders: raw.allowedSenders?.filter(Boolean) ?? (useLegacyRoot ? (config.allowedSenders ?? []) : []),
      groupAccess,
      groupAllowlist,
      sessionScope:
        raw.sessionScope ??
        (useLegacyRoot ? (config.sessionScope ?? 'chat') : groupAccess === 'none' ? 'chat' : 'chat-sender'),
    })
  }
  return result
}

/** 解析每个机器人的安全凭据；单个机器人缺失或重复不会拖垮其他机器人。 */
export async function resolveRuntimeAccounts(
  specs: ConfiguredAccountSpec[],
  resolveCredential: (ref: string) => Promise<string>,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeAccountResolution> {
  const accounts: RuntimeAccount[] = []
  const duplicateAccountIds: string[] = []
  const missingCredentialAccountIds: string[] = []
  const seenClientIds = new Set<string>()
  for (const spec of specs) {
    const clientId = spec.clientId || (await resolveCredential(spec.clientIdRef)) || env[spec.clientIdRef] || ''
    const clientSecret =
      spec.clientSecret || (await resolveCredential(spec.clientSecretRef)) || env[spec.clientSecretRef] || ''
    if (!clientId || !clientSecret) {
      missingCredentialAccountIds.push(spec.id)
      continue
    }
    if (seenClientIds.has(clientId)) {
      duplicateAccountIds.push(spec.id)
      continue
    }
    seenClientIds.add(clientId)
    accounts.push({ ...spec, clientId, clientSecret })
  }
  return { accounts, duplicateAccountIds, missingCredentialAccountIds }
}
