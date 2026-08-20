import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isSupportedNodeVersion } from './node-version.js'
import type { DingTalkAppCredentials } from './credentials.js'

export type DiagnosticStatus = 'pass' | 'warn' | 'fail'

export interface DiagnosticCheck {
  id: 'node' | 'credentials' | 'owner' | 'interaction-card' | 'ai-card' | 'stream'
  status: DiagnosticStatus
  title: string
  detail: string
}

interface CapabilityState {
  aiCard?: { available?: boolean; reason?: string; observedAt?: number }
}

interface RuntimeState {
  stream?: { status?: string; observedAt?: number }
}

const STREAM_STATUS_FRESH_MS = 30_000

export interface DiagnosticOptions extends DingTalkAppCredentials {
  stateDir: string
  interactionCardTemplateId: string
  configuredOwner?: string
  verifyCredentials?: (clientId: string, clientSecret: string) => Promise<boolean>
}

function readJson(file: string): any | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export async function verifyDingTalkCredentials(clientId: string, clientSecret: string): Promise<boolean> {
  const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  })
  return response.ok
}

/** 收集只读诊断项；不会创建卡片、发送消息或修改应用配置。 */
export async function collectDiagnostics(options: DiagnosticOptions): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = []
  checks.push({
    id: 'node',
    status: isSupportedNodeVersion(process.versions.node) ? 'pass' : 'fail',
    title: 'Node.js',
    detail: `当前 ${process.versions.node}，要求 ^22.19.0 或 >=24.0.0`,
  })

  const runtime = readJson(path.join(options.stateDir, 'runtime.json')) as RuntimeState | undefined
  const streamStatus = runtime?.stream?.status
  const streamObservedAt = runtime?.stream?.observedAt
  const streamFresh = typeof streamObservedAt === 'number' && Date.now() - streamObservedAt <= STREAM_STATUS_FRESH_MS
  checks.push({
    id: 'stream',
    status:
      streamStatus === 'connected' && streamFresh
        ? 'pass'
        : streamStatus === 'reconnecting' && streamFresh
          ? 'fail'
          : 'warn',
    title: 'Stream 连接',
    detail:
      streamStatus && streamFresh
        ? `最近运行状态：${streamStatus}（${new Date(streamObservedAt!).toLocaleString()}）`
        : streamStatus
          ? `状态记录已过期，Connector 可能已经离线（最后状态：${streamStatus}）`
          : '未发现 Connector 运行状态；请确认插件已加入 web profile 且 dsh web 正在运行',
  })

  if (!options.clientId || !options.clientSecret) {
    checks.push({
      id: 'credentials',
      status: 'fail',
      title: '应用凭据',
      detail: '缺少 clientId/clientSecret 或对应环境变量',
    })
  } else if (!options.verifyCredentials) {
    checks.push({ id: 'credentials', status: 'warn', title: '应用凭据', detail: '已配置，但本次未执行联网验证' })
  } else {
    try {
      const valid = await options.verifyCredentials(options.clientId, options.clientSecret)
      checks.push({
        id: 'credentials',
        status: valid ? 'pass' : 'fail',
        title: '应用凭据',
        detail: valid ? 'accessToken 获取成功' : 'accessToken 获取失败，请核对 AppKey/AppSecret',
      })
    } catch (error) {
      checks.push({
        id: 'credentials',
        status: 'fail',
        title: '应用凭据',
        detail: `联网验证失败：${error instanceof Error ? error.message : error}`,
      })
    }
  }

  const owner = readJson(path.join(options.stateDir, 'owner.json'))
  const ownerStaffId = options.configuredOwner || owner?.ownerStaffId
  checks.push({
    id: 'owner',
    status: ownerStaffId ? 'pass' : 'fail',
    title: '唯一管理员',
    detail: ownerStaffId ? '已完成绑定或显式配置' : '尚未绑定；请先运行 setup 并在机器人私聊发送绑定指令',
  })

  checks.push({
    id: 'interaction-card',
    status: options.interactionCardTemplateId ? 'pass' : 'warn',
    title: '审批交互',
    detail: options.interactionCardTemplateId
      ? '已配置互动卡片模板；按钮 actionId 需为 approve/reject'
      : '私聊文字审批可用；群聊敏感审批需配置互动卡片，否则将拒绝操作',
  })

  const capabilities = readJson(path.join(options.stateDir, 'capabilities.json')) as CapabilityState | undefined
  const aiCard = capabilities?.aiCard
  checks.push({
    id: 'ai-card',
    status: aiCard?.available === false ? 'fail' : 'warn',
    title: 'AI Card 流式权限',
    detail:
      aiCard?.available === false
        ? `${aiCard.reason ?? '运行期已确认不可用'}；无需重装插件，请在钉钉开放平台为当前应用开通权限后重启 DSH`
        : '尚无运行期失败记录；发送一条真实消息后才能最终验证 Card.Streaming.Write',
  })
  return checks
}
