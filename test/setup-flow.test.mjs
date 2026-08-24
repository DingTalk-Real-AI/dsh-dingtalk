import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import { issueBindingChallenge } from '../lib/owner.js'
import { runGuidedSetup } from '../lib/setup.js'
import {
  saveDingTalkAccountCredentials,
  saveDingTalkCredentials,
  upsertWebProfileAccount,
  updateWebProfileConfig,
} from '../lib/setup-state.js'

class FakeUi {
  messages = []
  selections = []
  prompted = []
  confirmMessages = new Map()
  constructor(overrides = {}) {
    this.overrides = overrides
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
  loading(message) {
    this.messages.push(`开始加载：${message}`)
    return () => this.messages.push(`结束加载：${message}`)
  }
  async confirm(id, message, initial) {
    this.confirmMessages.set(id, message)
    return this.overrides[id] ?? initial
  }
  async select(id, message, options, initial) {
    this.selections.push({ id, message, options })
    return this.overrides[id] ?? initial
  }
  async text(id) {
    return this.overrides[id] ?? ''
  }
  async optionalText(id, _message, initial = '') {
    this.prompted.push(id)
    return this.overrides[id] ?? initial
  }
  async secret(id) {
    return this.overrides[id] ?? ''
  }
}

class FakeRunner {
  calls = []
  run(command, args) {
    this.calls.push([command, ...args])
    if (command === 'dsh' && args[0] === '--version') return { code: 0, stdout: '0.1.0\n', stderr: '' }
    if (command === 'pnpm' && args[0] === '--version') return { code: 0, stdout: '11.7.0\n', stderr: '' }
    if (command === 'npm' && args[0] === 'view') return { code: 0, stdout: '"0.1.0"\n', stderr: '' }
    if (command === 'dsh' && args[0] === 'plugin') return { code: 0, stdout: '', stderr: '' }
    if (command === 'dws') return { code: 1, stdout: '', stderr: 'not installed' }
    return { code: 1, stdout: '', stderr: 'unexpected command' }
  }
}

class ExistingOlderDshRunner extends FakeRunner {
  run(command, args) {
    if (command === 'dsh' && args[0] === '--version') {
      this.calls.push([command, ...args])
      return { code: 0, stdout: '0.1.0-rc.7\n', stderr: '' }
    }
    return super.run(command, args)
  }
}

class OldPnpmRunner extends FakeRunner {
  pnpmChecks = 0
  run(command, args) {
    if (command === 'pnpm' && args[0] === '--version') {
      this.calls.push([command, ...args])
      this.pnpmChecks += 1
      return { code: 0, stdout: this.pnpmChecks === 1 ? '9.5.0\n' : '11.7.0\n', stderr: '' }
    }
    if (command === 'npm' && args.join(' ') === 'install --global pnpm@latest') {
      this.calls.push([command, ...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    return super.run(command, args)
  }
}

test('首次 setup 自动安装精确插件版本并完成完整引导', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-setup-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  const ui = new FakeUi({
    credentialMethod: 'manual',
    clientId: 'ding-app',
    clientSecret: 'super-secret',
    dwsEnabled: false,
    imageMode: 'auto',
    startWeb: false,
  })
  const runner = new FakeRunner()

  const result = await runGuidedSetup({
    ui,
    runner,
    dshHome,
    stateDir,
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.1.0-beta.1',
  })

  assert.equal(result.code, 0)
  assert.equal(result.startWeb, false)
  assert.deepEqual(
    runner.calls.find((call) => call[1] === 'plugin'),
    ['dsh', 'plugin', '--profile', 'web', 'add', '@dingtalk-real-ai/dsh-dingtalk@0.1.0-beta.1'],
  )
  assert.deepEqual(
    ui.messages.filter((message) => message.includes('安装 DSH web profile 插件')),
    ['开始加载：正在安装 DSH web profile 插件…', '结束加载：正在安装 DSH web profile 插件…'],
  )
  assert.match(ui.messages.join('\n'), /\/bind [A-Z0-9]+/)
  assert.match(ui.messages.join('\n'), /dsh web 启动且日志显示已连接后/)
  assert.match(ui.confirmMessages.get('startWeb'), /日志显示机器人已连接/)
  assert.doesNotMatch(ui.messages.join('\n'), /super-secret/)
  assert.doesNotMatch(ui.prompted.join(','), /interactionCardTemplateId/)
  assert.deepEqual(parse(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'ding-app',
    DINGTALK_CLIENT_SECRET: 'super-secret',
  })
  assert.deepEqual(parse(await readFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')), [
    {
      id: 'dingtalk-channel',
      config: {
        accounts: [
          {
            id: 'default',
            enabled: true,
            clientIdRef: 'DINGTALK_CLIENT_ID',
            clientSecretRef: 'DINGTALK_CLIENT_SECRET',
            senderAccess: 'all',
            allowedSenders: [],
            groupAccess: 'all',
            groupAllowlist: [],
            sessionScope: 'chat-sender',
          },
        ],
        tools: { enabled: false },
        imageMode: 'auto',
      },
    },
  ])
  assert.match(ui.messages.join('\n'), /input: \[text, image\]/)
})

test('已有旧版 DSH 时 setup 不检查 latest 或要求升级', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-existing-dsh-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const ui = new FakeUi({
    credentialMethod: 'manual',
    clientId: 'ding-app',
    clientSecret: 'test-only-secret',
    startWeb: false,
  })
  const runner = new ExistingOlderDshRunner()

  const result = await runGuidedSetup({
    ui,
    runner,
    dshHome: path.join(root, '.dsh'),
    stateDir: path.join(root, '.dsh-dingtalk'),
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.5.0',
  })

  assert.equal(result.code, 0)
  assert.equal(
    runner.calls.some((call) => call[0] === 'npm' && call[1] === 'view'),
    false,
  )
  assert.equal(ui.confirmMessages.has('updateDsh'), false)
  assert.deepEqual(
    runner.calls.find((call) => call[0] === 'dsh' && call[1] === 'plugin'),
    ['dsh', 'plugin', '--profile', 'web', 'add', '@dingtalk-real-ai/dsh-dingtalk@0.5.0'],
  )
})

test('重复 setup 可只修改功能配置并保留现有凭据', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-reconfigure-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await saveDingTalkCredentials(dshHome, { clientId: 'existing-id', clientSecret: 'existing-secret' })
  await updateWebProfileConfig(dshHome, {
    dwsEnabled: false,
    imageMode: 'auto',
    interactionCardTemplateId: 'existing-template.schema',
  })
  const ui = new FakeUi({
    setupAction: 'features',
    dwsEnabled: true,
    imageMode: 'never',
    senderAccess: 'allowlist',
    allowedSenders: 'member-1, member-2 member-1',
    groupAccess: 'allowlist',
    groupAllowlist: 'group-1，group-2',
    startWeb: false,
  })

  const result = await runGuidedSetup({
    ui,
    runner: new FakeRunner(),
    dshHome,
    stateDir,
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.1.0-beta.2',
  })

  assert.equal(result.code, 0)
  assert.match(ui.confirmMessages.get('startWeb'), /\/bind/)
  assert.deepEqual(parse(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'existing-id',
    DINGTALK_CLIENT_SECRET: 'existing-secret',
  })
  assert.match(ui.messages.join('\n'), /机器人 default 的一次性管理员绑定口令/)
  assert.deepEqual(parse(await readFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')), [
    {
      id: 'dingtalk-channel',
      config: {
        accounts: [
          {
            id: 'default',
            enabled: true,
            clientIdRef: 'DINGTALK_CLIENT_ID',
            clientSecretRef: 'DINGTALK_CLIENT_SECRET',
            senderAccess: 'allowlist',
            allowedSenders: ['member-1', 'member-2'],
            groupAccess: 'allowlist',
            groupAllowlist: ['group-1', 'group-2'],
            sessionScope: 'chat-sender',
          },
        ],
        tools: { enabled: true },
        imageMode: 'never',
        interactionCardTemplateId: 'existing-template.schema',
      },
    },
  ])
})

test('修改功能配置不会使仍有效的机器人绑定口令失效', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-preserve-challenge-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await saveDingTalkCredentials(dshHome, { clientId: 'existing-id', clientSecret: 'existing-secret' })
  await upsertWebProfileAccount(dshHome, 'default')
  const ownerFile = path.join(stateDir, 'owner.json')
  issueBindingChallenge(ownerFile, 10 * 60_000)
  const before = await readFile(ownerFile, 'utf8')
  const ui = new FakeUi({ setupAction: 'features', dwsEnabled: false, imageMode: 'auto', startWeb: false })

  const result = await runGuidedSetup({
    ui,
    runner: new FakeRunner(),
    dshHome,
    stateDir,
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.2.2',
  })

  assert.equal(result.code, 0)
  assert.equal(await readFile(ownerFile, 'utf8'), before)
  assert.match(ui.messages.join('\n'), /机器人 default 已有有效的管理员绑定口令/)
  assert.doesNotMatch(ui.confirmMessages.get('startWeb'), /\/bind/)
})

test('重复 setup 可新增第二个机器人账号且不覆盖默认账号', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-add-account-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await saveDingTalkCredentials(dshHome, { clientId: 'default-id', clientSecret: 'default-secret' })
  await upsertWebProfileAccount(dshHome, 'default')
  const ui = new FakeUi({
    setupAction: 'add-account',
    accountId: 'support-bot',
    credentialMethod: 'manual',
    clientId: 'support-id',
    clientSecret: 'support-secret',
    startWeb: false,
  })

  const result = await runGuidedSetup({
    ui,
    runner: new FakeRunner(),
    dshHome,
    stateDir,
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.2.0-beta.1',
  })

  assert.equal(result.code, 0)
  assert.deepEqual(parse(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'default-id',
    DINGTALK_CLIENT_SECRET: 'default-secret',
    DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID: 'support-id',
    DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET: 'support-secret',
  })
  const profile = parse(await readFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(
    profile[0].config.accounts.map((account) => account.id),
    ['default', 'support-bot'],
  )
  assert.deepEqual(
    profile[0].config.accounts.find((account) => account.id === 'support-bot'),
    {
      id: 'support-bot',
      enabled: true,
      clientIdRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID',
      clientSecretRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET',
      senderAccess: 'all',
      allowedSenders: [],
      groupAccess: 'all',
      groupAllowlist: [],
      sessionScope: 'chat-sender',
    },
  )
  assert.match(ui.messages.join('\n'), /机器人 support-bot/)
  assert.match(ui.messages.join('\n'), /\/bind [A-Z0-9]+/)
  await readFile(path.join(stateDir, 'accounts', 'support-bot', 'owner.json'), 'utf8')
})

test('绑定菜单按机器人展示绑定状态，并一次生成所有已启用未绑定机器人的口令', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-binding-robots-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await saveDingTalkCredentials(dshHome, { clientId: 'default-id', clientSecret: 'default-secret' })
  await upsertWebProfileAccount(dshHome, 'default')
  await saveDingTalkAccountCredentials(dshHome, 'support-bot', {
    clientId: 'support-id',
    clientSecret: 'support-secret',
  })
  await upsertWebProfileAccount(dshHome, 'support-bot')
  await import('node:fs/promises').then((fs) => fs.mkdir(stateDir, { recursive: true }))
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({ ownerStaffId: 'default-owner' })),
  )
  const ui = new FakeUi({ setupAction: 'binding', accountId: 'default', startWeb: false })

  const result = await runGuidedSetup({
    ui,
    runner: new FakeRunner(),
    dshHome,
    stateDir,
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.2.2',
  })

  assert.equal(result.code, 0)
  const accountSelection = ui.selections.find((selection) => selection.id === 'accountId')
  assert.equal(accountSelection?.message, '请选择要查看或重新绑定的钉钉机器人')
  assert.deepEqual(
    accountSelection?.options.map((option) => option.label),
    ['default（已绑定）', 'support-bot（待绑定）'],
  )
  assert.match(ui.messages.join('\n'), /机器人 default 的唯一管理员已经绑定/)
  assert.match(ui.messages.join('\n'), /机器人 support-bot 的一次性管理员绑定口令/)
  assert.match(ui.messages.join('\n'), /启动 dsh web 后，请分别私聊已显示口令的机器人发送对应的 \/bind 口令/)
})

test('setup 菜单中的只读诊断按账号展示结果', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-setup-doctor-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await saveDingTalkCredentials(dshHome, { clientId: 'default-id', clientSecret: 'default-secret' })
  await upsertWebProfileAccount(dshHome, 'default')
  await saveDingTalkAccountCredentials(dshHome, 'support-bot', {
    clientId: 'support-id',
    clientSecret: 'support-secret',
  })
  await upsertWebProfileAccount(dshHome, 'support-bot')
  const ui = new FakeUi({ setupAction: 'doctor' })

  const result = await runGuidedSetup({
    ui,
    runner: new FakeRunner(),
    dshHome,
    stateDir,
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.2.0-beta.1',
  })

  assert.equal(result.runDoctor, true)
  assert.match(ui.messages.join('\n'), /\[default\]/)
  assert.match(ui.messages.join('\n'), /\[support-bot\]/)
  assert.equal((ui.messages.join('\n').match(/应用凭据：已配置/g) ?? []).length, 2)
})

test('setup 自动升级不兼容的旧 pnpm 后再安装插件', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-pnpm-upgrade-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const runner = new OldPnpmRunner()
  const result = await runGuidedSetup({
    ui: new FakeUi({
      credentialMethod: 'manual',
      clientId: 'ding-app',
      clientSecret: 'test-only-secret',
      startWeb: false,
    }),
    runner,
    dshHome: path.join(root, '.dsh'),
    stateDir: path.join(root, '.dsh-dingtalk'),
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.1.0-beta.1',
  })

  assert.equal(result.code, 0)
  assert.deepEqual(
    runner.calls.find((call) => call.join(' ') === 'npm install --global pnpm@latest'),
    ['npm', 'install', '--global', 'pnpm@latest'],
  )
  const upgradeIndex = runner.calls.findIndex((call) => call.join(' ') === 'npm install --global pnpm@latest')
  const pluginIndex = runner.calls.findIndex((call) => call[0] === 'dsh' && call[1] === 'plugin')
  assert.ok(upgradeIndex >= 0 && pluginIndex > upgradeIndex)
})
