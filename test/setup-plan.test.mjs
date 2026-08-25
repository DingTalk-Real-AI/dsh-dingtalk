import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSetupPlan, inspectAndPlanSetup, inspectSetup } from '../lib/setup-plan.js'

class ProbeRunner {
  calls = []

  constructor(results) {
    this.results = results
  }

  run(command, args) {
    this.calls.push([command, ...args])
    return this.results[`${command} ${args.join(' ')}`] ?? { code: 127, stdout: '', stderr: 'not found' }
  }
}

async function assertMissing(target) {
  await assert.rejects(stat(target), (error) => error?.code === 'ENOENT')
}

test('新安装检查只探测版本并生成脱敏的 default 账号计划', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-plan-new-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshHome = path.join(root, 'private-dsh-home')
  const stateDir = path.join(root, 'private-state-dir')
  const installSpec = path.join(root, 'private-plugin-source')
  const runner = new ProbeRunner({
    'pnpm --version': { code: 0, stdout: '10.5.0\n', stderr: '' },
  })

  const plan = await inspectAndPlanSetup(
    {
      runner,
      dshHome,
      stateDir,
      installSpec,
      service: { webStatus: 'stopped' },
      nodeVersion: '24.0.0',
    },
    {},
  )

  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.kind, 'setup-plan')
  assert.equal(plan.status, 'needs_input')
  assert.equal(plan.accountId, 'default')
  assert.deepEqual(plan.snapshot.node, { version: '24.0.0', supported: true })
  assert.deepEqual(plan.snapshot.dsh, { installed: false, version: null })
  assert.deepEqual(plan.snapshot.pnpm, { installed: true, version: '10.5.0', supported: false })
  assert.deepEqual(plan.snapshot.accounts, [
    { id: 'default', enabled: true, credentialsConfigured: false, bound: false },
  ])
  assert.deepEqual(plan.snapshot.web, { status: 'stopped' })
  assert.deepEqual(
    plan.actions.map((action) => action.id),
    [
      'install-dsh',
      'install-pnpm',
      'install-plugin',
      'private-credentials',
      'write-profile',
      'private-binding',
      'start-web',
    ],
  )
  assert.deepEqual(plan.questions, [{ id: 'credentials', type: 'credentials', accountId: 'default' }])
  assert.deepEqual(plan.requiredApprovals, ['install-dsh', 'install-pnpm', 'install-plugin', 'write-profile'])
  assert.deepEqual(
    plan.actions.filter((action) => action.executor === 'human').map((action) => action.id),
    ['private-credentials', 'private-binding', 'start-web'],
  )
  assert.deepEqual(plan.answerTemplate, {
    schemaVersion: 1,
    planId: plan.planId,
    accountId: 'default',
    approvals: {
      installDsh: null,
      installPnpm: null,
      installPlugin: null,
      writeProfile: null,
    },
    features: {
      dwsEnabled: null,
      imageMode: null,
      senderAccess: null,
      allowedSenders: [],
      groupAccess: null,
      groupAllowlist: [],
    },
  })
  assert.deepEqual(plan.answerContract, {
    secretsAccepted: false,
    missingValues: 'reject',
    imageMode: ['auto', 'always', 'never'],
    senderAccess: ['all', 'owner', 'allowlist'],
    groupAccess: ['all', 'none', 'allowlist'],
  })
  assert.match(plan.planId, /^setup-plan-[0-9a-f]{16}$/)
  assert.match(plan.fingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(runner.calls, [
    ['dsh', '--version'],
    ['pnpm', '--version'],
  ])

  const serialized = JSON.stringify(plan)
  assert.doesNotMatch(serialized, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await assertMissing(dshHome)
  await assertMissing(stateDir)
})

test('显式选择已有账号时生成确定性 restart 计划且不泄露私密配置', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-plan-existing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshHome = path.join(root, 'secret-home')
  const stateDir = path.join(root, 'secret-state')
  const profileFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const credentialsFile = path.join(dshHome, '.credentials.yaml')
  const defaultOwnerFile = path.join(stateDir, 'owner.json')
  await mkdir(path.dirname(profileFile), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    credentialsFile,
    [
      'version: 1',
      'refs:',
      '  DINGTALK_CLIENT_ID: private-default-client',
      '  DINGTALK_CLIENT_SECRET: private-default-secret',
      '  DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID: private-support-client',
      '  DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET: private-support-secret',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  await writeFile(
    profileFile,
    [
      '- id: dingtalk-channel',
      '  config:',
      '    accounts:',
      '      - id: default',
      '        enabled: true',
      '      - id: support-bot',
      '        enabled: true',
      '        ownerStaffId: private-support-owner',
      '',
    ].join('\n'),
  )
  await writeFile(defaultOwnerFile, '{"ownerStaffId":"private-default-owner"}\n', { mode: 0o600 })
  const before = {
    credentials: await readFile(credentialsFile, 'utf8'),
    profile: await readFile(profileFile, 'utf8'),
    owner: await readFile(defaultOwnerFile, 'utf8'),
  }
  const runner = new ProbeRunner({
    'dsh --version': { code: 0, stdout: '1.4.0\n', stderr: '' },
    'pnpm --version': { code: 0, stdout: '11.7.0\n', stderr: '' },
  })
  const options = {
    runner,
    dshHome,
    stateDir,
    installSpec: path.join(root, 'private-plugin-source'),
    service: { webStatus: 'running' },
    nodeVersion: '24.2.0',
  }

  const snapshot = await inspectSetup(options)
  const plan = createSetupPlan(snapshot, { accountId: 'support-bot' })
  const repeated = createSetupPlan(snapshot, { accountId: 'support-bot' })

  assert.equal(plan.status, 'ready')
  assert.equal(plan.accountId, 'support-bot')
  assert.deepEqual(snapshot.accounts, [
    { id: 'default', enabled: true, credentialsConfigured: true, bound: true },
    { id: 'support-bot', enabled: true, credentialsConfigured: true, bound: true },
  ])
  assert.deepEqual(
    plan.actions.map((action) => action.id),
    ['install-plugin', 'write-profile', 'restart-web'],
  )
  assert.deepEqual(plan.questions, [])
  assert.deepEqual(plan.requiredApprovals, ['install-plugin', 'write-profile'])
  assert.equal(plan.answerTemplate.approvals.installDsh, false)
  assert.equal(plan.answerTemplate.approvals.installPnpm, false)
  assert.equal(repeated.planId, plan.planId)
  assert.equal(repeated.fingerprint, plan.fingerprint)
  assert.deepEqual(runner.calls, [
    ['dsh', '--version'],
    ['pnpm', '--version'],
  ])

  const serialized = JSON.stringify(plan)
  for (const secret of [
    root,
    'private-default-client',
    'private-default-secret',
    'private-support-client',
    'private-support-secret',
    'private-default-owner',
    'private-support-owner',
  ]) {
    assert.equal(serialized.includes(secret), false, `计划不得包含 ${secret}`)
  }
  assert.deepEqual(
    {
      credentials: await readFile(credentialsFile, 'utf8'),
      profile: await readFile(profileFile, 'utf8'),
      owner: await readFile(defaultOwnerFile, 'utf8'),
    },
    before,
  )

  const combined = await inspectAndPlanSetup(options, { accountId: 'support-bot' })
  assert.equal(combined.planId, plan.planId)
})

test('多个账号未指定 accountId 时只返回稳定的账号选择问题', () => {
  const snapshot = {
    schemaVersion: 1,
    kind: 'setup-snapshot',
    node: { version: '24.2.0', supported: true },
    dsh: { installed: true, version: '1.4.0' },
    pnpm: { installed: true, version: '11.7.0', supported: true },
    accounts: [
      { id: 'default', enabled: true, credentialsConfigured: true, bound: true },
      { id: 'support-bot', enabled: true, credentialsConfigured: true, bound: false },
    ],
    web: { status: 'stopped' },
    plugin: { installSpecFingerprint: 'a'.repeat(64) },
  }

  const plan = createSetupPlan(snapshot)

  assert.equal(plan.status, 'needs_input')
  assert.equal('accountId' in plan, false)
  assert.deepEqual(plan.questions, [{ id: 'account', type: 'select', options: ['default', 'support-bot'] }])
  assert.equal('answerTemplate' in plan, false)
  assert.deepEqual(
    plan.actions.map((action) => action.id),
    ['install-plugin', 'start-web'],
  )
})

test('服务探测未知时在 snapshot 保留三态并保守要求 restart', () => {
  const snapshot = {
    schemaVersion: 1,
    kind: 'setup-snapshot',
    node: { version: '24.2.0', supported: true },
    dsh: { installed: true, version: '1.4.0' },
    pnpm: { installed: true, version: '11.7.0', supported: true },
    accounts: [{ id: 'default', enabled: true, credentialsConfigured: true, bound: true }],
    web: { status: 'unknown' },
    plugin: { installSpecFingerprint: 'c'.repeat(64) },
  }

  const plan = createSetupPlan(snapshot)

  assert.deepEqual(plan.snapshot.web, { status: 'unknown' })
  assert.equal(plan.actions.at(-1).id, 'restart-web')
})

test('不支持的 Node.js 使计划 blocked 且不提供可执行 action', () => {
  const snapshot = {
    schemaVersion: 1,
    kind: 'setup-snapshot',
    node: { version: '22.18.0', supported: false },
    dsh: { installed: false, version: null },
    pnpm: { installed: false, version: null, supported: false },
    accounts: [{ id: 'default', enabled: true, credentialsConfigured: false, bound: false }],
    web: { status: 'running' },
    plugin: { installSpecFingerprint: 'b'.repeat(64) },
  }

  const plan = createSetupPlan(snapshot)

  assert.equal(plan.status, 'blocked')
  assert.deepEqual(plan.blockers, [{ id: 'unsupported-node', detail: 'Node.js 版本不满足 ^22.19.0 或 >=24.0.0' }])
  assert.deepEqual(plan.actions, [])
  assert.deepEqual(plan.questions, [])
  assert.deepEqual(plan.requiredApprovals, [])
})

test('版本探测不把命令原始输出或路径带入机器计划', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-plan-probe-redaction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runner = new ProbeRunner({
    'dsh --version': { code: 0, stdout: `${root}/private-dsh-value\n`, stderr: '' },
    'pnpm --version': { code: 0, stdout: 'private-pnpm-value\n', stderr: '' },
  })

  const plan = await inspectAndPlanSetup(
    {
      runner,
      dshHome: path.join(root, '.dsh'),
      stateDir: path.join(root, '.state'),
      installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.5.2',
      service: { webStatus: 'stopped' },
      nodeVersion: '24.2.0',
    },
    { accountId: 'default' },
  )

  assert.deepEqual(plan.snapshot.dsh, { installed: true, version: null })
  assert.deepEqual(plan.snapshot.pnpm, { installed: true, version: null, supported: false })
  assert.doesNotMatch(JSON.stringify(plan), /private-dsh-value|private-pnpm-value|plan-probe-redaction/)
})
