import { accountStateDir, DEFAULT_ACCOUNT_ID } from './accounts.js'
import {
  collectDiagnostics,
  verifyDingTalkCredentials,
  type DiagnosticCheck,
  type DiagnosticCode,
} from './diagnostics.js'
import { enabledWebProfileAccounts, loadDingTalkAccountCredentials, loadWebProfileConfig } from './setup-state.js'

export type DoctorMode = 'online' | 'offline'
export type DoctorResult = 'pass' | 'warning' | 'fail' | 'unverified' | 'error'

export interface DoctorCheck {
  id: DiagnosticCheck['id'] | 'profile' | 'diagnostics'
  status: DoctorResult
  code:
    | DiagnosticCode
    | 'profile.read-error'
    | 'profile.no-enabled-accounts'
    | 'credentials.read-error'
    | 'diagnostics.collect-error'
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

export interface DoctorReport {
  schemaVersion: 1
  kind: 'doctor-report'
  mode: DoctorMode
  result: DoctorResult
  checks: DoctorCheck[]
  accounts: DoctorAccountReport[]
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

function createReport(mode: DoctorMode, checks: DoctorCheck[], accounts: DoctorAccountReport[]): DoctorReport {
  const allChecks = [...checks, ...accounts.flatMap((account) => account.checks)]
  const summary = summarize(allChecks)
  return { schemaVersion: 1, kind: 'doctor-report', mode, result: reportResult(summary), checks, accounts, summary }
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

  const enabledAccounts = enabledWebProfileAccounts(profile)
  if (!enabledAccounts.length) {
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

  return createReport(options.mode, [], accounts)
}
