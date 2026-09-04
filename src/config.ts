/** Plugin configuration schema (schemastery-validated, editable from DSH config layers). */
import Schema from '@deepseek-ai/schemastery'
import type { DigitalEmployeeConfig, GroupAccess, ImageMode, SenderAccess } from './setup-state.js'

export type ReplyMode = 'aicard' | 'markdown' | 'text'

export interface AccountConfig {
  id: string
  enabled: boolean
  clientId: string
  clientSecret: string
  clientIdRef: string
  clientSecretRef: string
  ownerStaffId: string
  senderAccess?: SenderAccess
  allowedSenders?: string[]
  groupAccess?: GroupAccess
  groupAllowlist: string[]
  sessionScope?: 'chat' | 'chat-sender'
}

export interface Config {
  accounts: AccountConfig[]
  digitalEmployees: DigitalEmployeeConfig[]
  clientId: string
  clientSecret: string
  workspace: string
  markdownTitle: string
  interactionCardTemplateId: string
  ownerStaffId: string
  senderAccess: SenderAccess
  allowedSenders: string[]
  groupAccess: GroupAccess
  groupAllowlist: string[]
  replyMode: { direct: ReplyMode; group: ReplyMode }
  streaming: { enabled: boolean; throttleMs: number; maxCardChars: number }
  asyncMode: boolean
  ackText: string
  queueAckText: string
  questionTimeoutMs: number
  approvalTimeoutMs: number
  tools: { enabled: boolean }
  sessionScope: 'chat' | 'chat-sender'
  imageMode: ImageMode
  /** 旧配置兼容；true 等价于 always，false 等价于 never。 */
  attachImages?: boolean
  emotionFirstResponse: boolean
  rejectNotice: boolean
  debug: boolean
}

const ReplyModeSchema: Schema<ReplyMode> = Schema.union(['aicard', 'markdown', 'text'])

const AccountConfigSchema: Schema<AccountConfig> = Schema.object({
  id: Schema.string().required().description('机器人标识：小写字母开头，可含数字和连字符，最长 32 位'),
  enabled: Schema.boolean().default(true).description('是否启动该机器人的 Stream 连接'),
  clientId: Schema.string().default('').description('兼容手工配置；推荐留空并使用 DSH 凭据引用'),
  clientSecret: Schema.string().role('secret').default('').description('兼容手工配置；推荐留空并使用 DSH 凭据引用'),
  clientIdRef: Schema.string().default('').description('DSH 凭据存储中的 Client ID 引用名'),
  clientSecretRef: Schema.string().default('').description('DSH 凭据存储中的 Client Secret 引用名'),
  ownerStaffId: Schema.string().default('').description('该机器人的唯一管理员；留空时通过 setup 绑定'),
  senderAccess: Schema.union(['all', 'owner', 'allowlist']).description(
    '该机器人的发送者访问策略；未配置时默认账号兼容读取根级策略，其他账号仅管理员',
  ),
  allowedSenders: Schema.array(Schema.string()).description('该机器人允许的额外 sender staffId'),
  groupAccess: Schema.union(['all', 'none', 'allowlist']).description(
    '该机器人的群聊访问策略；未配置时从群白名单安全推导',
  ),
  groupAllowlist: Schema.array(Schema.string()).default([]).description('该机器人允许使用的群聊白名单'),
  sessionScope: Schema.union(['chat', 'chat-sender']).description('该机器人的群聊会话隔离粒度'),
})

const DigitalEmployeeConfigSchema: Schema<DigitalEmployeeConfig> = Schema.object({
  agentUuid: Schema.string().required().description('DWS 返回的稳定数字员工 UUID'),
  name: Schema.string().description('数字员工展示名'),
  enabled: Schema.boolean().default(true).description('是否启动该数字员工 Channel'),
  dwsProfile: Schema.string().required().description('精确的 DWS corpId:userId Profile selector'),
  operatorOpenDingTalkId: Schema.string().required().description('唯一 operator 的 OpenDingTalkId'),
  allowedDirectSenders: Schema.array(Schema.string()).default([]).description('允许私聊的 OpenDingTalkId'),
  allowedGroups: Schema.array(Schema.string()).default([]).description('允许群聊的 openConversationId'),
  sessionScope: Schema.union(['chat', 'chat-sender']).default('chat').description('群聊会话隔离粒度'),
  protocolVersion: Schema.union([1]).default(1).description('DWS/DSH 数字员工协议版本；首期固定为 1'),
})

export const Config: Schema<Config> = Schema.object({
  accounts: Schema.array(AccountConfigSchema)
    .default([])
    .description('多机器人列表；为空时兼容读取下方旧版单机器人配置'),
  digitalEmployees: Schema.array(DigitalEmployeeConfigSchema)
    .default([])
    .description('数字员工 Channel；为空时不要求安装 DWS，也不改变机器人行为'),
  clientId: Schema.string().default('').description('钉钉应用 clientId（AppKey）；留空则读环境变量 DINGTALK_CLIENT_ID'),
  clientSecret: Schema.string()
    .role('secret')
    .default('')
    .description('钉钉应用 clientSecret（AppSecret）；留空则读环境变量 DINGTALK_CLIENT_SECRET'),
  workspace: Schema.string().default('').description('Agent 会话工作目录（绝对路径）；留空用 ~/dsh-dingtalk-workspace'),
  markdownTitle: Schema.string().default('DSH').description('markdown 正文无法提取会话摘要时使用的兜底标题'),
  interactionCardTemplateId: Schema.string()
    .default('')
    .description('可选的审批/Plan Review 互动卡片模板 ID；留空时管理员私聊使用一次性文字确认码，群聊审批拒绝'),
  ownerStaffId: Schema.string()
    .default('')
    .description('唯一管理员 staffId；留空时需通过本机 setup 生成的一次性口令在私聊绑定'),
  senderAccess: Schema.union(['all', 'owner', 'allowlist'])
    .default('owner')
    .description('发送者访问策略：all=所有人；owner=仅管理员；allowlist=管理员和 allowedSenders'),
  allowedSenders: Schema.array(Schema.string())
    .default([])
    .description('senderAccess=allowlist 时允许的额外 sender staffId；管理员始终允许'),
  groupAccess: Schema.union(['all', 'none', 'allowlist'])
    .default('none')
    .description('群聊访问策略：all=所有群；none=禁止群聊；allowlist=仅 groupAllowlist'),
  groupAllowlist: Schema.array(Schema.string())
    .default([])
    .description('groupAccess=allowlist 时允许的群聊 openConversationId'),
  replyMode: Schema.object({
    direct: ReplyModeSchema.default('aicard').description('私聊回复载体'),
    group: ReplyModeSchema.default('aicard').description(
      '群聊回复载体；多 bot 群协作需 @ 其他机器人时改 markdown/text',
    ),
  }).description('回复载体：aicard=AI 卡片（支持流式）；markdown/text=普通消息（一次性）'),
  streaming: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('aicard 模式下是否增量流式刷新；false = 有卡片壳但等定稿一次性写入'),
    throttleMs: Schema.number().default(500).description('流式帧节流间隔（毫秒），过低易触发卡片接口限流'),
    maxCardChars: Schema.number()
      .default(15_000)
      .description(
        '单张卡片内容上限（字符）；超过自动定稿当前卡并滚动到新卡续写（对齐飞书 SDK 的 streamMaxElementChars 机制）',
      ),
  }).description('流式行为（仅 aicard 模式有意义）'),
  asyncMode: Schema.boolean()
    .default(false)
    .description('异步模式：收到消息立即回执，后台执行不流式，完成后一次性推送结果'),
  ackText: Schema.string().default('🫡 任务已接收，处理中...').description('asyncMode 的立即回执文案'),
  queueAckText: Schema.string()
    .default('🫡 前面还有任务在处理，本条已排队')
    .description('会话忙时的排队提示文案（排队功能在后续轮次启用）'),
  questionTimeoutMs: Schema.number()
    .min(1)
    .default(300_000)
    .description('ask_user_question 等待钉钉文字回答的超时时间（毫秒）'),
  approvalTimeoutMs: Schema.number()
    .min(1)
    .default(300_000)
    .description('敏感操作审批等待管理员私聊文字确认或卡片回调的超时时间（毫秒），超时按拒绝处理'),
  imageMode: Schema.union(['auto', 'always', 'never'])
    .default('auto')
    .description('图片处理：auto 根据当前 DSH 模型 inputModalities 判断；always 仅跳过连接器检查；never 关闭'),
  attachImages: Schema.boolean().description('旧版兼容项；请改用 imageMode。true=always，false=never'),
  emotionFirstResponse: Schema.boolean()
    .default(true)
    .description('收到消息立即在用户消息上贴「🤔思考中」表情，任务结束撤回'),
  sessionScope: Schema.union(['chat', 'chat-sender'])
    .default('chat')
    .description('会话隔离粒度：chat = 一个聊天一个会话；chat-sender = 群聊里每个成员独立会话（单聊不受影响）'),
  tools: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('开启钉钉能力工具（dws + skill）；开启后检测本机 dws 与登录态，并把 dws-cli skill 挂载到渠道工作区'),
  }).description('钉钉能力工具模块（方案 5.3：dws + skill，零 native tools）'),
  rejectNotice: Schema.boolean().default(true).description('拒绝未绑定用户或非白名单群时，是否回复通用原因提示'),
  debug: Schema.boolean().default(false).description('输出 Stream SDK 调试日志'),
})
