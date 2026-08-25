import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { assertAccountId } from './accounts.js'
import { withRecoverableFileLock } from './file-lock.js'

export const SETUP_CHECKPOINT_SCHEMA_VERSION = 1 as const
export const SETUP_CHECKPOINT_STATUSES = [
  'applying',
  'blocked',
  'failed',
  'awaiting_private_credentials',
  'awaiting_private_binding',
  'awaiting_bind',
  'start_required',
  'restart_required',
  'completed',
] as const
export type SetupCheckpointStatus = (typeof SETUP_CHECKPOINT_STATUSES)[number]

export const SETUP_CHECKPOINT_STEP_IDS = [
  'install-dsh',
  'install-pnpm',
  'install-plugin',
  'write-profile',
  'private-credentials',
  'private-binding',
] as const
export type SetupCheckpointStepId = (typeof SETUP_CHECKPOINT_STEP_IDS)[number]

export interface SetupApprovals {
  installDsh: boolean
  installPnpm: boolean
  installPlugin: boolean
  writeProfile: boolean
}

export interface SetupFeatures {
  dwsEnabled: boolean
  imageMode: 'auto' | 'always' | 'never'
  senderAccess: 'all' | 'owner' | 'allowlist'
  allowedSenders: string[]
  groupAccess: 'all' | 'none' | 'allowlist'
  groupAllowlist: string[]
}

export interface SetupAnswers {
  accountId: string
  approvals: SetupApprovals
  features: SetupFeatures
}

export interface CreateSetupCheckpointInput {
  planId: string
  installSpecFingerprint: string
  serviceWasRunning: boolean
  status: SetupCheckpointStatus
  completedStepIds: SetupCheckpointStepId[]
  answers: SetupAnswers
}

export interface SetupCheckpoint extends CreateSetupCheckpointInput {
  schemaVersion: typeof SETUP_CHECKPOINT_SCHEMA_VERSION
  id: string
  createdAt: string
  updatedAt: string
}

export interface UpdateSetupCheckpointPatch {
  planId?: string
  status?: SetupCheckpointStatus
  completedStepIds?: string[]
  answers?: SetupAnswers
}

interface ValidatedUpdateSetupCheckpointPatch {
  planId?: string
  status?: SetupCheckpointStatus
  completedStepIds?: SetupCheckpointStepId[]
  answers?: SetupAnswers
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SENSITIVE_FIELD_NAMES = new Set([
  'clientsecret',
  'clientid',
  'devicecode',
  'verificationuri',
  'bindcode',
  'ownerstaffid',
])

function fieldKey(value: string): string {
  return value.replaceAll(/[-_]/g, '').toLowerCase()
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} 必须是普通对象`)
}

function assertNoSensitiveFields(value: unknown, location = 'checkpoint'): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoSensitiveFields(item, `${location}[${index}]`)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_FIELD_NAMES.has(fieldKey(key))) throw new Error(`禁止保存敏感字段 ${key}（位于 ${location}）`)
    assertNoSensitiveFields(nested, `${location}.${key}`)
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unknown) throw new Error(`${label} 包含未知字段 ${unknown}`)
  const missing = allowed.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new Error(`${label} 缺少字段 ${missing}`)
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unknown) throw new Error(`${label} 包含未知字段 ${unknown}`)
}

function requiredString(value: unknown, label: string, maximumLength = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} 必须是非空且不含控制字符的字符串`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  const result = requiredString(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) throw new Error(`${label} 格式无效`)
  return result
}

function fingerprint(value: unknown, label: string): string {
  const result = requiredString(value, label, 64)
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${label} 必须是 64 位小写十六进制摘要`)
  return result
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是 boolean`)
  return value
}

function stringList(value: unknown, label: string, identifiersOnly = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是字符串数组`)
  if (value.length > 1_000) throw new Error(`${label} 最多包含 1000 项`)
  return value.map((item, index) =>
    identifiersOnly ? identifier(item, `${label}[${index}]`) : requiredString(item, `${label}[${index}]`, 512),
  )
}

function checkpointStatus(value: unknown): SetupCheckpointStatus {
  if (typeof value !== 'string' || !(SETUP_CHECKPOINT_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`status 使用不支持的值 ${JSON.stringify(value)}`)
  }
  return value as SetupCheckpointStatus
}

function completedStepIds(value: unknown): SetupCheckpointStepId[] {
  const values = stringList(value, 'completedStepIds', true)
  for (const stepId of values) {
    if (!(SETUP_CHECKPOINT_STEP_IDS as readonly string[]).includes(stepId)) {
      throw new Error(`completedStepIds 包含不支持的值 ${JSON.stringify(stepId)}`)
    }
  }
  return values as SetupCheckpointStepId[]
}

export function parseSetupAnswers(value: unknown): SetupAnswers {
  assertNoSensitiveFields(value, 'answers')
  assertPlainObject(value, 'answers')
  assertExactKeys(value, ['accountId', 'approvals', 'features'], 'answers')

  assertPlainObject(value.approvals, 'answers.approvals')
  assertExactKeys(value.approvals, ['installDsh', 'installPnpm', 'installPlugin', 'writeProfile'], 'answers.approvals')
  const approvals: SetupApprovals = {
    installDsh: requiredBoolean(value.approvals.installDsh, 'answers.approvals.installDsh'),
    installPnpm: requiredBoolean(value.approvals.installPnpm, 'answers.approvals.installPnpm'),
    installPlugin: requiredBoolean(value.approvals.installPlugin, 'answers.approvals.installPlugin'),
    writeProfile: requiredBoolean(value.approvals.writeProfile, 'answers.approvals.writeProfile'),
  }

  assertPlainObject(value.features, 'answers.features')
  assertExactKeys(
    value.features,
    ['dwsEnabled', 'imageMode', 'senderAccess', 'allowedSenders', 'groupAccess', 'groupAllowlist'],
    'answers.features',
  )
  const imageMode = value.features.imageMode
  if (imageMode !== 'auto' && imageMode !== 'always' && imageMode !== 'never') {
    throw new Error('answers.features.imageMode 必须是 auto、always 或 never')
  }
  const senderAccess = value.features.senderAccess
  if (senderAccess !== 'all' && senderAccess !== 'owner' && senderAccess !== 'allowlist') {
    throw new Error('answers.features.senderAccess 必须是 all、owner 或 allowlist')
  }
  const groupAccess = value.features.groupAccess
  if (groupAccess !== 'all' && groupAccess !== 'none' && groupAccess !== 'allowlist') {
    throw new Error('answers.features.groupAccess 必须是 all、none 或 allowlist')
  }
  const allowedSenders = stringList(value.features.allowedSenders, 'answers.features.allowedSenders')
  const groupAllowlist = stringList(value.features.groupAllowlist, 'answers.features.groupAllowlist')
  if (senderAccess === 'allowlist' && !allowedSenders.length) {
    throw new Error('answers.features.allowedSenders 在 allowlist 模式下不能为空')
  }
  if (senderAccess !== 'allowlist' && allowedSenders.length) {
    throw new Error('answers.features.allowedSenders 仅允许在 allowlist 模式下填写')
  }
  if (groupAccess === 'allowlist' && !groupAllowlist.length) {
    throw new Error('answers.features.groupAllowlist 在 allowlist 模式下不能为空')
  }
  if (groupAccess !== 'allowlist' && groupAllowlist.length) {
    throw new Error('answers.features.groupAllowlist 仅允许在 allowlist 模式下填写')
  }
  const features: SetupFeatures = {
    dwsEnabled: requiredBoolean(value.features.dwsEnabled, 'answers.features.dwsEnabled'),
    imageMode,
    senderAccess,
    allowedSenders,
    groupAccess,
    groupAllowlist,
  }

  const accountId = requiredString(value.accountId, 'answers.accountId', 32)
  if (assertAccountId(accountId) !== accountId) throw new Error('answers.accountId 格式无效')
  return { accountId, approvals, features }
}

function validateCreateInput(value: unknown): CreateSetupCheckpointInput {
  assertNoSensitiveFields(value)
  assertPlainObject(value, 'checkpoint input')
  assertExactKeys(
    value,
    ['planId', 'installSpecFingerprint', 'serviceWasRunning', 'status', 'completedStepIds', 'answers'],
    'checkpoint input',
  )
  return {
    planId: identifier(value.planId, 'planId'),
    installSpecFingerprint: fingerprint(value.installSpecFingerprint, 'installSpecFingerprint'),
    serviceWasRunning: requiredBoolean(value.serviceWasRunning, 'serviceWasRunning'),
    status: checkpointStatus(value.status),
    completedStepIds: completedStepIds(value.completedStepIds),
    answers: parseSetupAnswers(value.answers),
  }
}

function validateUpdatePatch(value: unknown): ValidatedUpdateSetupCheckpointPatch {
  assertNoSensitiveFields(value, 'checkpoint patch')
  assertPlainObject(value, 'checkpoint patch')
  assertAllowedKeys(value, ['planId', 'status', 'completedStepIds', 'answers'], 'checkpoint patch')
  const patch: ValidatedUpdateSetupCheckpointPatch = {}
  if (Object.hasOwn(value, 'planId')) patch.planId = identifier(value.planId, 'planId')
  if (Object.hasOwn(value, 'status')) patch.status = checkpointStatus(value.status)
  if (Object.hasOwn(value, 'completedStepIds')) {
    patch.completedStepIds = completedStepIds(value.completedStepIds)
  }
  if (Object.hasOwn(value, 'answers')) patch.answers = parseSetupAnswers(value.answers)
  return patch
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label, 64)
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new Error(`${label} 必须是规范 ISO 时间戳`)
  }
  return timestamp
}

function validateStoredCheckpoint(value: unknown, expectedId: string): SetupCheckpoint {
  assertNoSensitiveFields(value, 'checkpoint file')
  assertPlainObject(value, 'checkpoint file')
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'id',
      'planId',
      'installSpecFingerprint',
      'serviceWasRunning',
      'status',
      'completedStepIds',
      'answers',
      'createdAt',
      'updatedAt',
    ],
    'checkpoint file',
  )
  if (value.schemaVersion !== SETUP_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`checkpoint schemaVersion 必须为 ${SETUP_CHECKPOINT_SCHEMA_VERSION}`)
  }
  if (typeof value.id !== 'string' || validateCheckpointId(value.id) !== expectedId) {
    throw new Error('checkpoint id 与请求 ID 不匹配')
  }
  const createdAt = isoTimestamp(value.createdAt, 'createdAt')
  const updatedAt = isoTimestamp(value.updatedAt, 'updatedAt')
  if (updatedAt < createdAt) throw new Error('updatedAt 不得早于 createdAt')
  return {
    schemaVersion: SETUP_CHECKPOINT_SCHEMA_VERSION,
    id: value.id,
    planId: identifier(value.planId, 'planId'),
    installSpecFingerprint: fingerprint(value.installSpecFingerprint, 'installSpecFingerprint'),
    serviceWasRunning: requiredBoolean(value.serviceWasRunning, 'serviceWasRunning'),
    status: checkpointStatus(value.status),
    completedStepIds: completedStepIds(value.completedStepIds),
    answers: parseSetupAnswers(value.answers),
    createdAt,
    updatedAt,
  }
}

function checkpointDirectory(stateDir: string): string {
  return path.join(stateDir, 'setup', 'checkpoints')
}

function validateCheckpointId(id: string): string {
  if (!UUID_V4_RE.test(id)) throw new Error('checkpoint id 必须是合法的 UUID v4')
  return id
}

function checkpointFile(stateDir: string, id: string): string {
  return path.join(checkpointDirectory(stateDir), `${validateCheckpointId(id)}.json`)
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory()) throw new Error(`checkpoint 目录 ${directory} 必须是真实目录，不能是符号链接`)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(`checkpoint 目录权限必须为当前用户私有：${directory}`)
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertPrivateDirectory(directory)
  if (process.platform !== 'win32') await chmod(directory, 0o700)
}

/** 串行化同一 checkpoint 的 apply/resume，避免重复执行外部安装和配置写入。 */
export async function withSetupCheckpointLock<T>(
  stateDir: string,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const checkpointId = validateCheckpointId(id)
  const directory = checkpointDirectory(stateDir)
  await ensurePrivateDirectory(path.dirname(directory))
  await ensurePrivateDirectory(directory)
  const lockFile = path.join(directory, `.${checkpointId}.lock`)
  return withRecoverableFileLock(lockFile, operation, { label: 'setup checkpoint' })
}

async function assertPrivateCheckpointFile(file: string): Promise<void> {
  const directory = path.dirname(file)
  await assertPrivateDirectory(path.dirname(directory))
  await assertPrivateDirectory(directory)
  const info = await lstat(file)
  if (!info.isFile()) throw new Error(`checkpoint 文件 ${file} 必须是普通文件，不能是符号链接`)
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
    throw new Error(`checkpoint 文件权限必须为 0600：${file}`)
  }
}

async function atomicPrivateWrite(file: string, value: SetupCheckpoint): Promise<void> {
  const directory = path.dirname(file)
  await ensurePrivateDirectory(path.dirname(directory))
  await ensurePrivateDirectory(directory)
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await rename(temporary, file)
    if (process.platform !== 'win32') await chmod(file, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function createSetupCheckpoint(
  stateDir: string,
  input: CreateSetupCheckpointInput,
): Promise<SetupCheckpoint> {
  const validated = validateCreateInput(input)
  const timestamp = new Date().toISOString()
  const checkpoint: SetupCheckpoint = {
    schemaVersion: SETUP_CHECKPOINT_SCHEMA_VERSION,
    id: randomUUID(),
    ...validated,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  await atomicPrivateWrite(checkpointFile(stateDir, checkpoint.id), checkpoint)
  return checkpoint
}

export async function loadSetupCheckpoint(stateDir: string, id: string): Promise<SetupCheckpoint> {
  const expectedId = validateCheckpointId(id)
  const file = checkpointFile(stateDir, expectedId)
  await assertPrivateCheckpointFile(file)
  const source = await readFile(file, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('checkpoint 文件不是有效 JSON')
  }
  return validateStoredCheckpoint(parsed, expectedId)
}

export async function updateSetupCheckpoint(
  stateDir: string,
  id: string,
  patch: UpdateSetupCheckpointPatch,
): Promise<SetupCheckpoint> {
  const validatedPatch = validateUpdatePatch(patch)
  const current = await loadSetupCheckpoint(stateDir, id)
  const updated: SetupCheckpoint = {
    ...current,
    ...validatedPatch,
    schemaVersion: SETUP_CHECKPOINT_SCHEMA_VERSION,
    id: current.id,
    completedStepIds: [...(validatedPatch.completedStepIds ?? current.completedStepIds)],
    answers: validatedPatch.answers
      ? {
          accountId: validatedPatch.answers.accountId,
          approvals: { ...validatedPatch.answers.approvals },
          features: {
            ...validatedPatch.answers.features,
            allowedSenders: [...validatedPatch.answers.features.allowedSenders],
            groupAllowlist: [...validatedPatch.answers.features.groupAllowlist],
          },
        }
      : current.answers,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  }
  await atomicPrivateWrite(checkpointFile(stateDir, id), updated)
  return updated
}
