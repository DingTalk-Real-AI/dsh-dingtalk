import path from 'node:path'

import { accountStateDir, DEFAULT_ACCOUNT_ID } from './accounts.js'
import { OwnerBinding } from './owner.js'
import {
  createSetupCheckpoint,
  loadSetupCheckpoint,
  parseSetupAnswers,
  updateSetupCheckpoint,
  withSetupCheckpointLock,
  type SetupAnswers,
  type SetupCheckpoint,
} from './setup-checkpoint.js'
import { inspectAndPlanSetup, type InspectSetupOptions, type SetupPlan, type SetupPlanRequest } from './setup-plan.js'
import {
  CredentialDshUpgradeRequiredError,
  loadDingTalkAccountCredentials,
  loadWebProfileConfig,
  reconcileDingTalkCredentialLayout,
  updateWebProfileAccountAccess,
  updateWebProfileConfig,
  upsertWebProfileAccount,
} from './setup-state.js'
import {
  installedDshCredentialLayout,
  runPrivateAccountSetup,
  type CommandRunner,
  type RunGuidedSetupOptions,
  type SetupUi,
} from './setup.js'
import type { DshWebProcessStatus } from './service.js'

const MACHINE_SETUP_SCHEMA_VERSION = 1 as const

export interface MachineSetupOptions {
  runner: CommandRunner
  dshHome: string
  stateDir: string
  installSpec: string
  serviceStatus: DshWebProcessStatus
}

export interface MachineSetupAnswers extends SetupAnswers {
  schemaVersion: typeof MACHINE_SETUP_SCHEMA_VERSION
  planId: string
}

export type MachineSetupStatus =
  | 'blocked'
  | 'failed'
  | 'awaiting_private_credentials'
  | 'awaiting_private_binding'
  | 'awaiting_bind'
  | 'start_required'
  | 'restart_required'
  | 'completed'

export interface MachineSetupNext {
  kind: 'private_command' | 'bind' | 'start' | 'restart'
  command?: string
  expiresAt?: string
}

export interface MachineSetupError {
  code: 'approval_required' | 'command_failed' | 'configuration_failed' | 'dsh_upgrade_required' | 'environment_changed'
  stepId?: string
  approvalIds?: string[]
}

export interface MachineSetupOutcome {
  schemaVersion: typeof MACHINE_SETUP_SCHEMA_VERSION
  kind: 'setup-outcome'
  status: MachineSetupStatus
  checkpointId: string
  accountId: string
  completedStepIds: string[]
  next?: MachineSetupNext
  error?: MachineSetupError
}

export interface PrivateSetupResumeOptions extends MachineSetupOptions {
  checkpointId: string
  ui: SetupUi
  onboard?: RunGuidedSetupOptions['onboard']
}

export class MachineSetupInputError extends Error {
  constructor(readonly code: 'invalid_answers' | 'plan_changed' | 'checkpoint_not_resumable') {
    super(code)
    this.name = 'MachineSetupInputError'
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MachineSetupInputError('invalid_answers')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed)
  if (Object.keys(value).some((key) => !expected.has(key))) throw new MachineSetupInputError('invalid_answers')
  if (allowed.some((key) => !Object.hasOwn(value, key))) throw new MachineSetupInputError('invalid_answers')
}

/** 解析 AI 提供的非秘密答案；未知字段和任何缺省值都会被拒绝。 */
export function parseMachineSetupAnswers(value: unknown): MachineSetupAnswers {
  const input = record(value)
  exactKeys(input, ['schemaVersion', 'planId', 'accountId', 'approvals', 'features'])
  if (input.schemaVersion !== MACHINE_SETUP_SCHEMA_VERSION || typeof input.planId !== 'string') {
    throw new MachineSetupInputError('invalid_answers')
  }
  if (!/^setup-plan-[0-9a-f]{16}$/.test(input.planId)) throw new MachineSetupInputError('invalid_answers')

  let answers: SetupAnswers
  try {
    answers = parseSetupAnswers({
      accountId: input.accountId,
      approvals: input.approvals,
      features: input.features,
    })
  } catch {
    throw new MachineSetupInputError('invalid_answers')
  }

  return {
    schemaVersion: MACHINE_SETUP_SCHEMA_VERSION,
    planId: input.planId,
    ...answers,
  }
}

function inspectOptions(options: MachineSetupOptions): InspectSetupOptions {
  return {
    runner: options.runner,
    dshHome: options.dshHome,
    stateDir: options.stateDir,
    installSpec: options.installSpec,
    service: { webStatus: options.serviceStatus },
  }
}

export async function planMachineSetup(
  options: MachineSetupOptions,
  request: SetupPlanRequest = {},
): Promise<SetupPlan> {
  return inspectAndPlanSetup(inspectOptions(options), request)
}

function outcome(
  checkpoint: SetupCheckpoint,
  status: MachineSetupStatus,
  extras: Pick<MachineSetupOutcome, 'next' | 'error'> = {},
): MachineSetupOutcome {
  return {
    schemaVersion: MACHINE_SETUP_SCHEMA_VERSION,
    kind: 'setup-outcome',
    status,
    checkpointId: checkpoint.id,
    accountId: checkpoint.answers.accountId,
    completedStepIds: [...checkpoint.completedStepIds],
    ...extras,
  }
}

function privateCommand(installSpec: string, checkpointId: string): MachineSetupNext {
  const exactRegistrySpec = /^@dingtalk-real-ai\/dsh-dingtalk@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(installSpec)
  const executable = exactRegistrySpec ? `npx ${installSpec}` : 'dsh-dingtalk'
  return { kind: 'private_command', command: `${executable} setup --resume ${checkpointId}` }
}

function requiredApprovalIds(plan: SetupPlan, answers: SetupAnswers, completed: Set<string>): string[] {
  const required: string[] = []
  const actionIds = new Set(plan.actions.map((item) => item.id))
  if (actionIds.has('install-dsh') && !completed.has('install-dsh') && !answers.approvals.installDsh) {
    required.push('install-dsh')
  }
  if (actionIds.has('install-pnpm') && !completed.has('install-pnpm') && !answers.approvals.installPnpm) {
    required.push('install-pnpm')
  }
  if (!completed.has('install-plugin') && !answers.approvals.installPlugin) required.push('install-plugin')
  if (!completed.has('write-profile') && !answers.approvals.writeProfile) required.push('write-profile')
  return required
}

async function persistProgress(
  options: MachineSetupOptions,
  checkpoint: SetupCheckpoint,
  status: SetupCheckpoint['status'],
  completed: Set<string>,
): Promise<SetupCheckpoint> {
  return updateSetupCheckpoint(options.stateDir, checkpoint.id, {
    status,
    completedStepIds: [...completed],
  })
}

async function failStep(
  options: MachineSetupOptions,
  checkpoint: SetupCheckpoint,
  completed: Set<string>,
  stepId: string,
  code: MachineSetupError['code'],
): Promise<MachineSetupOutcome> {
  const saved = await persistProgress(options, checkpoint, 'failed', completed)
  return outcome(saved, 'failed', { error: { code, stepId } })
}

function runCommand(runner: CommandRunner, command: string, args: string[]) {
  try {
    return runner.run(command, args)
  } catch {
    return undefined
  }
}

function commandSucceeded(runner: CommandRunner, command: string, args: string[]): boolean {
  return runCommand(runner, command, args)?.code === 0
}

function versionMajor(output: string): number {
  const trimmed = output.trim()
  let version = trimmed
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string') version = parsed
  } catch {
    // 普通版本输出不是 JSON。
  }
  return Number(version.trim().replace(/^v/, '').split(/\s+/)[0]?.split('.')[0])
}

async function bindingStatus(options: MachineSetupOptions, accountId: string) {
  const profile = await loadWebProfileConfig(options.dshHome)
  const account = profile.accounts.find((item) => item.id === accountId)
  const configuredOwner = account?.ownerStaffId || (accountId === DEFAULT_ACCOUNT_ID ? profile.ownerStaffId || '' : '')
  return new OwnerBinding({
    file: path.join(accountStateDir(options.stateDir, accountId), 'owner.json'),
    configuredOwner,
    legacyAllowedSenders: [],
    senderAccess: account?.senderAccess,
    allowedSenders: account?.allowedSenders,
    groupAccess: account?.groupAccess,
    allowedGroups: account?.groupAllowlist ?? [],
  }).status()
}

async function reconcileConfiguredCredentialLayout(options: MachineSetupOptions, accountId: string): Promise<void> {
  const profile = await loadWebProfileConfig(options.dshHome)
  const account = profile.accounts.find((item) => item.id === accountId)
  const credentials = await loadDingTalkAccountCredentials(options.dshHome, accountId, account)
  if (credentials?.source !== 'credentials') return
  await reconcileDingTalkCredentialLayout(options.dshHome, installedDshCredentialLayout(options.runner))
}

async function finishFromObservedState(
  options: MachineSetupOptions,
  checkpoint: SetupCheckpoint,
  completed: Set<string>,
): Promise<MachineSetupOutcome> {
  const profile = await loadWebProfileConfig(options.dshHome).catch(() => undefined)
  const account = profile?.accounts.find((item) => item.id === checkpoint.answers.accountId)
  const credentials = await loadDingTalkAccountCredentials(
    options.dshHome,
    checkpoint.answers.accountId,
    account,
  ).catch(() => undefined)
  if (!credentials) {
    const saved = await persistProgress(options, checkpoint, 'awaiting_private_credentials', completed)
    return outcome(saved, 'awaiting_private_credentials', { next: privateCommand(options.installSpec, saved.id) })
  }
  completed.add('private-credentials')

  const binding = await bindingStatus(options, checkpoint.answers.accountId)
  if (!binding.bound) {
    if (binding.challengeReady) {
      completed.add('private-binding')
      const saved = await persistProgress(options, checkpoint, 'awaiting_bind', completed)
      const expiresAt = binding.challengeExpiresAt ? new Date(binding.challengeExpiresAt).toISOString() : undefined
      return outcome(saved, 'awaiting_bind', {
        next: { kind: 'bind', ...(expiresAt ? { expiresAt } : {}) },
      })
    }
    const saved = await persistProgress(options, checkpoint, 'awaiting_private_binding', completed)
    return outcome(saved, 'awaiting_private_binding', { next: privateCommand(options.installSpec, saved.id) })
  }

  if (options.serviceStatus === 'running' && !checkpoint.serviceWasRunning) {
    const saved = await persistProgress(options, checkpoint, 'completed', completed)
    return outcome(saved, 'completed')
  }
  const serviceMayBeRunning = options.serviceStatus !== 'stopped'
  const status: MachineSetupStatus = serviceMayBeRunning ? 'restart_required' : 'start_required'
  const saved = await persistProgress(options, checkpoint, status, completed)
  return outcome(saved, status, {
    next: serviceMayBeRunning ? { kind: 'restart' } : { kind: 'start', command: 'dsh web' },
  })
}

async function continueMachineSetup(
  options: MachineSetupOptions,
  initial: SetupCheckpoint,
): Promise<MachineSetupOutcome> {
  let checkpoint = initial
  const completed = new Set(checkpoint.completedStepIds)
  const plan = await planMachineSetup(options, { accountId: checkpoint.answers.accountId })
  const planChangedBeforeProgress = completed.size === 0 && plan.planId !== checkpoint.planId
  const installSpecChanged = plan.snapshot.plugin.installSpecFingerprint !== checkpoint.installSpecFingerprint
  if (planChangedBeforeProgress || installSpecChanged) {
    const saved = await persistProgress(options, checkpoint, 'failed', completed)
    return outcome(saved, 'failed', { error: { code: 'environment_changed' } })
  }
  if (plan.status === 'blocked') {
    const saved = await persistProgress(options, checkpoint, 'failed', completed)
    return outcome(saved, 'failed', { error: { code: 'environment_changed' } })
  }

  const approvals = requiredApprovalIds(plan, checkpoint.answers, completed)
  if (approvals.length) {
    const saved = await persistProgress(options, checkpoint, 'blocked', completed)
    return outcome(saved, 'blocked', {
      error: { code: 'approval_required', approvalIds: approvals },
    })
  }

  const actionIds = new Set(plan.actions.map((item) => item.id))
  if (actionIds.has('install-dsh') && !completed.has('install-dsh')) {
    if (!commandSucceeded(options.runner, 'npm', ['install', '--global', '@deepseek-ai/dsh@latest'])) {
      return failStep(options, checkpoint, completed, 'install-dsh', 'command_failed')
    }
    if (!commandSucceeded(options.runner, 'dsh', ['--version'])) {
      return failStep(options, checkpoint, completed, 'install-dsh', 'command_failed')
    }
    completed.add('install-dsh')
    checkpoint = await persistProgress(options, checkpoint, 'applying', completed)
  }

  if (actionIds.has('install-pnpm') && !completed.has('install-pnpm')) {
    if (!commandSucceeded(options.runner, 'npm', ['install', '--global', 'pnpm@latest'])) {
      return failStep(options, checkpoint, completed, 'install-pnpm', 'command_failed')
    }
    const installedPnpm = runCommand(options.runner, 'pnpm', ['--version'])
    const installedPnpmMajor = installedPnpm ? versionMajor(installedPnpm.stdout) : Number.NaN
    if (installedPnpm?.code !== 0 || !Number.isFinite(installedPnpmMajor) || installedPnpmMajor < 11) {
      return failStep(options, checkpoint, completed, 'install-pnpm', 'command_failed')
    }
    completed.add('install-pnpm')
    checkpoint = await persistProgress(options, checkpoint, 'applying', completed)
  }

  if (!completed.has('install-plugin')) {
    if (!commandSucceeded(options.runner, 'dsh', ['plugin', '--profile', 'web', 'add', options.installSpec])) {
      return failStep(options, checkpoint, completed, 'install-plugin', 'command_failed')
    }
    completed.add('install-plugin')
    checkpoint = await persistProgress(options, checkpoint, 'applying', completed)
  }

  const writeProfilePending = !completed.has('write-profile')
  if (writeProfilePending) {
    try {
      const { accountId, features } = checkpoint.answers
      await upsertWebProfileAccount(options.dshHome, accountId, { enable: true })
      await updateWebProfileConfig(options.dshHome, {
        dwsEnabled: features.dwsEnabled,
        imageMode: features.imageMode,
      })
      await updateWebProfileAccountAccess(options.dshHome, accountId, {
        senderAccess: features.senderAccess,
        allowedSenders: features.allowedSenders,
        groupAccess: features.groupAccess,
        groupAllowlist: features.groupAllowlist,
        sessionScope: features.groupAccess === 'none' ? 'chat' : 'chat-sender',
      })
    } catch {
      return failStep(options, checkpoint, completed, 'write-profile', 'configuration_failed')
    }
  }

  try {
    await reconcileConfiguredCredentialLayout(options, checkpoint.answers.accountId)
  } catch (error) {
    return failStep(
      options,
      checkpoint,
      completed,
      'write-profile',
      error instanceof CredentialDshUpgradeRequiredError ? 'dsh_upgrade_required' : 'configuration_failed',
    )
  }

  if (writeProfilePending) {
    completed.add('write-profile')
    checkpoint = await persistProgress(options, checkpoint, 'applying', completed)
  }

  return finishFromObservedState(options, checkpoint, completed)
}

export async function applyMachineSetup(
  options: MachineSetupOptions,
  rawAnswers: MachineSetupAnswers | unknown,
): Promise<MachineSetupOutcome> {
  const answers = parseMachineSetupAnswers(rawAnswers)
  const plan = await planMachineSetup(options, { accountId: answers.accountId })
  if (plan.planId !== answers.planId) throw new MachineSetupInputError('plan_changed')
  const checkpoint = await createSetupCheckpoint(options.stateDir, {
    planId: plan.planId,
    installSpecFingerprint: plan.snapshot.plugin.installSpecFingerprint,
    serviceWasRunning: options.serviceStatus !== 'stopped',
    status: 'applying',
    completedStepIds: [],
    answers: {
      accountId: answers.accountId,
      approvals: answers.approvals,
      features: answers.features,
    },
  })
  return continueMachineSetup(options, checkpoint)
}

export async function resumeMachineSetup(
  options: MachineSetupOptions,
  checkpointId: string,
): Promise<MachineSetupOutcome> {
  return withSetupCheckpointLock(options.stateDir, checkpointId, async () =>
    continueMachineSetup(options, await loadSetupCheckpoint(options.stateDir, checkpointId)),
  )
}

export async function resumePrivateSetup(options: PrivateSetupResumeOptions): Promise<MachineSetupOutcome> {
  return withSetupCheckpointLock(options.stateDir, options.checkpointId, async () => {
    const checkpoint = await loadSetupCheckpoint(options.stateDir, options.checkpointId)
    if (
      checkpoint.status !== 'awaiting_private_credentials' &&
      checkpoint.status !== 'awaiting_private_binding' &&
      checkpoint.status !== 'awaiting_bind'
    ) {
      throw new MachineSetupInputError('checkpoint_not_resumable')
    }
    const plan = await planMachineSetup(options, { accountId: checkpoint.answers.accountId })
    if (plan.snapshot.plugin.installSpecFingerprint !== checkpoint.installSpecFingerprint) {
      throw new MachineSetupInputError('plan_changed')
    }

    const privateResult = await runPrivateAccountSetup({
      ui: options.ui,
      runner: options.runner,
      dshHome: options.dshHome,
      stateDir: options.stateDir,
      installSpec: options.installSpec,
      accountId: checkpoint.answers.accountId,
      onboard: options.onboard,
    })
    const completed = new Set(checkpoint.completedStepIds)
    completed.add('private-credentials')
    if (privateResult.challengePrepared) completed.add('private-binding')
    if (privateResult.bound) return finishFromObservedState(options, checkpoint, completed)

    const saved = await persistProgress(options, checkpoint, 'awaiting_bind', completed)
    return outcome(saved, 'awaiting_bind', {
      next: {
        kind: 'bind',
        ...(privateResult.challengeExpiresAt
          ? { expiresAt: new Date(privateResult.challengeExpiresAt).toISOString() }
          : {}),
      },
    })
  })
}
