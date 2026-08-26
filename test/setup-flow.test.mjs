import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import { issueBindingChallenge } from '../lib/owner.js'
import { credentialLayoutForDshVersion, runGuidedSetup } from '../lib/setup.js'
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

class PluginFailureRunner extends FakeRunner {
  run(command, args) {
    if (command === 'dsh' && args[0] === 'plugin') {
      this.calls.push([command, ...args])
      return { code: 1, stdout: '', stderr: 'plugin install failed' }
    }
    return super.run(command, args)
  }
}

class PluginPnpmFailureRunner extends FakeRunner {
  run(command, args) {
    if (command === 'dsh' && args[0] === 'plugin') {
      this.calls.push([command, ...args])
      return {
        code: 1,
        stdout: [
          'Progress: resolved 20, reused 19, downloaded 0, added 0',
          '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh-fs-local@^0.1.1-rc.2',
          'while fetching it from https://build-user:private-secret@packages.example.test/',
          'This error happened while installing the dependencies of @deepseek-ai/dsh-base@0.1.1-rc.2',
          '',
        ].join('\n'),
        stderr: [
          'dsh: initialized profile web at /tmp/.dsh/profiles/web',
          'dsh: pnpm failed in profile directory /tmp/.dsh/profiles/web',
          '',
        ].join('\n'),
      }
    }
    return super.run(command, args)
  }
}

class CategorizedPluginFailureRunner extends FakeRunner {
  constructor(stderr) {
    super()
    this.stderr = stderr
  }

  run(command, args) {
    if (command === 'dsh' && args[0] === 'plugin') {
      this.calls.push([command, ...args])
      return { code: 1, stdout: '', stderr: this.stderr }
    }
    return super.run(command, args)
  }
}

class BootstrapInstallFailureRunner extends FakeRunner {
  constructor(stage) {
    super()
    this.stage = stage
  }

  run(command, args) {
    if (this.stage === 'dsh_install' && command === 'dsh' && args[0] === '--version') {
      this.calls.push([command, ...args])
      return { code: 127, stdout: '', stderr: 'command not found' }
    }
    if (this.stage === 'pnpm_install' && command === 'pnpm' && args[0] === '--version') {
      this.calls.push([command, ...args])
      return { code: 0, stdout: '9.5.0\n', stderr: '' }
    }
    if (command === 'npm' && args[0] === 'install') {
      this.calls.push([command, ...args])
      return {
        code: 1,
        stdout: 'npm progress noise\n',
        stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for bootstrap-package@1.2.3.\n',
      }
    }
    return super.run(command, args)
  }
}

class LoadingOutcomeUi extends FakeUi {
  loadingOutcomes = []

  loading(message) {
    this.messages.push(`开始加载：${message}`)
    return (succeeded, completedMessage) => {
      this.loadingOutcomes.push({ message, succeeded, completedMessage })
    }
  }
}

class SwitchingDshRunner extends FakeRunner {
  dshChecks = 0
  run(command, args) {
    if (command === 'dsh' && args[0] === '--version') {
      this.calls.push([command, ...args])
      this.dshChecks += 1
      return { code: 0, stdout: `${this.dshChecks >= 3 ? '0.1.1-rc.1' : '0.1.0-rc.7'}\n`, stderr: '' }
    }
    return super.run(command, args)
  }
}

test('setup 按实际 DSH 版本选择凭据文档格式', () => {
  assert.equal(credentialLayoutForDshVersion('0.1.0-rc.5'), 'flat')
  assert.equal(credentialLayoutForDshVersion('0.1.0-rc.7'), 'flat')
  assert.equal(credentialLayoutForDshVersion('0.1.0-rc.8'), 'flat')
  assert.equal(credentialLayoutForDshVersion('0.1.1-rc.1'), 'v1')
  assert.equal(credentialLayoutForDshVersion('0.1.1'), 'v1')
  assert.equal(credentialLayoutForDshVersion('1.0.0'), 'v1')
  assert.throws(() => credentialLayoutForDshVersion('not-a-version'), /无法识别 DSH 版本/)
})

test('插件安装失败时 loading 以失败态和完成态文案收尾', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-plugin-loading-failure-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const ui = new LoadingOutcomeUi()

  const result = await runGuidedSetup({
    ui,
    runner: new PluginFailureRunner(),
    dshHome: path.join(root, '.dsh'),
    stateDir: path.join(root, '.dsh-dingtalk'),
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.6.0',
  })

  assert.equal(result.code, 1)
  assert.deepEqual(ui.loadingOutcomes.at(-1), {
    message: '正在安装 DSH web profile 插件…',
    succeeded: false,
    completedMessage: 'DSH web profile 插件安装失败',
  })
})

test('插件安装失败时提取 pnpm 根因并保留完整日志', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-plugin-diagnostic-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const stateDir = path.join(root, '.dsh-dingtalk')
  const ui = new FakeUi()

  const result = await runGuidedSetup({
    ui,
    runner: new PluginPnpmFailureRunner(),
    dshHome: path.join(root, '.dsh'),
    stateDir,
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.6.0',
  })

  assert.equal(result.code, 1)
  const displayed = ui.messages.join('\n')
  assert.match(displayed, /插件安装失败/)
  assert.match(displayed, /错误码：ERR_PNPM_NO_MATCHING_VERSION/)
  assert.match(displayed, /包：@deepseek-ai\/dsh-fs-local@\^0\.1\.1-rc\.2/)
  assert.match(displayed, /Registry：https:\/\/packages\.example\.test\//)
  assert.match(displayed, /依赖：@deepseek-ai\/dsh-base@0\.1\.1-rc\.2/)
  assert.doesNotMatch(displayed, /private-secret/)
  assert.match(displayed, /建议：当前 registry 可能缺少该版本/)
  assert.doesNotMatch(displayed, /Progress: resolved/)

  const logPath = displayed.match(/完整日志：(.+)/)?.[1]
  assert.ok(logPath)
  assert.match(logPath, new RegExp(`^${path.join(stateDir, 'logs').replaceAll('\\', '\\\\')}`))
  const log = await readFile(logPath, 'utf8')
  assert.match(log, /Progress: resolved 20/)
  assert.match(log, /dsh: pnpm failed in profile directory/)
  assert.doesNotMatch(log, /private-secret/)
  if (process.platform !== 'win32') assert.equal((await stat(logPath)).mode & 0o777, 0o600)
})

test('安装失败按权限、网络和磁盘错误给出可执行建议', async (t) => {
  const cases = [
    ['npm error code EACCES\nnpm error permission denied', /检查 npm 全局目录和目标目录权限/],
    ['npm error code ENOTFOUND\nnpm error network registry unavailable', /检查网络、代理、DNS 和 registry 可达性/],
    ['npm error code ENOSPC\nnpm error no space left on device', /清理磁盘空间后重试/],
  ]

  for (const [stderr, suggestion] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-categorized-diagnostic-'))
    t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
    const ui = new FakeUi()
    const result = await runGuidedSetup({
      ui,
      runner: new CategorizedPluginFailureRunner(stderr),
      dshHome: path.join(root, '.dsh'),
      stateDir: path.join(root, '.dsh-dingtalk'),
      installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.6.0',
    })

    assert.equal(result.code, 1)
    assert.match(ui.messages.join('\n'), suggestion)
  }
})

test('DSH 与 pnpm 安装失败共用结构化摘要和完整日志', async (t) => {
  const cases = [
    ['dsh_install', /DSH 安装失败/],
    ['pnpm_install', /pnpm 安装失败/],
  ]

  for (const [stage, title] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-bootstrap-diagnostic-'))
    t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
    const ui = new FakeUi()
    const result = await runGuidedSetup({
      ui,
      runner: new BootstrapInstallFailureRunner(stage),
      dshHome: path.join(root, '.dsh'),
      stateDir: path.join(root, '.dsh-dingtalk'),
      installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.6.0',
    })

    assert.equal(result.code, 2)
    const displayed = ui.messages.join('\n')
    assert.match(displayed, title)
    assert.match(displayed, new RegExp(`阶段：${stage}`))
    assert.match(displayed, /错误码：ETARGET/)
    assert.match(displayed, /包：bootstrap-package@1\.2\.3/)
    assert.doesNotMatch(displayed, /npm progress noise/)
    const logPath = displayed.match(/完整日志：(.+)/)?.[1]
    assert.ok(logPath)
    assert.match(await readFile(logPath, 'utf8'), /npm progress noise/)
  }
})

test('setup 在交互完成后的实际写入点重新探测 DSH 版本', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-switching-dsh-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const runner = new SwitchingDshRunner()

  const result = await runGuidedSetup({
    ui: new FakeUi({
      credentialMethod: 'manual',
      clientId: 'ding-app',
      clientSecret: 'test-only-secret',
      startWeb: false,
    }),
    runner,
    dshHome,
    stateDir: path.join(root, '.dsh-dingtalk'),
    installSpec: '@dingtalk-real-ai/dsh-dingtalk@0.5.0',
  })

  assert.equal(result.code, 0)
  assert.deepEqual(parse(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')), {
    version: 1,
    refs: {
      DINGTALK_CLIENT_ID: 'ding-app',
      DINGTALK_CLIENT_SECRET: 'test-only-secret',
    },
  })
})

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
  assert.deepEqual(parse(await readFile(path.join(root, '.dsh', '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'ding-app',
    DINGTALK_CLIENT_SECRET: 'test-only-secret',
  })
})

test('重复 setup 可只修改功能配置并保留现有凭据', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-reconfigure-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await saveDingTalkCredentials(
    dshHome,
    { clientId: 'existing-id', clientSecret: 'existing-secret' },
    { layout: 'flat' },
  )
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
  await saveDingTalkCredentials(
    dshHome,
    { clientId: 'existing-id', clientSecret: 'existing-secret' },
    { layout: 'flat' },
  )
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
  await saveDingTalkCredentials(dshHome, { clientId: 'default-id', clientSecret: 'default-secret' }, { layout: 'flat' })
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
  await saveDingTalkCredentials(dshHome, { clientId: 'default-id', clientSecret: 'default-secret' }, { layout: 'flat' })
  await upsertWebProfileAccount(dshHome, 'default')
  await saveDingTalkAccountCredentials(
    dshHome,
    'support-bot',
    { clientId: 'support-id', clientSecret: 'support-secret' },
    { layout: 'flat' },
  )
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
  await saveDingTalkCredentials(dshHome, { clientId: 'default-id', clientSecret: 'default-secret' }, { layout: 'flat' })
  await upsertWebProfileAccount(dshHome, 'default')
  await saveDingTalkAccountCredentials(
    dshHome,
    'support-bot',
    { clientId: 'support-id', clientSecret: 'support-secret' },
    { layout: 'flat' },
  )
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
