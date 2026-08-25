import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isMap, parse, parseDocument, stringify, YAMLMap } from 'yaml'
import {
  accountCredentialRefs,
  assertAccountCredentialRefs,
  assertAccountId,
  DEFAULT_ACCOUNT_ID,
  type AccountCredentialRefs,
} from './accounts.js'
import type { DingTalkAppCredentials } from './credentials.js'
import { withRecoverableFileLock } from './file-lock.js'

export interface DingTalkCredentials extends DingTalkAppCredentials {
  source: 'credentials' | 'legacy-env'
}

export type ImageMode = 'auto' | 'always' | 'never'
export type SenderAccess = 'all' | 'owner' | 'allowlist'
export type GroupAccess = 'all' | 'none' | 'allowlist'

export interface WebProfileConfig {
  dwsEnabled: boolean
  imageMode: ImageMode
  interactionCardTemplateId: string
  ownerStaffId: string
  senderAccess: SenderAccess
  allowedSenders: string[]
  groupAccess: GroupAccess
  groupAllowlist: string[]
  sessionScope: 'chat' | 'chat-sender'
  accounts: WebProfileAccount[]
}

export interface WebProfileAccount extends AccountCredentialRefs {
  id: string
  enabled: boolean
  ownerStaffId?: string
  senderAccess?: SenderAccess
  allowedSenders?: string[]
  groupAccess?: GroupAccess
  groupAllowlist?: string[]
  sessionScope?: 'chat' | 'chat-sender'
}

export interface WebProfileUpdate {
  dwsEnabled: boolean
  imageMode: ImageMode
  interactionCardTemplateId?: string
  senderAccess?: SenderAccess
  allowedSenders?: string[]
  groupAccess?: GroupAccess
  groupAllowlist?: string[]
  sessionScope?: 'chat' | 'chat-sender'
}

export interface WebProfileAccountAccess {
  senderAccess: SenderAccess
  allowedSenders: string[]
  groupAccess: GroupAccess
  groupAllowlist: string[]
  sessionScope: 'chat' | 'chat-sender'
}

const CLIENT_ID_REF = 'DINGTALK_CLIENT_ID'
const CLIENT_SECRET_REF = 'DINGTALK_CLIENT_SECRET'

function credentialsPath(dshHome: string): string {
  return path.join(dshHome, '.credentials.yaml')
}

function legacyEnvPath(dshHome: string): string {
  return path.join(dshHome, '.env')
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function assertPrivateFile(file: string): Promise<void> {
  if (process.platform === 'win32') return
  const info = await stat(file)
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`凭据文件 ${file} 的权限过宽；请先执行 chmod 600 ${file}`)
  }
}

interface CredentialDocument {
  refs: Record<string, string>
  setRef(key: string, value: string): void
  serialize(): string
}

function validateCredentialRefs(value: unknown, file: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`凭据文件 ${file} 的 refs 必须是 YAML mapping`)
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`凭据文件 ${file} 包含无效条目 ${key}`)
    }
  }
  return value as Record<string, string>
}

function assertCredentialRecordFields(
  key: string,
  fields: Record<string, unknown>,
  allowed: readonly string[],
  file: string,
): void {
  for (const field of Object.keys(fields)) {
    if (!allowed.includes(field)) {
      throw new Error(`凭据文件 ${file} 的 record ${key} 包含未知字段 ${field}`)
    }
  }
}

function assertJsonCredentialValue(value: unknown, key: string, file: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new Error(`凭据文件 ${file} 的 record ${key} payload 包含非有限数字`)
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error(`凭据文件 ${file} 的 record ${key} payload 包含循环引用`)
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertJsonCredentialValue(nested, key, file, seen)
      seen.delete(value)
      return
    }
  }
  throw new Error(`凭据文件 ${file} 的 record ${key} payload 不是 JSON 可表示的值`)
}

function validateCredentialRecords(value: unknown, file: string): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`凭据文件 ${file} 的 records 必须是 YAML mapping`)
  }
  for (const [key, record] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(key)) {
      throw new Error(`凭据文件 ${file} 包含无效的 record key ${key}`)
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new Error(`凭据文件 ${file} 的 record ${key} 必须是 YAML mapping`)
    }
    const fields = record as Record<string, unknown>
    if (fields.kind === 'api-key') {
      assertCredentialRecordFields(key, fields, ['kind', 'key', 'env'], file)
      if (fields.key !== undefined && (typeof fields.key !== 'string' || fields.key.length === 0)) {
        throw new Error(`凭据文件 ${file} 的 record ${key} 包含无效的 api-key key`)
      }
      if (fields.env !== undefined) {
        if (typeof fields.env !== 'object' || fields.env === null || Array.isArray(fields.env)) {
          throw new Error(`凭据文件 ${file} 的 record ${key} env 必须是 YAML mapping`)
        }
        for (const [name, entry] of Object.entries(fields.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string' || entry.length === 0) {
            throw new Error(`凭据文件 ${file} 的 record ${key} 包含无效 env 条目 ${name}`)
          }
        }
      }
      continue
    }
    if (fields.kind === 'grant') {
      assertCredentialRecordFields(key, fields, ['kind', 'payload'], file)
      if (!('payload' in fields)) throw new Error(`凭据文件 ${file} 的 record ${key} 缺少 payload`)
      assertJsonCredentialValue(fields.payload, key, file)
      continue
    }
    if (fields.kind === undefined) throw new Error(`凭据文件 ${file} 的 record ${key} 缺少 kind`)
    throw new Error(`凭据文件 ${file} 的 record ${key} 使用未知 kind`)
  }
}

function parseCredentialDocument(source: string | undefined, file: string): CredentialDocument {
  let document = parseDocument(source ?? '', { uniqueKeys: true })
  if (document.errors.length) {
    throw new Error(`凭据文件 ${file} 不是有效的 YAML 文档`)
  }

  let refsNode: YAMLMap
  let refs: Record<string, string>
  if (document.contents === null) {
    const commentBefore = document.commentBefore
    const comment = document.comment
    document = parseDocument('version: 1\nrefs: {}\n', { uniqueKeys: true })
    document.commentBefore = commentBefore
    document.comment = comment
    const createdRefs = document.get('refs', true)
    if (!isMap(createdRefs)) throw new Error(`无法初始化凭据文件 ${file}`)
    refsNode = createdRefs
    refs = {}
  } else {
    if (!isMap(document.contents)) throw new Error(`凭据文件 ${file} 必须是 YAML mapping`)
    const value = document.toJS() as Record<string, unknown>
    if ('version' in value) {
      if (value.version !== 1) throw new Error(`凭据文件 ${file} 使用不受支持的版本 ${String(value.version)}`)
      for (const key of Object.keys(value)) {
        if (key !== 'version' && key !== 'refs' && key !== 'records') {
          throw new Error(`凭据文件 ${file} 包含未知的顶层字段 ${key}`)
        }
      }
      validateCredentialRecords(value.records, file)
      refs = validateCredentialRefs(value.refs, file)
      const currentRefs = document.get('refs', true)
      if (value.refs === undefined || value.refs === null) {
        const createdMap = new YAMLMap()
        const currentComment = (currentRefs as { comment?: unknown } | undefined)?.comment
        if (typeof currentComment === 'string') createdMap.commentBefore = currentComment
        document.set('refs', createdMap)
        const createdRefs = document.get('refs', true)
        if (!isMap(createdRefs)) throw new Error(`无法初始化凭据文件 ${file} 的 refs`)
        refsNode = createdRefs
      } else {
        if (!isMap(currentRefs)) throw new Error(`凭据文件 ${file} 的 refs 必须是 YAML mapping`)
        refsNode = currentRefs
      }
    } else {
      refs = validateCredentialRefs(value, file)
      const legacyRefs = document.contents
      document = parseDocument('version: 1\nrefs: {}\n', { uniqueKeys: true })
      document.set('refs', legacyRefs)
      const migratedRefs = document.get('refs', true)
      if (!isMap(migratedRefs)) throw new Error(`无法迁移凭据文件 ${file}`)
      refsNode = migratedRefs
    }
  }

  return {
    refs,
    setRef(key, value) {
      refsNode.set(key, value)
    },
    serialize() {
      return document.toString({ lineWidth: 0 })
    },
  }
}

async function atomicPrivateWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function isFileLockContention(error: unknown, lockFile: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockFile)
    return true
  } catch {
    return false
  }
}

async function withFileLock<T>(file: string, label: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const lockFile = `${file}.lock`
  const deadline = Date.now() + 30_000
  let delay = 20
  for (;;) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!(await isFileLockContention(error, lockFile))) throw error
    }
    if (Date.now() >= deadline) throw new Error(`等待${label}写锁超时：${lockFile}`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 200)
  }
  try {
    return await operation()
  } finally {
    await rm(lockFile, { force: true })
  }
}

// 与 DSH dsh-atomic-write 共用 `<凭据文件>.lock` 协议，确保双方的读改写不会互相覆盖。
async function withCredentialFileLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(file, '凭据文件', operation)
}

async function withWebProfileLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return withRecoverableFileLock(`${file}.lock`, operation, { label: 'web profile' })
}

function parseLegacyEnv(
  source: string | undefined,
): Pick<DingTalkCredentials, 'clientId' | 'clientSecret'> | undefined {
  if (!source) return undefined
  const values = new Map<string, string>()
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) values.set(match[1], match[2])
  }
  const clientId = values.get(CLIENT_ID_REF) ?? ''
  const clientSecret = values.get(CLIENT_SECRET_REF) ?? ''
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

export async function loadDingTalkCredentials(dshHome: string): Promise<DingTalkCredentials | undefined> {
  return loadDingTalkAccountCredentials(dshHome, DEFAULT_ACCOUNT_ID)
}

export { accountCredentialRefs }

export async function loadDingTalkAccountCredentials(
  dshHome: string,
  accountId: string,
  credentialRefs: AccountCredentialRefs = accountCredentialRefs(accountId),
): Promise<DingTalkCredentials | undefined> {
  assertAccountCredentialRefs(credentialRefs)
  const file = credentialsPath(dshHome)
  const source = await readOptional(file)
  if (source !== undefined) {
    await assertPrivateFile(file)
    const document = parseCredentialDocument(source, file)
    const clientId = document.refs[credentialRefs.clientIdRef] ?? ''
    const clientSecret = document.refs[credentialRefs.clientSecretRef] ?? ''
    if (clientId && clientSecret) return { clientId, clientSecret, source: 'credentials' }
  }

  if (accountId !== DEFAULT_ACCOUNT_ID) return undefined
  const legacy = parseLegacyEnv(await readOptional(legacyEnvPath(dshHome)))
  return legacy ? { ...legacy, source: 'legacy-env' } : undefined
}

export async function saveDingTalkCredentials(
  dshHome: string,
  credentials: Pick<DingTalkCredentials, 'clientId' | 'clientSecret'>,
): Promise<string> {
  return saveDingTalkAccountCredentials(dshHome, 'default', credentials)
}

export async function saveDingTalkAccountCredentials(
  dshHome: string,
  accountId: string,
  credentials: Pick<DingTalkCredentials, 'clientId' | 'clientSecret'>,
  credentialRefs: AccountCredentialRefs = accountCredentialRefs(accountId),
): Promise<string> {
  if (!credentials.clientId.trim() || !credentials.clientSecret.trim())
    throw new Error('Client ID 和 Client Secret 不能为空')
  const refs = credentialRefs
  assertAccountCredentialRefs(refs)
  const file = credentialsPath(dshHome)
  return withCredentialFileLock(file, async () => {
    const existing = await readOptional(file)
    if (existing !== undefined) await assertPrivateFile(file)
    const document = parseCredentialDocument(existing, file)
    document.setRef(refs.clientIdRef, credentials.clientId.trim())
    document.setRef(refs.clientSecretRef, credentials.clientSecret.trim())
    await atomicPrivateWrite(file, document.serialize())
    return file
  })
}

function profileEntries(source: string | undefined, file: string): Array<Record<string, unknown>> {
  const parsed = source && source.trim() ? parse(source, { uniqueKeys: true }) : []
  if (!Array.isArray(parsed)) throw new Error(`DSH web profile 配置 ${file} 必须是 YAML array`)
  return parsed as Array<Record<string, unknown>>
}

function ownedPluginConfig(entries: Array<Record<string, unknown>>): {
  current: Record<string, unknown> | undefined
  config: Record<string, unknown>
} {
  const current = entries.find((entry) => entry.id === 'dingtalk-channel')
  const config =
    current && typeof current.config === 'object' && current.config !== null && !Array.isArray(current.config)
      ? { ...(current.config as Record<string, unknown>) }
      : {}
  return { current, config }
}

async function writeWebProfile(
  file: string,
  entries: Array<Record<string, unknown>>,
  current: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): Promise<void> {
  if (current) current.config = config
  else entries.unshift({ id: 'dingtalk-channel', config })
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await atomicPrivateWrite(file, stringify(entries, { lineWidth: 0 }))
}

function upsertOwnedAccount(
  config: Record<string, unknown>,
  id: string,
  options: { enable?: boolean } = {},
): Record<string, unknown> {
  const accounts = Array.isArray(config.accounts)
    ? (config.accounts.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item),
      ) as Record<string, unknown>[])
    : []
  const fallbackRefs = accountCredentialRefs(id)
  const existing = accounts.find((account) => account.id === id)
  const inherited =
    id === DEFAULT_ACCOUNT_ID
      ? {
          ...(typeof config.ownerStaffId === 'string' && config.ownerStaffId
            ? { ownerStaffId: config.ownerStaffId }
            : {}),
          ...(Array.isArray(config.groupAllowlist)
            ? {
                groupAllowlist: config.groupAllowlist.filter(
                  (item): item is string => typeof item === 'string' && Boolean(item),
                ),
              }
            : {}),
          ...(config.senderAccess === 'all' || config.senderAccess === 'allowlist'
            ? { senderAccess: config.senderAccess }
            : {}),
          ...(Array.isArray(config.allowedSenders) ? { allowedSenders: config.allowedSenders } : {}),
          ...(config.groupAccess === 'all' || config.groupAccess === 'none' || config.groupAccess === 'allowlist'
            ? { groupAccess: config.groupAccess }
            : {}),
          ...(config.sessionScope === 'chat-sender' ? { sessionScope: 'chat-sender' } : {}),
        }
      : {}
  const clientIdRef =
    typeof existing?.clientIdRef === 'string' && existing.clientIdRef ? existing.clientIdRef : fallbackRefs.clientIdRef
  const clientSecretRef =
    typeof existing?.clientSecretRef === 'string' && existing.clientSecretRef
      ? existing.clientSecretRef
      : fallbackRefs.clientSecretRef
  assertAccountCredentialRefs({ clientIdRef, clientSecretRef })
  const next = {
    ...inherited,
    ...(existing ?? {}),
    id,
    enabled: options.enable === true ? true : existing?.enabled !== false,
    clientIdRef,
    clientSecretRef,
  }
  if (existing) Object.assign(existing, next)
  else accounts.push(next)
  config.accounts = accounts
  // setup 管理凭据引用后，旧的根级明文覆盖必须清除，否则会遮蔽凭据存储。
  delete config.clientId
  delete config.clientSecret
  return existing ?? next
}

export async function upsertWebProfileAccount(
  dshHome: string,
  accountId: string,
  options: { enable?: boolean } = {},
): Promise<string> {
  const id = assertAccountId(accountId)
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  return withWebProfileLock(file, async () => {
    const entries = profileEntries(await readOptional(file), file)
    const { current, config } = ownedPluginConfig(entries)
    upsertOwnedAccount(config, id, options)
    await writeWebProfile(file, entries, current, config)
    return file
  })
}

export async function removeLegacyDingTalkCredentials(dshHome: string): Promise<void> {
  const file = legacyEnvPath(dshHome)
  const existing = await readOptional(file)
  if (existing === undefined) return
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${CLIENT_ID_REF}=`) && !line.startsWith(`${CLIENT_SECRET_REF}=`))
    .filter((line, index, lines) => line !== '' || index < lines.length - 1)
  await atomicPrivateWrite(file, `${kept.join('\n').replace(/\n+$/, '')}${kept.length ? '\n' : ''}`)
}

export async function updateWebProfileConfig(dshHome: string, config: WebProfileUpdate): Promise<string> {
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  return withWebProfileLock(file, async () => {
    const entries = profileEntries(await readOptional(file), file)
    const { current, config: ownedConfig } = ownedPluginConfig(entries)
    ownedConfig.tools = { enabled: config.dwsEnabled }
    ownedConfig.imageMode = config.imageMode
    if (config.interactionCardTemplateId !== undefined) {
      ownedConfig.interactionCardTemplateId = config.interactionCardTemplateId
    }
    if (config.senderAccess !== undefined) ownedConfig.senderAccess = config.senderAccess
    if (config.allowedSenders !== undefined) ownedConfig.allowedSenders = config.allowedSenders
    if (config.groupAccess !== undefined) ownedConfig.groupAccess = config.groupAccess
    if (config.groupAllowlist !== undefined) ownedConfig.groupAllowlist = config.groupAllowlist
    if (config.sessionScope !== undefined) ownedConfig.sessionScope = config.sessionScope

    delete ownedConfig.clientId
    delete ownedConfig.clientSecret
    await writeWebProfile(file, entries, current, ownedConfig)
    return file
  })
}

export async function updateWebProfileAccountAccess(
  dshHome: string,
  accountId: string,
  access: WebProfileAccountAccess,
): Promise<string> {
  const id = assertAccountId(accountId)
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  return withWebProfileLock(file, async () => {
    const entries = profileEntries(await readOptional(file), file)
    const { current, config } = ownedPluginConfig(entries)
    const account = upsertOwnedAccount(config, id)
    Object.assign(account, access)
    await writeWebProfile(file, entries, current, config)
    return file
  })
}

export async function loadWebProfileConfig(dshHome: string): Promise<WebProfileConfig> {
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const source = await readOptional(file)
  if (!source || !source.trim()) {
    return {
      dwsEnabled: false,
      imageMode: 'auto',
      interactionCardTemplateId: '',
      ownerStaffId: '',
      senderAccess: 'owner',
      allowedSenders: [],
      groupAccess: 'none',
      groupAllowlist: [],
      sessionScope: 'chat',
      accounts: [],
    }
  }
  const parsed = parse(source, { uniqueKeys: true })
  if (!Array.isArray(parsed)) throw new Error(`DSH web profile 配置 ${file} 必须是 YAML array`)
  const entry = (parsed as Array<Record<string, unknown>>).find((item) => item.id === 'dingtalk-channel')
  const config =
    entry?.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
      ? (entry.config as Record<string, unknown>)
      : {}
  const tools =
    config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools)
      ? (config.tools as Record<string, unknown>)
      : {}
  const imageMode = config.imageMode === 'always' || config.imageMode === 'never' ? config.imageMode : 'auto'
  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
          .map((item) => item.trim())
      : []
  const allowedSenders = stringList(config.allowedSenders)
  const groupAllowlist = stringList(config.groupAllowlist)
  const senderAccess: SenderAccess =
    config.senderAccess === 'all' || config.senderAccess === 'allowlist' ? config.senderAccess : 'owner'
  const groupAccess: GroupAccess =
    config.groupAccess === 'all' || config.groupAccess === 'none' || config.groupAccess === 'allowlist'
      ? config.groupAccess
      : groupAllowlist.length
        ? 'allowlist'
        : 'none'
  const accounts = Array.isArray(config.accounts)
    ? config.accounts.flatMap((item): WebProfileAccount[] => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const raw = item as Record<string, unknown>
        if (typeof raw.id !== 'string') return []
        const id = assertAccountId(raw.id)
        const refs = accountCredentialRefs(id)
        const account: WebProfileAccount = {
          id,
          enabled: raw.enabled !== false,
          clientIdRef: typeof raw.clientIdRef === 'string' && raw.clientIdRef ? raw.clientIdRef : refs.clientIdRef,
          clientSecretRef:
            typeof raw.clientSecretRef === 'string' && raw.clientSecretRef ? raw.clientSecretRef : refs.clientSecretRef,
        }
        assertAccountCredentialRefs(account)
        if (typeof raw.ownerStaffId === 'string' && raw.ownerStaffId) account.ownerStaffId = raw.ownerStaffId
        if (raw.senderAccess === 'all' || raw.senderAccess === 'owner' || raw.senderAccess === 'allowlist')
          account.senderAccess = raw.senderAccess
        if (Array.isArray(raw.allowedSenders)) account.allowedSenders = stringList(raw.allowedSenders)
        if (raw.groupAccess === 'all' || raw.groupAccess === 'none' || raw.groupAccess === 'allowlist')
          account.groupAccess = raw.groupAccess
        if (Array.isArray(raw.groupAllowlist)) account.groupAllowlist = stringList(raw.groupAllowlist)
        if (raw.sessionScope === 'chat' || raw.sessionScope === 'chat-sender') account.sessionScope = raw.sessionScope
        return [account]
      })
    : []
  return {
    dwsEnabled: tools.enabled === true,
    imageMode,
    interactionCardTemplateId:
      typeof config.interactionCardTemplateId === 'string' ? config.interactionCardTemplateId : '',
    ownerStaffId: typeof config.ownerStaffId === 'string' ? config.ownerStaffId : '',
    senderAccess,
    allowedSenders,
    groupAccess,
    groupAllowlist,
    sessionScope: config.sessionScope === 'chat-sender' ? 'chat-sender' : 'chat',
    accounts,
  }
}

/** 与运行时保持一致：仅在尚无 accounts[] 时回退到旧版默认账号。 */
export function enabledWebProfileAccounts(profile: WebProfileConfig): WebProfileAccount[] {
  if (profile.accounts.length) return profile.accounts.filter((account) => account.enabled)
  return [
    {
      id: DEFAULT_ACCOUNT_ID,
      enabled: true,
      ...accountCredentialRefs(DEFAULT_ACCOUNT_ID),
      ...(profile.ownerStaffId ? { ownerStaffId: profile.ownerStaffId } : {}),
      senderAccess: profile.senderAccess,
      allowedSenders: profile.allowedSenders,
      groupAccess: profile.groupAccess,
      groupAllowlist: profile.groupAllowlist,
      sessionScope: profile.sessionScope,
    },
  ]
}
