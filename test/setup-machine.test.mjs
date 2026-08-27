import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import {
  applyMachineSetup,
  MachineSetupInputError,
  parseMachineSetupAnswers,
  planMachineSetup,
  resumeMachineSetup,
  resumePrivateSetup,
} from '../lib/setup-machine.js'

class FakeRunner {
  calls = []

  constructor({
    dshInstalled = true,
    pnpmVersion = '11.7.0',
    installedPnpmVersion = '11.7.0',
    pluginFailure = '',
    registry = 'https://registry.npmjs.org/',
  } = {}) {
    this.dshInstalled = dshInstalled
    this.pnpmVersion = pnpmVersion
    this.installedPnpmVersion = installedPnpmVersion
    this.pluginFailure = pluginFailure
    this.registry = registry
  }

  run(command, args) {
    this.calls.push([command, ...args])
    if (command === 'dsh' && args[0] === '--version') {
      return this.dshInstalled
        ? { code: 0, stdout: '0.1.0\n', stderr: '' }
        : { code: 127, stdout: '', stderr: 'not found' }
    }
    if (command === 'pnpm' && args[0] === '--version') {
      return { code: 0, stdout: `${this.pnpmVersion}\n`, stderr: '' }
    }
    if (command === 'dsh' && args[0] === 'plugin') {
      return this.pluginFailure
        ? { code: 1, stdout: '', stderr: this.pluginFailure }
        : { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'npm' && args.join(' ') === 'config get registry') {
      return { code: 0, stdout: `${this.registry}\n`, stderr: '' }
    }
    if (command === 'npm' && args[0] === 'install') {
      if (args.at(-1) === '@deepseek-ai/dsh@latest') this.dshInstalled = true
      if (args.at(-1) === 'pnpm@latest') this.pnpmVersion = this.installedPnpmVersion
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

class FakeUi {
  messages = []

  constructor(answers = {}) {
    this.answers = answers
  }

  note(message) {
    this.messages.push(message)
  }

  warn(message) {
    this.messages.push(message)
  }

  success(message) {
    this.messages.push(message)
  }

  loading() {
    return () => {}
  }

  async confirm(id, _message, initial) {
    return this.answers[id] ?? initial
  }

  async select(id, _message, _options, initial) {
    return this.answers[id] ?? initial
  }

  async text(id) {
    return this.answers[id] ?? ''
  }

  async optionalText(id, _message, initial = '') {
    return this.answers[id] ?? initial
  }

  async secret(id) {
    return this.answers[id] ?? ''
  }
}

function options(root, runner, serviceStatus = 'stopped') {
  return {
    runner,
    dshHome: path.join(root, '.dsh'),
    stateDir: path.join(root, '.dsh-dingtalk'),
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.5.2',
    serviceStatus,
  }
}

function answers(planId, overrides = {}) {
  return {
    schemaVersion: 1,
    planId,
    accountId: 'default',
    approvals: {
      installDsh: false,
      installPnpm: false,
      installPlugin: true,
      writeProfile: true,
      ...overrides.approvals,
    },
    features: {
      dwsEnabled: true,
      imageMode: 'auto',
      senderAccess: 'all',
      allowedSenders: [],
      groupAccess: 'all',
      groupAllowlist: [],
      ...overrides.features,
    },
  }
}

test('机器 answers 拒绝与访问模式不一致的多余标识', () => {
  const value = answers('setup-plan-0123456789abcdef', {
    features: { senderAccess: 'owner', allowedSenders: ['should-not-persist'] },
  })
  assert.throws(() => parseMachineSetupAnswers(value), MachineSetupInputError)
})

test('机器 setup 只执行显式批准的步骤，并在私密凭据前安全暂停', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner()
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })

  const result = await applyMachineSetup(setupOptions, answers(plan.planId))

  assert.equal(result.schemaVersion, 1)
  assert.equal(result.kind, 'setup-outcome')
  assert.equal(result.status, 'awaiting_private_credentials')
  assert.equal(result.accountId, 'default')
  assert.equal(result.next?.kind, 'private_command')
  assert.match(result.next?.command ?? '', /^npx @dingtalk-real-ai\/dsh-dingtalk@0\.5\.2 setup --resume [0-9a-f-]+$/)
  assert.deepEqual(
    runner.calls.filter((call) => call[0] === 'npm' && call[1] === 'install'),
    [],
  )
  assert.equal(
    runner.calls.findIndex((call) => call.join(' ') === 'npm config get registry') <
      runner.calls.findIndex((call) => call[0] === 'dsh' && call[1] === 'plugin'),
    true,
  )
  assert.deepEqual(
    runner.calls.find((call) => call[0] === 'dsh' && call[1] === 'plugin'),
    ['dsh', 'plugin', '--profile', 'web', 'add', '@dingtalk-real-ai/dsh-dingtalk@0.5.2'],
  )

  const checkpointFile = path.join(setupOptions.stateDir, 'setup', 'checkpoints', `${result.checkpointId}.json`)
  const checkpointText = await readFile(checkpointFile, 'utf8')
  assert.doesNotMatch(checkpointText, /clientSecret|clientId|deviceCode|verificationUri|bindCode|ownerStaffId/i)
  if (process.platform !== 'win32') assert.equal((await stat(checkpointFile)).mode & 0o777, 0o600)

  const profile = await readFile(path.join(setupOptions.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(profile, /id: default/)
  assert.match(profile, /enabled: true/)
  assert.equal(
    await readFile(path.join(setupOptions.dshHome, 'profiles', 'web', '.npmrc'), 'utf8'),
    'registry=https://registry.npmjs.org/\n',
  )
})

test('机器 setup 在必需批准缺失时不做任何安装或配置写入', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-blocked-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner({ dshInstalled: false, pnpmVersion: '9.5.0' })
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })

  const result = await applyMachineSetup(setupOptions, answers(plan.planId))

  assert.equal(result.status, 'blocked')
  assert.equal(result.error?.code, 'approval_required')
  assert.deepEqual(
    runner.calls.filter((call) => call[0] === 'npm' || (call[0] === 'dsh' && call[1] === 'plugin')),
    [],
  )
  await assert.rejects(() => stat(path.join(setupOptions.dshHome, 'profiles', 'web', 'cordis.patch.yml')), {
    code: 'ENOENT',
  })
})

test('私密 resume 仅在终端展示凭据和绑定口令，机器 resume 可幂等续跑', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-resume-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner()
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })
  const first = await applyMachineSetup(setupOptions, answers(plan.planId))
  const ui = new FakeUi({ credentialMethod: 'qr' })

  const privateResult = await resumePrivateSetup({
    ...setupOptions,
    checkpointId: first.checkpointId,
    ui,
    onboard: async () => ({ clientId: 'private-app', clientSecret: 'private-secret' }),
  })

  assert.equal(privateResult.status, 'awaiting_bind')
  assert.deepEqual(parse(await readFile(path.join(setupOptions.dshHome, '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'private-app',
    DINGTALK_CLIENT_SECRET: 'private-secret',
  })
  const displayed = ui.messages.join('\n')
  const code = displayed.match(/\/bind ([A-Z0-9]+)/)?.[1]
  assert.ok(code)
  const checkpointFile = path.join(setupOptions.stateDir, 'setup', 'checkpoints', `${first.checkpointId}.json`)
  const checkpointText = await readFile(checkpointFile, 'utf8')
  const ownerFile = path.join(setupOptions.stateDir, 'owner.json')
  const ownerText = await readFile(ownerFile, 'utf8')
  assert.doesNotMatch(checkpointText, new RegExp(code))
  assert.doesNotMatch(ownerText, new RegExp(code))
  assert.doesNotMatch(checkpointText, /private-app|private-secret/)

  const challengeState = await readFile(ownerFile, 'utf8')
  const repeatedUi = new FakeUi()
  const repeatedPrivate = await resumePrivateSetup({
    ...setupOptions,
    checkpointId: first.checkpointId,
    ui: repeatedUi,
  })
  assert.equal(repeatedPrivate.status, 'awaiting_bind')
  assert.equal(await readFile(ownerFile, 'utf8'), challengeState)
  assert.doesNotMatch(repeatedUi.messages.join('\n'), /\/bind [A-Z0-9]+/)

  await writeFile(ownerFile, JSON.stringify({ ownerStaffId: 'bound-owner' }), { mode: 0o600 })
  await chmod(ownerFile, 0o600)
  const mutationCallCount = () =>
    runner.calls.filter((call) => call[0] === 'npm' || (call[0] === 'dsh' && call[1] === 'plugin')).length
  const beforeMutations = mutationCallCount()
  const resumed = await resumeMachineSetup(setupOptions, first.checkpointId)
  const repeated = await resumeMachineSetup(setupOptions, first.checkpointId)
  assert.equal(resumed.status, 'start_required')
  assert.equal(repeated.status, 'start_required')
  assert.equal(mutationCallCount(), beforeMutations)

  const uncertain = await resumeMachineSetup({ ...setupOptions, serviceStatus: 'unknown' }, first.checkpointId)
  assert.equal(uncertain.status, 'restart_required')

  const completed = await resumeMachineSetup({ ...setupOptions, serviceStatus: 'running' }, first.checkpointId)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.next, undefined)
})

test('私密 resume 在已有凭据早退前修复当前 DSH 不可读的文档格式', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-repair-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner()
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })
  const first = await applyMachineSetup(setupOptions, answers(plan.planId))
  const credentialsFile = path.join(setupOptions.dshHome, '.credentials.yaml')
  await writeFile(
    credentialsFile,
    'version: 1\nrefs:\n  DINGTALK_CLIENT_ID: existing-app\n  DINGTALK_CLIENT_SECRET: existing-secret\n',
    { mode: 0o600 },
  )
  const ui = new FakeUi()

  const result = await resumePrivateSetup({
    ...setupOptions,
    checkpointId: first.checkpointId,
    ui,
  })

  assert.equal(result.status, 'awaiting_bind')
  assert.deepEqual(parse(await readFile(credentialsFile, 'utf8')), {
    DINGTALK_CLIENT_ID: 'existing-app',
    DINGTALK_CLIENT_SECRET: 'existing-secret',
  })
  assert.match(ui.messages.join('\n'), /凭据文档已转换为当前安装可读取的格式/)
  assert.match(ui.messages.join('\n'), /已有凭据；私密接力未修改现有 Client Secret/)
})

test('私密 resume 也拒绝改用 checkpoint 未批准的插件版本', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-private-plan-drift-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner()
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })
  const first = await applyMachineSetup(setupOptions, answers(plan.planId))
  let onboardCalled = false

  await assert.rejects(
    () =>
      resumePrivateSetup({
        ...setupOptions,
        installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.5.3',
        checkpointId: first.checkpointId,
        ui: new FakeUi(),
        onboard: async () => {
          onboardCalled = true
          return { clientId: 'private-app', clientSecret: 'private-secret' }
        },
      }),
    (error) => error instanceof MachineSetupInputError && error.code === 'plan_changed',
  )
  assert.equal(onboardCalled, false)
  await assert.rejects(() => stat(path.join(setupOptions.stateDir, 'owner.json')), { code: 'ENOENT' })
})

test('机器 setup 返回结构化安装诊断且不泄露子进程原文', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-error-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner({
    pluginFailure: [
      '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh-fs-local@^0.1.1-rc.2',
      'while fetching it from https://build-user:private-secret@packages.example.test/',
      'This error happened while installing the dependencies of @deepseek-ai/dsh-base@0.1.1-rc.2',
      'npm error authToken=private-secret',
    ].join('\n'),
  })
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })

  const result = await applyMachineSetup(setupOptions, answers(plan.planId))

  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'command_failed')
  assert.equal(result.error?.stepId, 'install-plugin')
  assert.equal(result.error?.stage, 'plugin_install')
  assert.equal(result.error?.errorCode, 'ERR_PNPM_NO_MATCHING_VERSION')
  assert.match(result.error?.primaryMessage ?? '', /No matching version found/)
  assert.equal(result.error?.package, '@deepseek-ai/dsh-fs-local@^0.1.1-rc.2')
  assert.equal(result.error?.registry, 'https://packages.example.test/')
  assert.equal(result.error?.dependency, '@deepseek-ai/dsh-base@0.1.1-rc.2')
  assert.match(result.error?.suggestedAction ?? '', /当前 registry 可能缺少该版本/)
  assert.match(result.error?.logPath ?? '', /[/\\]logs[/\\]setup-.+plugin_install-.+\.log$/)
  assert.doesNotMatch(JSON.stringify(result), /private-secret/)
  assert.doesNotMatch(await readFile(result.error.logPath, 'utf8'), /private-secret/)
  const checkpointText = await readFile(
    path.join(setupOptions.stateDir, 'setup', 'checkpoints', `${result.checkpointId}.json`),
    'utf8',
  )
  assert.doesNotMatch(checkpointText, /private-secret/)
})

test('并发 resume 同一 checkpoint 只执行一次尚未完成的外部步骤', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-concurrent-resume-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner({ pluginFailure: 'temporary failure' })
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })
  const first = await applyMachineSetup(setupOptions, answers(plan.planId))
  assert.equal(first.status, 'failed')
  runner.pluginFailure = ''
  const before = runner.calls.filter((call) => call[0] === 'dsh' && call[1] === 'plugin').length

  const results = await Promise.all([
    resumeMachineSetup(setupOptions, first.checkpointId),
    resumeMachineSetup(setupOptions, first.checkpointId),
  ])

  assert.deepEqual(
    results.map((result) => result.status),
    ['awaiting_private_credentials', 'awaiting_private_credentials'],
  )
  const after = runner.calls.filter((call) => call[0] === 'dsh' && call[1] === 'plugin').length
  assert.equal(after - before, 1)
})

test('机器 setup 安装 pnpm 后仍验证主版本，不把旧版本误报为成功', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-pnpm-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new FakeRunner({ pnpmVersion: '9.5.0', installedPnpmVersion: '9.6.0' })
  const setupOptions = options(root, runner)
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })

  const result = await applyMachineSetup(setupOptions, answers(plan.planId, { approvals: { installPnpm: true } }))

  assert.equal(result.status, 'failed')
  assert.equal(result.error?.stepId, 'install-pnpm')
  assert.equal(result.error?.code, 'command_failed')
  assert.equal(
    runner.calls.some(([command, subcommand]) => command === 'dsh' && subcommand === 'plugin'),
    false,
  )
})

test('checkpoint 绑定获批的精确插件版本，部分执行后也拒绝用新版本续跑', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-plan-drift-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const firstRunner = new FakeRunner({ dshInstalled: false, pluginFailure: 'temporary failure' })
  const firstOptions = options(root, firstRunner)
  const plan = await planMachineSetup(firstOptions, { accountId: 'default' })
  const failed = await applyMachineSetup(firstOptions, answers(plan.planId, { approvals: { installDsh: true } }))

  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.completedStepIds, ['install-dsh'])

  const secondRunner = new FakeRunner()
  const resumed = await resumeMachineSetup(
    { ...options(root, secondRunner), installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.5.3' },
    failed.checkpointId,
  )

  assert.equal(resumed.status, 'failed')
  assert.equal(resumed.error?.code, 'environment_changed')
  assert.equal(
    secondRunner.calls.some((call) => call[0] === 'dsh' && call[1] === 'plugin'),
    false,
  )
})

test('机器 setup 会启用显式选择的 disabled 账号，使完成后的 doctor 能发现它', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-disabled-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const setupOptions = options(root, new FakeRunner())
  const profileFile = path.join(setupOptions.dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await mkdir(path.dirname(profileFile), { recursive: true })
  await writeFile(
    profileFile,
    '- id: dingtalk-channel\n  config:\n    accounts:\n      - id: default\n        enabled: false\n',
  )
  const plan = await planMachineSetup(setupOptions, { accountId: 'default' })

  const result = await applyMachineSetup(setupOptions, answers(plan.planId))

  assert.equal(result.status, 'awaiting_private_credentials')
  assert.match(await readFile(profileFile, 'utf8'), /id: default\n\s+enabled: true/)
})

test('机器 setup 保留既有账号的自定义凭据引用并据此判断凭据已配置', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-machine-custom-refs-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const setupOptions = options(root, new FakeRunner())
  const profileFile = path.join(setupOptions.dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await mkdir(path.dirname(profileFile), { recursive: true })
  await writeFile(
    profileFile,
    '- id: dingtalk-channel\n  config:\n    accounts:\n      - id: custom-bot\n        enabled: true\n        clientIdRef: CUSTOM_ID\n        clientSecretRef: CUSTOM_SECRET\n        ownerStaffId: bound-owner\n',
  )
  await writeFile(
    path.join(setupOptions.dshHome, '.credentials.yaml'),
    'version: 1\nrefs:\n  CUSTOM_ID: custom-app\n  CUSTOM_SECRET: custom-secret\n',
    { mode: 0o600 },
  )
  const plan = await planMachineSetup(setupOptions, { accountId: 'custom-bot' })
  assert.equal(
    plan.actions.some((action) => action.id === 'private-credentials'),
    false,
  )

  const result = await applyMachineSetup(setupOptions, { ...answers(plan.planId), accountId: 'custom-bot' })

  assert.equal(result.status, 'start_required')
  const profile = await readFile(profileFile, 'utf8')
  assert.match(profile, /clientIdRef: CUSTOM_ID/)
  assert.match(profile, /clientSecretRef: CUSTOM_SECRET/)
  assert.doesNotMatch(profile, /DINGTALK_ACCOUNT_CUSTOM_BOT/)
})
