import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { accountStateDir, DEFAULT_ACCOUNT_ID } from './accounts.js'
import {
  collectDiagnostics,
  verifyDingTalkCredentials,
  type DiagnosticCheck,
  type DiagnosticCode,
} from './diagnostics.js'
import {
  enabledConfiguredWebProfileAccounts,
  loadDingTalkAccountCredentials,
  loadWebProfileConfig,
} from './setup-state.js'

export type DoctorMode = 'online' | 'offline'
export type DoctorResult = 'pass' | 'warning' | 'fail' | 'unverified' | 'error'

export interface DoctorCheck {
  id:
    | DiagnosticCheck['id']
    | 'profile'
    | 'diagnostics'
    | 'digital-employee-config'
    | 'digital-employee-whitelist'
    | 'digital-employee-capabilities'
    | 'digital-employee-runtime'
    | 'digital-employee-subscription'
    | 'digital-employee-event'
    | 'digital-employee-reply'
    | 'digital-employee-audit'
  status: DoctorResult
  code:
    | DiagnosticCode
    | 'profile.read-error'
    | 'profile.no-enabled-accounts'
    | 'credentials.read-error'
    | 'diagnostics.collect-error'
    | 'digital-employee.configured'
    | 'digital-employee.whitelist-configured'
    | 'digital-employee.capabilities-verified'
    | 'digital-employee.capabilities-unverified'
    | 'digital-employee.ready'
    | 'digital-employee.failed'
    | 'digital-employee.unobserved'
    | 'digital-employee.stale'
    | 'digital-employee.subscription-ready'
    | 'digital-employee.subscription-unverified'
    | 'digital-employee.event-observed'
    | 'digital-employee.event-unobserved'
    | 'digital-employee.reply-observed'
    | 'digital-employee.reply-unobserved'
    | 'digital-employee.audit-observed'
    | 'digital-employee.audit-unobserved'
  message: string
}

export interface DoctorAccountReport {
  id: string
  result: DoctorResult
  checks: DoctorCheck[]
}

export interface DoctorSummary {
  total: number
  pass: number
  warning: number
  fail: number
  unverified: number
  error: number
}

export interface DoctorDigitalEmployeeReport {
  agentUuid: string
  dwsProfile: string
  protocolVersion: 1
  result: DoctorResult
  checks: DoctorCheck[]
}

export interface DoctorReport {
  schemaVersion: 1
  kind: 'doctor-report'
  mode: DoctorMode
  result: DoctorResult
  checks: DoctorCheck[]
  accounts: DoctorAccountReport[]
  digitalEmployees: DoctorDigitalEmployeeReport[]
  summary: DoctorSummary
}

export interface DoctorReportOptions {
  mode: DoctorMode
  dshHome: string
  stateDir: string
  env?: NodeJS.ProcessEnv
  verifyCredentials?: (clientId: string, clientSecret: string) => Promise<boolean>
}

const SAFE_DIAGNOSTICS: Record<DiagnosticCode, Pick<DoctorCheck, 'status' | 'message'>> = {
  'node.supported': { status: 'pass', message: 'Node.js 版本符合要求' },
  'node.unsupported': { status: 'fail', message: 'Node.js 版本不符合要求' },
  'stream.connected': { status: 'pass', message: 'Stream 最近已连接' },
  'stream.reconnecting': { status: 'fail', message: 'Stream 正在重连' },
  'stream.stale': { status: 'warning', message: 'Stream 状态记录已过期' },
  'stream.unobserved': { status: 'unverified', message: '尚未观察到 Connector 运行状态' },
  'stream.not-connected': { status: 'warning', message: 'Stream 尚未连接' },
  'credentials.missing': { status: 'fail', message: '缺少应用凭据' },
  'credentials.unverified': { status: 'unverified', message: '应用凭据已配置，但尚未联网验证' },
  'credentials.verified': { status: 'pass', message: '应用凭据联网验证成功' },
  'credentials.rejected': { status: 'fail', message: '应用凭据联网验证未通过' },
  'credentials.verification-error': { status: 'error', message: '应用凭据联网验证发生错误' },
  'owner.configured': { status: 'pass', message: '已完成管理员绑定或显式配置' },
  'owner.missing': { status: 'fail', message: '尚未完成管理员绑定' },
  'interaction-card.configured': { status: 'unverified', message: '审批互动卡片已配置，但尚未通过真实投递验证' },
  'interaction-card.not-configured': { status: 'warning', message: '审批互动卡片尚未配置' },
  'ai-card.unavailable': { status: 'fail', message: '运行期已确认 AI Card 流式能力不可用' },
  'ai-card.unverified': { status: 'unverified', message: '尚未通过真实消息验证 AI Card 流式能力' },
}

const DIGITAL_EMPLOYEE_STATUS_FRESH_MS = 30_000

function machineCheck(check: DiagnosticCheck): DoctorCheck {
  const safe = SAFE_DIAGNOSTICS[check.code]
  return { id: check.id, code: check.code, ...safe }
}

function summarize(checks: DoctorCheck[]): DoctorSummary {
  const summary: DoctorSummary = { total: checks.length, pass: 0, warning: 0, fail: 0, unverified: 0, error: 0 }
  for (const check of checks) summary[check.status] += 1
  return summary
}

function reportResult(summary: DoctorSummary): DoctorResult {
  if (summary.error) return 'error'
  if (summary.fail) return 'fail'
  if (summary.warning) return 'warning'
  if (summary.unverified) return 'unverified'
  return 'pass'
}

function createReport(
  mode: DoctorMode,
  checks: DoctorCheck[],
  accounts: DoctorAccountReport[],
  digitalEmployees: DoctorDigitalEmployeeReport[] = [],
): DoctorReport {
  const allChecks = [
    ...checks,
    ...accounts.flatMap((account) => account.checks),
    ...digitalEmployees.flatMap((employee) => employee.checks),
  ]
  const summary = summarize(allChecks)
  return {
    schemaVersion: 1,
    kind: 'doctor-report',
    mode,
    result: reportResult(summary),
    checks,
    accounts,
    digitalEmployees,
    summary,
  }
}

function observedCheck(
  observed: boolean,
  id: DoctorCheck['id'],
  presentCode: DoctorCheck['code'],
  absentCode: DoctorCheck['code'],
  presentMessage: string,
  absentMessage: string,
): DoctorCheck {
  return observed
    ? { id, status: 'pass', code: presentCode, message: presentMessage }
    : { id, status: 'unverified', code: absentCode, message: absentMessage }
}

async function collectDigitalEmployeeReport(
  employee: Awaited<ReturnType<typeof loadWebProfileConfig>>['digitalEmployees'][number],
  stateDir: string,
): Promise<DoctorDigitalEmployeeReport> {
  const checks: DoctorCheck[] = [
    {
      id: 'digital-employee-config',
      status: 'pass',
      code: 'digital-employee.configured',
      message: '数字员工身份、精确 DWS Profile 和协议版本已配置',
    },
    {
      id: 'digital-employee-whitelist',
      status: 'pass',
      code: 'digital-employee.whitelist-configured',
      message: `operator 已配置；额外私聊白名单 ${employee.allowedDirectSenders.length} 人，群白名单 ${employee.allowedGroups.length} 个`,
    },
  ]
  let runtime: Record<string, unknown> | undefined
  try {
    const value = JSON.parse(
      await readFile(path.join(stateDir, 'digital-employees', employee.agentUuid, 'runtime.json'), 'utf8'),
    )
    if (value && typeof value === 'object' && !Array.isArray(value)) runtime = value as Record<string, unknown>
  } catch {
    // 未启动或状态文件不可读都只能标记为未验证，不猜测凭据或正文原因。
  }
  const observedAt = typeof runtime?.observedAt === 'number' ? runtime.observedAt : undefined
  const age = observedAt === undefined ? undefined : Date.now() - observedAt
  const runtimeFresh = age !== undefined && age >= 0 && age <= DIGITAL_EMPLOYEE_STATUS_FRESH_MS
  checks.push(
    observedCheck(
      runtimeFresh && typeof runtime?.capabilitiesVerifiedAt === 'number',
      'digital-employee-capabilities',
      'digital-employee.capabilities-verified',
      'digital-employee.capabilities-unverified',
      'DWS event/reply/operator-private 契约与本地必需审计已通过运行时探测',
      '尚未观察到兼容 DWS 能力探测结果',
    ),
  )
  if (runtime && !runtimeFresh) {
    checks.push({
      id: 'digital-employee-runtime',
      status: 'unverified',
      code: 'digital-employee.stale',
      message: '数字员工运行状态记录已过期，不能据此判断进程仍存活',
    })
  } else if (runtime?.state === 'ready') {
    checks.push({
      id: 'digital-employee-runtime',
      status: 'pass',
      code: 'digital-employee.ready',
      message: '数字员工事件进程已 ready',
    })
  } else if (runtime?.state === 'failed') {
    const failureCode =
      typeof runtime.failureCode === 'string' && /^[a-z0-9_.-]{1,128}$/i.test(runtime.failureCode)
        ? runtime.failureCode
        : 'unknown'
    checks.push({
      id: 'digital-employee-runtime',
      status: 'fail',
      code: 'digital-employee.failed',
      message: `数字员工事件进程启动或运行失败（${failureCode}）`,
    })
  } else {
    checks.push({
      id: 'digital-employee-runtime',
      status: 'unverified',
      code: 'digital-employee.unobserved',
      message: '尚未观察到数字员工事件进程 ready 状态',
    })
  }
  const topics = Array.isArray(runtime?.subscriptionTopics) ? runtime.subscriptionTopics : []
  const subscriptionsReady =
    runtimeFresh &&
    topics.includes('user_im_message_receive_o2o_all') &&
    topics.includes('user_im_message_receive_group_all')
  checks.push(
    observedCheck(
      subscriptionsReady,
      'digital-employee-subscription',
      'digital-employee.subscription-ready',
      'digital-employee.subscription-unverified',
      '单聊与群聊事件订阅均已就绪',
      '尚未观察到完整的单聊与群聊订阅',
    ),
    observedCheck(
      runtimeFresh && typeof runtime?.lastEventAt === 'number',
      'digital-employee-event',
      'digital-employee.event-observed',
      'digital-employee.event-unobserved',
      '已观察到最近事件（不展示正文）',
      '尚未观察到事件',
    ),
    observedCheck(
      runtimeFresh && typeof runtime?.lastReplyAt === 'number',
      'digital-employee-reply',
      'digital-employee.reply-observed',
      'digital-employee.reply-unobserved',
      '已观察到最近回复（不展示正文）',
      '尚未观察到回复',
    ),
    observedCheck(
      runtimeFresh && typeof runtime?.lastAuditAt === 'number',
      'digital-employee-audit',
      'digital-employee.audit-observed',
      'digital-employee.audit-unobserved',
      '已观察到最近本地审计成功',
      '尚未观察到本地审计成功',
    ),
  )
  return {
    agentUuid: employee.agentUuid,
    dwsProfile: employee.dwsProfile,
    protocolVersion: 1,
    result: reportResult(summarize(checks)),
    checks,
  }
}

/** 收集供自动化消费的完整诊断报告；所有 message 都来自固定脱敏文案。 */
export async function collectDoctorReport(options: DoctorReportOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env
  let profile
  try {
    profile = await loadWebProfileConfig(options.dshHome)
  } catch {
    return createReport(
      options.mode,
      [{ id: 'profile', status: 'error', code: 'profile.read-error', message: '读取 web profile 配置失败' }],
      [],
    )
  }

  const enabledAccounts = await enabledConfiguredWebProfileAccounts(options.dshHome, profile)
  const digitalEmployees = await Promise.all(
    profile.digitalEmployees
      .filter((employee) => employee.enabled)
      .map((employee) => collectDigitalEmployeeReport(employee, options.stateDir)),
  )
  if (!enabledAccounts.length && !digitalEmployees.length) {
    return createReport(
      options.mode,
      [
        {
          id: 'profile',
          status: 'fail',
          code: 'profile.no-enabled-accounts',
          message: 'web profile 中没有启用的钉钉机器人',
        },
      ],
      [],
    )
  }

  const accounts: DoctorAccountReport[] = []
  for (const account of enabledAccounts) {
    let credentials
    try {
      credentials = await loadDingTalkAccountCredentials(options.dshHome, account.id, account)
    } catch {
      const checks: DoctorCheck[] = [
        { id: 'credentials', status: 'error', code: 'credentials.read-error', message: '读取应用凭据失败' },
      ]
      accounts.push({ id: account.id, result: reportResult(summarize(checks)), checks })
      continue
    }

    try {
      const diagnostics = await collectDiagnostics({
        stateDir: accountStateDir(options.stateDir, account.id),
        clientId: credentials?.clientId ?? '',
        clientSecret: credentials?.clientSecret ?? '',
        interactionCardTemplateId: profile.interactionCardTemplateId || env.DINGTALK_INTERACTION_CARD_TEMPLATE_ID || '',
        configuredOwner:
          account.ownerStaffId ||
          (account.id === DEFAULT_ACCOUNT_ID ? profile.ownerStaffId || env.DINGTALK_OWNER_STAFF_ID || '' : ''),
        verifyCredentials:
          options.mode === 'offline' ? undefined : (options.verifyCredentials ?? verifyDingTalkCredentials),
      })
      const checks = diagnostics.map(machineCheck)
      accounts.push({ id: account.id, result: reportResult(summarize(checks)), checks })
    } catch {
      const checks: DoctorCheck[] = [
        { id: 'diagnostics', status: 'error', code: 'diagnostics.collect-error', message: '收集诊断信息失败' },
      ]
      accounts.push({ id: account.id, result: reportResult(summarize(checks)), checks })
    }
  }

  return createReport(options.mode, [], accounts, digitalEmployees)
}
