/**
 * Human-readable failure states: a turn that dies mid-run freezes the card
 * with a classified Chinese label instead of a raw English stack, so "卡在
 * 思考中" and unexplained silence never happen (community-connector lesson:
 * 503/欠费/无通道 must settle visibly).
 */

interface Rule {
  pattern: RegExp
  label: string
  hint?: string
}

const CODE_RULES: Record<string, Omit<Rule, 'pattern'>> = {
  MISSING_CREDENTIAL: {
    label: '模型凭据未配置',
    hint: '打开 dsh web 的 Models 页面补充对应模型凭据后重试',
  },
}

const RULES: Rule[] = [
  { pattern: /\{\{model\}\}/, label: '会话未配置模型路由', hint: '用 /model use <provider>/<model> 指定后重试' },
  { pattern: /timed?.?out|ETIMEDOUT|deadline/i, label: '模型响应超时', hint: '稍后重发即可' },
  { pattern: /429|rate.?limit|qps|too many requests/i, label: '模型限流', hint: '稍等一会再发' },
  {
    pattern: /401|403|unauthorized|forbidden|invalid.*(key|token)|credential|欠费|quota|insufficient/i,
    label: '模型凭据无效或额度不足',
    hint: '检查 dsh web 设置里的模型凭据',
  },
  {
    pattern: /context|token.*(limit|exceed)|too (long|large)|maximum.*length/i,
    label: '上下文超出模型限制',
    hint: '用 /new 重开会话',
  },
  {
    pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EBADF|fetch failed|network|socket/i,
    label: '模型服务连接失败',
    hint: '确认本机模型桥/网络可用',
  },
  {
    pattern: /404|not found|no such model|unknown model/i,
    label: '模型或接口路径不存在',
    hint: '用 /model 检查当前路由是否有效',
  },
  { pattern: /5\d\d|internal server|service unavailable|无通道/i, label: '模型服务端错误', hint: '稍后重发即可' },
]

/** Render a turn-ending error as a classified, actionable Chinese message. */
export function describeTurnError(raw: string | undefined, code?: string): string {
  const message = (raw ?? '').trim()
  const normalizedCode = (code ?? '').trim()
  if (!message && !normalizedCode) return '⚠️ 本次回复失败，请查看 dsh web 日志'

  const rule = CODE_RULES[normalizedCode] ?? RULES.find((candidate) => candidate.pattern.test(message))
  const label = rule?.label ?? '本轮执行出错'
  const hint = rule?.hint ? `（${rule.hint}）` : ''
  const lines = [`⚠️ **${label}**${hint}`]
  if (normalizedCode) lines.push(`> 错误码：\`${normalizedCode}\``)
  if (message) lines.push(`> ${message}`)
  return lines.join('\n')
}
