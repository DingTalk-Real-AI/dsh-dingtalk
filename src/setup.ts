import path from 'node:path'

import { accountStateDir, assertAccountId, DEFAULT_ACCOUNT_ID } from './accounts.js'
import { collectDiagnostics } from './diagnostics.js'
import { isSupportedNodeVersion } from './node-version.js'
import { beginRegistration, renderQr, waitForCredentials } from './onboard.js'
import { issueBindingChallenge, OwnerBinding } from './owner.js'
import {
  enabledWebProfileAccounts,
  loadDingTalkCredentials,
  loadDingTalkAccountCredentials,
  loadWebProfileConfig,
  removeLegacyDingTalkCredentials,
  saveDingTalkAccountCredentials,
  saveDingTalkCredentials,
  upsertWebProfileAccount,
  updateWebProfileAccountAccess,
  updateWebProfileConfig,
  type DingTalkCredentials,
  type GroupAccess,
  type ImageMode,
  type SenderAccess,
  type WebProfileAccount,
  type WebProfileConfig,
} from './setup-state.js'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(command: string, args: string[]): CommandResult
}

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SetupUi {
  note(message: string): void
  warn(message: string): void
  success(message: string): void
  loading(message: string): () => void
  confirm(id: string, message: string, initial: boolean): Promise<boolean>
  select<T extends string>(id: string, message: string, options: readonly SelectOption<T>[], initial: T): Promise<T>
  text(id: string, message: string): Promise<string>
  optionalText(id: string, message: string, initial?: string): Promise<string>
  secret(id: string, message: string): Promise<string>
}

async function runWithLoading(
  ui: SetupUi,
  runner: CommandRunner,
  message: string,
  command: string,
  args: string[],
): Promise<CommandResult> {
  const stopLoading = ui.loading(message)
  try {
    return runner.run(command, args)
  } finally {
    stopLoading()
  }
}

export interface RunGuidedSetupOptions {
  ui: SetupUi
  runner: CommandRunner
  dshHome: string
  stateDir: string
  installSpec: string
  onboard?: () => Promise<Pick<DingTalkCredentials, 'clientId' | 'clientSecret'>>
}

export interface GuidedSetupResult {
  code: number
  startWeb: boolean
  runDoctor?: boolean
}

type SetupAction = 'full' | 'add-account' | 'credentials' | 'features' | 'binding' | 'doctor'

function cleanVersion(output: string): string {
  const trimmed = output.trim()
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === 'string' ? parsed.trim() : trimmed
  } catch {
    return trimmed.replace(/^v/, '').split(/\s+/)[0] ?? ''
  }
}

async function ensureLatestDsh(ui: SetupUi, runner: CommandRunner): Promise<boolean> {
  let installed = await runWithLoading(ui, runner, '正在检查 DeepSeek Harness…', 'dsh', ['--version'])
  if (installed.code !== 0) {
    if (!(await ui.confirm('installDsh', '未检测到 DeepSeek Harness，是否安装最新版？', true))) return false
    const install = await runWithLoading(ui, runner, '正在安装最新版 DeepSeek Harness…', 'npm', [
      'install',
      '--global',
      '@deepseek-ai/dsh@latest',
    ])
    if (install.code !== 0) {
      ui.warn(`DSH 安装失败：${install.stderr.trim() || 'npm 返回非零状态'}`)
      return false
    }
    installed = await runWithLoading(ui, runner, '正在确认 DeepSeek Harness 安装结果…', 'dsh', ['--version'])
    if (installed.code !== 0) {
      ui.warn('DSH 安装完成后仍无法执行，请检查全局 npm bin 是否在 PATH。')
      return false
    }
  }

  const latest = await runWithLoading(ui, runner, '正在检查 DeepSeek Harness 最新版本…', 'npm', [
    'view',
    '@deepseek-ai/dsh',
    'version',
    '--json',
  ])
  if (latest.code !== 0) {
    ui.warn('无法连接 NPM 检查 DSH 最新版本；将继续使用当前版本，doctor 会标记为未验证。')
    return true
  }
  const installedVersion = cleanVersion(installed.stdout)
  const latestVersion = cleanVersion(latest.stdout)
  if (installedVersion && latestVersion && installedVersion !== latestVersion) {
    const update = await ui.confirm(
      'updateDsh',
      `当前 DSH ${installedVersion}，支持版本为最新的 ${latestVersion}。是否升级？`,
      true,
    )
    if (!update) {
      ui.warn('当前 DSH 不在第一版支持范围，setup 已停止。')
      return false
    }
    const upgraded = await runWithLoading(ui, runner, '正在升级 DeepSeek Harness…', 'npm', [
      'install',
      '--global',
      `@deepseek-ai/dsh@${latestVersion}`,
    ])
    if (upgraded.code !== 0) {
      ui.warn(`DSH 升级失败：${upgraded.stderr.trim() || 'npm 返回非零状态'}`)
      return false
    }
  }
  return true
}

async function ensurePnpm(ui: SetupUi, runner: CommandRunner): Promise<boolean> {
  let current = await runWithLoading(ui, runner, '正在检查 pnpm 版本…', 'pnpm', ['--version'])
  const major = Number(cleanVersion(current.stdout).split('.')[0])
  if (current.code === 0 && Number.isFinite(major) && major >= 11) return true

  const detail = current.code === 0 ? `当前 pnpm ${cleanVersion(current.stdout)}` : '未检测到 pnpm'
  const install = await ui.confirm(
    'installPnpm',
    `${detail}；最新版 DSH 插件 profile 需要 pnpm >= 11，是否安装最新版？`,
    true,
  )
  if (!install) return false

  const installed = await runWithLoading(ui, runner, '正在安装最新版 pnpm…', 'npm', [
    'install',
    '--global',
    'pnpm@latest',
  ])
  if (installed.code !== 0) {
    ui.warn(`pnpm 安装失败：${installed.stderr.trim() || 'npm 返回非零状态'}`)
    return false
  }
  current = await runWithLoading(ui, runner, '正在确认 pnpm 安装结果…', 'pnpm', ['--version'])
  if (current.code !== 0 || Number(cleanVersion(current.stdout).split('.')[0]) < 11) {
    ui.warn('pnpm 安装后仍不可用或版本过旧，请检查全局 npm bin 和 PATH。')
    return false
  }
  return true
}

async function defaultOnboard(ui: SetupUi): Promise<Pick<DingTalkCredentials, 'clientId' | 'clientSecret'>> {
  ui.note('正在向钉钉申请扫码注册…')
  const begin = await beginRegistration()
  const qr = await renderQr(begin.verificationUriComplete)
  ui.note(qr ?? `请在手机钉钉打开：${begin.verificationUriComplete}`)
  ui.note(`扫码链接：${begin.verificationUriComplete}`)
  return waitForCredentials(begin)
}

async function configureCredentials(options: RunGuidedSetupOptions, accountId: string): Promise<boolean> {
  const { ui, dshHome } = options
  const current = await loadDingTalkAccountCredentials(dshHome, accountId)
  if (accountId === DEFAULT_ACCOUNT_ID && current?.source === 'legacy-env') {
    const migrate = await ui.confirm('migrateLegacy', '检测到 ~/.dsh/.env 中的旧凭据，是否迁移到 DSH 凭据存储？', true)
    if (migrate) {
      await saveDingTalkCredentials(dshHome, current)
      await removeLegacyDingTalkCredentials(dshHome)
      ui.success('旧凭据已迁移，普通 .env 中的钉钉凭据已移除。')
      return true
    }
  }

  const method = await ui.select(
    'credentialMethod',
    '请选择钉钉应用接入方式',
    [
      { value: 'qr', label: '扫码创建应用（推荐）' },
      { value: 'manual', label: '填写已有 Client ID / Client Secret' },
    ],
    'qr',
  )
  const credentials =
    method === 'qr'
      ? await (options.onboard ?? (() => defaultOnboard(ui)))()
      : {
          clientId: (await ui.text('clientId', 'Client ID（AppKey）')).trim(),
          clientSecret: (await ui.secret('clientSecret', 'Client Secret（AppSecret）')).trim(),
        }
  await saveDingTalkAccountCredentials(dshHome, accountId, credentials)
  await upsertWebProfileAccount(dshHome, accountId)
  ui.success(`钉钉机器人 ${accountId} 的应用凭据已安全写入 DSH 凭据存储。`)
  return true
}

function parseIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，、\s]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ]
}

function accountAccess(profile: WebProfileConfig, accountId: string) {
  const account = profile.accounts.find((item) => item.id === accountId)
  const useLegacyRoot = accountId === DEFAULT_ACCOUNT_ID
  const senderAccess = account?.senderAccess ?? (useLegacyRoot ? profile.senderAccess : 'owner')
  const allowedSenders = account?.allowedSenders ?? (useLegacyRoot ? profile.allowedSenders : [])
  const groupAllowlist = account?.groupAllowlist ?? (useLegacyRoot ? profile.groupAllowlist : [])
  const groupAccess =
    account?.groupAccess ?? (useLegacyRoot ? profile.groupAccess : groupAllowlist.length ? 'allowlist' : 'none')
  const sessionScope = account?.sessionScope ?? (useLegacyRoot ? profile.sessionScope : 'chat')
  return { senderAccess, allowedSenders, groupAccess, groupAllowlist, sessionScope }
}

async function configureAccess(
  options: RunGuidedSetupOptions,
  accountId: string,
  defaultToAll: boolean,
): Promise<void> {
  const { ui, dshHome } = options
  const current = accountAccess(await loadWebProfileConfig(dshHome), accountId)
  const senderAccess = await ui.select<SenderAccess>(
    'senderAccess',
    `机器人 ${accountId}：除管理员外，哪些发送者可以使用？`,
    [
      { value: 'all', label: '所有人（推荐，默认）' },
      { value: 'owner', label: '仅管理员' },
      { value: 'allowlist', label: '仅指定 sender staffId' },
    ],
    defaultToAll ? 'all' : current.senderAccess,
  )
  const allowedSenders =
    senderAccess === 'allowlist'
      ? parseIds(
          await ui.text('allowedSenders', '请输入允许的 sender staffId，多个值用逗号或空格分隔（管理员无需填写）'),
        )
      : []
  if (senderAccess === 'allowlist' && !allowedSenders.length) {
    ui.warn('未填写有效 sender staffId；当前效果等同于仅管理员。')
  }

  const groupAccess = await ui.select<GroupAccess>(
    'groupAccess',
    `机器人 ${accountId}：允许在哪些群聊中响应？`,
    [
      { value: 'all', label: '所有群（推荐，默认）' },
      { value: 'none', label: '禁止群聊' },
      { value: 'allowlist', label: '仅指定群 openConversationId' },
    ],
    defaultToAll ? 'all' : current.groupAccess,
  )
  const groupAllowlist =
    groupAccess === 'allowlist'
      ? parseIds(
          await ui.text(
            'groupAllowlist',
            '请输入允许群的 openConversationId，多个值用逗号或空格分隔；可先运行 `dws chat +chat-search --query "群名" --format json` 查询',
          ),
        )
      : []
  if (groupAccess === 'allowlist' && !groupAllowlist.length) {
    ui.warn('未填写有效群 openConversationId；当前不会响应任何群聊。')
  }
  await updateWebProfileAccountAccess(dshHome, accountId, {
    senderAccess,
    allowedSenders,
    groupAccess,
    groupAllowlist,
    sessionScope: groupAccess === 'none' ? current.sessionScope : 'chat-sender',
  })
}

async function configureFeatures(
  options: RunGuidedSetupOptions,
  accountId: string,
  defaultAccessToAll: boolean,
): Promise<void> {
  const { ui, runner, dshHome } = options
  const current = await loadWebProfileConfig(dshHome)
  const dwsEnabled = await ui.confirm('dwsEnabled', '是否启用 DWS 工具能力？', current.dwsEnabled)
  const imageMode = await ui.select<ImageMode>(
    'imageMode',
    '图片处理模式',
    [
      { value: 'auto', label: 'Auto：按当前 DSH 模型能力判断（推荐）' },
      { value: 'always', label: 'Always：跳过连接器检查（模型仍须支持图片）' },
      { value: 'never', label: 'Never：禁用图片输入' },
    ],
    current.imageMode,
  )
  ui.note(
    '图片模式只控制连接器接收策略。模型本身仍须支持图片；自定义模型请在 DSH settings.yaml 的模型条目声明 `input: [text, image]`，然后重启 dsh web。',
  )
  // 管理员私聊的敏感审批默认使用一次性文字确认码。互动卡片是群聊审批所需的高级增强，
  // 保留已有配置，但不要求仅使用私聊的普通安装者在卡片平台手工建模板。
  await updateWebProfileConfig(dshHome, { dwsEnabled, imageMode })
  await configureAccess(options, accountId, defaultAccessToAll)
  if (dwsEnabled) {
    const version = await runWithLoading(ui, runner, '正在检查 DWS CLI…', 'dws', ['--version'])
    if (version.code !== 0) ui.warn('已开启 DWS，但本机未检测到 dws CLI；钉钉消息能力不受影响。')
    else {
      const auth = await runWithLoading(ui, runner, '正在检查 DWS 登录状态…', 'dws', [
        'auth',
        'status',
        '--format',
        'json',
      ])
      if (auth.code !== 0) ui.warn('DWS 尚未登录；请稍后执行 dws auth login。')
    }
  }
  ui.success('插件功能配置已写入 DSH web profile。')
}

function ownerBinding(
  stateDir: string,
  robot: Pick<WebProfileAccount, 'id' | 'ownerStaffId' | 'groupAllowlist'>,
): OwnerBinding {
  return new OwnerBinding({
    file: path.join(accountStateDir(stateDir, robot.id), 'owner.json'),
    configuredOwner: robot.ownerStaffId ?? '',
    legacyAllowedSenders: [],
    allowedGroups: robot.groupAllowlist ?? [],
  })
}

function configureBinding(
  ui: SetupUi,
  stateDir: string,
  robot: Pick<WebProfileAccount, 'id' | 'ownerStaffId' | 'groupAllowlist'>,
  regenerate = false,
): boolean {
  const binding = ownerBinding(stateDir, robot)
  const status = binding.status()
  if (status.bound) {
    ui.note(`机器人 ${robot.id} 的唯一管理员已经绑定；setup 未修改现有绑定。`)
    return false
  }
  if (status.challengeReady && !regenerate) {
    ui.note(`机器人 ${robot.id} 已有有效的管理员绑定口令；若未保存，请选择“查看或重新生成机器人管理员绑定口令”。`)
    return false
  }
  const challenge = issueBindingChallenge(path.join(accountStateDir(stateDir, robot.id), 'owner.json'), 10 * 60_000)
  ui.note(
    `机器人 ${robot.id} 的一次性管理员绑定口令：\n\n/bind ${challenge.code}\n\n` +
      '口令已生成，但机器人要在 dsh web 启动且日志显示已连接后才能接收消息。请先在下方启动 dsh web；若选择稍后启动，请手动运行 dsh web 并确认已连接，再在 10 分钟内私聊该机器人发送口令。不要发到群聊。',
  )
  return true
}

function isRobotBound(
  stateDir: string,
  robot: Pick<WebProfileAccount, 'id' | 'ownerStaffId' | 'groupAllowlist'>,
): boolean {
  return ownerBinding(stateDir, robot).status().bound
}

async function chooseRobot(
  ui: SetupUi,
  stateDir: string,
  robots: WebProfileAccount[],
  prompt: string,
): Promise<string> {
  if (robots.length === 1) return robots[0].id
  return ui.select(
    'accountId',
    prompt,
    robots.map((robot) => ({
      value: robot.id,
      label: `${robot.id}（${isRobotBound(stateDir, robot) ? '已绑定' : '待绑定'}）`,
    })),
    robots[0].id,
  )
}

async function showOfflineDoctor(options: RunGuidedSetupOptions): Promise<void> {
  const profile = await loadWebProfileConfig(options.dshHome)
  const accounts = enabledWebProfileAccounts(profile)
  if (!accounts.length) {
    options.ui.note('WARN 钉钉机器人：profile 中没有启用的钉钉机器人')
    return
  }
  for (const account of accounts) {
    const credentials = await loadDingTalkAccountCredentials(options.dshHome, account.id, account)
    const checks = await collectDiagnostics({
      stateDir: accountStateDir(options.stateDir, account.id),
      clientId: credentials?.clientId ?? '',
      clientSecret: credentials?.clientSecret ?? '',
      interactionCardTemplateId: profile.interactionCardTemplateId,
      configuredOwner: account.ownerStaffId || (account.id === DEFAULT_ACCOUNT_ID ? profile.ownerStaffId || '' : ''),
    })
    if (accounts.length > 1) options.ui.note(`[${account.id}]`)
    for (const check of checks) options.ui.note(`${check.status.toUpperCase()} ${check.title}：${check.detail}`)
  }
}

export async function runGuidedSetup(options: RunGuidedSetupOptions): Promise<GuidedSetupResult> {
  const { ui, runner, dshHome, stateDir, installSpec } = options
  if (!isSupportedNodeVersion(process.versions.node)) {
    ui.warn(`当前 Node.js ${process.versions.node}，要求 ^22.19.0 或 >=24.0.0。`)
    return { code: 2, startWeb: false }
  }
  if (!(await ensureLatestDsh(ui, runner))) return { code: 2, startWeb: false }
  if (!(await ensurePnpm(ui, runner))) return { code: 2, startWeb: false }

  const installed = await runWithLoading(ui, runner, '正在安装 DSH web profile 插件…', 'dsh', [
    'plugin',
    '--profile',
    'web',
    'add',
    installSpec,
  ])
  if (installed.code !== 0) {
    ui.warn(`插件安装失败：${installed.stderr.trim() || 'dsh plugin 返回非零状态'}`)
    return { code: 1, startWeb: false }
  }
  ui.success(`插件已安装到 DSH web profile：${installSpec}`)

  let profile = await loadWebProfileConfig(dshHome)
  const existingDefaultCredentials = await loadDingTalkCredentials(dshHome)
  // 老版本只有默认凭据，没有 accounts[]。任何一次 setup 都原地迁移，并清理 profile 明文覆盖。
  if (existingDefaultCredentials && !profile.accounts.length) {
    await upsertWebProfileAccount(dshHome, DEFAULT_ACCOUNT_ID)
    profile = await loadWebProfileConfig(dshHome)
  }
  const robots = profile.accounts
  const robotIds = robots.map((robot) => robot.id)
  const hasExistingRobot = robotIds.length > 0
  const action: SetupAction = hasExistingRobot
    ? await ui.select(
        'setupAction',
        '请选择要执行的配置操作',
        [
          { value: 'full', label: '重新执行完整引导' },
          { value: 'add-account', label: '新增钉钉机器人' },
          { value: 'credentials', label: '修改现有机器人凭据' },
          { value: 'features', label: '修改 DWS、图片与访问范围' },
          { value: 'binding', label: '查看或重新生成机器人管理员绑定口令' },
          { value: 'doctor', label: '运行只读诊断' },
        ],
        'features',
      )
    : 'full'

  if (action === 'doctor') {
    await showOfflineDoctor(options)
    return { code: 0, startWeb: false, runDoctor: true }
  }
  let selectedRobot = DEFAULT_ACCOUNT_ID
  const bindingPrepared = new Set<string>()
  if (action === 'add-account') {
    selectedRobot = assertAccountId(await ui.text('accountId', '新机器人标识（如 support-bot）'))
    if (robotIds.includes(selectedRobot))
      throw new Error(`钉钉机器人 ${selectedRobot} 已存在，请选择“修改现有机器人凭据”`)
    await configureCredentials(options, selectedRobot)
    await configureAccess(options, selectedRobot, true)
    if (configureBinding(ui, stateDir, { id: selectedRobot })) bindingPrepared.add(selectedRobot)
  } else if (action === 'credentials') {
    selectedRobot = await chooseRobot(ui, stateDir, robots, '请选择要修改凭据的钉钉机器人')
    await configureCredentials(options, selectedRobot)
  } else if (action === 'full') {
    selectedRobot = robotIds.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (robotIds[0] ?? DEFAULT_ACCOUNT_ID)
    await configureCredentials(options, selectedRobot)
  } else if (action === 'features') {
    selectedRobot = await chooseRobot(ui, stateDir, robots, '请选择要修改访问范围的钉钉机器人')
  }
  if (action === 'full' || action === 'features') {
    await configureFeatures(options, selectedRobot, !hasExistingRobot)
  }
  if (action === 'full') {
    const selected = (await loadWebProfileConfig(dshHome)).accounts.find((robot) => robot.id === selectedRobot) ?? {
      id: selectedRobot,
      enabled: true,
      clientIdRef: '',
      clientSecretRef: '',
    }
    if (configureBinding(ui, stateDir, selected)) bindingPrepared.add(selectedRobot)
  }
  if (action === 'binding') {
    selectedRobot = await chooseRobot(ui, stateDir, robots, '请选择要查看或重新绑定的钉钉机器人')
    const selected = robots.find((robot) => robot.id === selectedRobot)
    if (selected && configureBinding(ui, stateDir, selected, true)) bindingPrepared.add(selectedRobot)
  }
  const enabledRobots = enabledWebProfileAccounts(await loadWebProfileConfig(dshHome))
  const unboundRobots = enabledRobots.filter((robot) => !isRobotBound(stateDir, robot))
  for (const robot of unboundRobots) {
    if (bindingPrepared.has(robot.id)) continue
    if (configureBinding(ui, stateDir, robot)) bindingPrepared.add(robot.id)
  }
  if (unboundRobots.length) {
    ui.note(
      `待绑定机器人：${unboundRobots.map((robot) => robot.id).join('、')}。启动 dsh web 后，请分别私聊已显示口令的机器人发送对应的 /bind 口令；若提示已有有效口令但未保存，请在绑定菜单中重新生成。`,
    )
  }
  const startWeb = await ui.confirm(
    'startWeb',
    bindingPrepared.size
      ? '配置完成。是否立即启动 dsh web？启动后请等待日志显示机器人已连接，再分别发送上方对应的 /bind 口令。'
      : '配置完成。是否立即启动 dsh web？',
    true,
  )
  ui.success('setup 配置阶段完成。')
  return { code: 0, startWeb }
}
