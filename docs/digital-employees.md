# DSH 数字员工 Channel

数字员工是与现有机器人平级的独立 Channel。机器人模式不依赖 DWS；只有启用了 `digitalEmployees[]` 的员工才要求本机安装兼容 DWS。普通消息使用文本事件和文本引用回复；审批／提问默认优先 A2UI，能力缺失时降级文字。多员工隔离运行。

> 发布门禁：DSH fake 已对齐 DWS 的真实 ready、snake_case 事件、统一 JSON envelope 与 Channel 命令路径。仍须固定 DWS/DSH/DEAP 精确 SHA 做真实组织联合验收；缺少任一能力或本地审计不可写时，该员工 fail-closed，机器人和其他员工不受影响。

## 接入与配置

DWS 是唯一创建和绑定入口：

```text
dws dingtalk-tag connect --agent-uuid <uuid> --channel dsh
```

DWS 完成授权码交换并将 Refresh Token 写入独立 Profile 后，通过 stdin 调用：

```text
dsh-dingtalk digital-employee register --stdin --json
```

注册文档固定为 `schemaVersion: 1`，包含 `agentUuid`、展示名、精确 `corpId:userId` Profile、当前用户的 `operatorOpenDingTalkId`、`protocolVersion: 1` 和可选 `bindingRevision`（旧绑定默认为 0）。注册是加锁、原子、幂等的，只更新目标员工；任何 Token、AuthCode、Secret、可执行路径或未知字段都会被拒绝。

## 员工级生命周期

DWS 是 binding 与运行期望的权威。用户使用 `dws dingtalk-tag connect status/list/stop/restart/unbind/rebind`；DSH 负责实际运行和释放，不管理 DWS Token。

DSH 提供 `digital-employee runtime --stdin --json` 私有机器入口。输入为 protocolVersion、action（prepare/start/status/stop/release）、agentUuid、dwsProfile、bindingRevision；由 `DSH_DINGTALK_STATE_DIR` 下的私有 Unix socket 交给当前宿主。目录 0700、socket 0600；同一目录仅一个控制宿主。宿主不可达返回 unknown，不能视为已停。

启动先探测 `bindingAccessPolicy=true`，再读 DWS `channel binding --stdin`，核对身份、绑定版本、running 期望及明确的 `accessPolicy`。仅接受 `platform` 或 `local_allowlist`，缺失或未知策略提示升级并拒绝启动；策略只能来自已验证的绑定响应，不能由员工配置自填。平台策略还须返回可信的员工 `selfOpenDingTalkId`，用于过滤未经过插件发送账本的自身消息；DWS 优先读取匹配绑定的本地自身身份，旧绑定缺失时仅用员工自身 Profile 查询一次自己，不查询主管或可见范围。随后持有 DWS 内部 Profile lease，才启动 Consumer。lease 与原生 Adapter 共享运行锁，同机同配置目录互斥。旧 DSH 宿主没有该协议，升级时必须先正常退出旧宿主。

受管 `local_agent` 信任钉钉平台投递授权：私聊可见即可聊，撤销可见性后已有会话也不再投递；群聊只处理原生 @ 当前员工的消息。平台保证切换员工类型后停止向旧绑定投递，切回须重新绑定。插件不逐条查询可见范围，也不依赖主管 Profile 迁移或主管登录状态来启动。DWS 仍在启动和每次发送前核对绑定身份与状态。lease 失败只记录固定 `employee_lease_unavailable`，不透传原始 stdout/stderr、message/hint/cause。

停止顺序：禁止新任务并丢弃未执行队列 → 取消审批/问题等待 → 停 Consumer → 取消并 dispose 本 Channel 自己创建/恢复的 Agent → 等待回合、事件与所有下行调用结束 → 移除监听 → 最后释放 lease。借用 Web UI 所有的运行实例会被拒绝，不 dispose 其他实例。无法确认释放时保留阻塞状态，不承诺换绑成功。

A2UI 与文字审批/问答都随目标员工停止取消。决定审计和终态卡片更新排空后才确认释放；迟到回复与重连期间完成的旧入站不能恢复 ready，仅真实订阅就绪才能恢复连接状态。

正常释放由宿主向 lease stdin 写入 `released` 确认。异常 EOF 或 lease 崩溃在 DWS 留下私有隔离标记，新实例即使取得文件锁也不能启动。仅原 `runtimeInstanceId` 的停止确认可以解除隔离；宿主已崩溃而无法取得确认时保持 blocked，不提供自动或强制接管。

插件通过 Cordis `ctx.effect` 管理控制入口和机器人 Stream 的获取与释放；卸载、重载和宿主正常退出会等待异步清理，包括仍在初始化的资源。不能用普通 `ctx.on('dispose')` 事件代替该生命周期。退出宽限内无法完成释放时仍按异常退出处理；升级插件不会自动清除旧版本遗留的租约隔离标记。

release 在上述停止完成后删除目标注册配置；普通 stop 保留配置。DWS 停止期望会在宿主重启时再次校验，旧配置不会绕过新 bindingRevision 复活员工。独立机器人仍不依赖 DWS，不重启整个宿主。

注销必须显式确认：

```text
dsh-dingtalk digital-employee unregister --agent-uuid <uuid> --json --yes
```

注册后运行交互式 `setup`，选择“管理数字员工 operator 与白名单”。通过 DWS manage/connect 管理的 local_agent 信任平台按已发布可见范围授权投递，额外私聊白名单和群白名单不参与授权；其他本地场景默认只有 operator 可私聊。配置只保存稳定身份和 Profile selector，不保存 DWS 凭据。

## DWS/DSH 协议

DSH 启动每个员工前先执行只读能力探测，要求 DWS 同时声明：

- Event Consume；
- `chatDelivery=true`（通用 chat 文本回复与 operator 私聊）；
- `bindingAccessPolicy=true`（启动绑定访问策略）；
- `auditMode=local_required`；
- `protocolVersion: 1`。

事件进程固定使用参数数组启动，不经过 shell；A2UI 能力预检通过时还订阅 `user_card_action_triggered`，控制回调独立于模型任务队列：

```text
dws --profile <corpId:userId> event consume
  user_im_message_receive_o2o_all
  user_im_message_receive_at
  --flatten --format ndjson
```

以上为 `platform` 策略；`local_allowlist` 仍订阅 `user_im_message_receive_group_all` 并应用原本地群白名单。

DSH 同时排空 stdout/stderr，只有 ready 行匹配 `^\[event\] ready(?:\s|$)` 后才接受 NDJSON；允许 `event_count`、`bus_pid` 等后缀。`--flatten` 事件不要求额外 schemaVersion，直接消费真实 snake_case 字段：

```json
{
  "type": "user_im_message_receive_o2o_all",
  "event_id": "stable-event-id",
  "message_id": "open-message-id",
  "conversation_id": "open-conversation-id",
  "sender_open_dingtalk_id": "stable-sender-id",
  "sender": "display-name",
  "content": "message text",
  "event_time": "timestamp"
}
```

启动探测必须满足 `capabilities.chatDelivery=true`，缺少时拒绝启动并提示升级 DWS。回复使用 `chat +messages-reply`，主管私聊使用 `chat +messages-send --open-dingtalk-id <固定主管>`；正文参数为 `-`，配合 `--body-stdin --wait-delivery --employee-context <绑定 JSON>`。绑定上下文包含 agentUuid、channel、bindingRevision，DWS 在发送前重新核对 bound/running 状态和固定主管。connect 已授权的宿主传 `--yes`，chat 自身的确认规则保持生效。`dingtalk-tag channel reply` 和 `channel operator-private` 已删除，双方须配套升级。chat 支持当前直接回执与成功 envelope。发送失败或状态未知均不切换入口重发。`--allowed-users` 控制入站触发权限，不能代替固定主管。正文不会进入 argv、环境变量、配置、日志、运行状态或测试快照。回复结果必须回传 `openMessageId`、`conversationId`、`deliveryStatus` 和原幂等键。`deliveryStatus: unknown` 不自动重发，避免重复消息。

### 回执超时的 IM 故障提示

DWS 对同一发送任务的回执最多等待 2 秒；中途恢复就正常完成，不发送故障提示。若 DWS 最终以结构化 `delivery_unknown` 错误退出，插件先将员工保持在 fail-closed 状态，再向原会话引用原消息尝试发送一次固定中文提示：送达状态未确认、原回复可能已经送达、请勿重复执行，以及错误类型和 `DE-` 开头的排查编号。不透传服务端自由文本、凭据或原回复正文；也不将未知送达描述为任务执行失败。

故障提示继续使用相同 Profile、绑定校验和 `chat +messages-reply --wait-delivery`，有独立幂等键，并在发送前审计、持久化领取记录。同一事件在账本保留范围内最多尝试一次提示（与其他去重记录相同，最多保留 10,000 条），重启后也不会再次提示。绑定停止或变更、审计或账本不可写时不绕过校验。通知自身失败或送达未知只落本地记录，不递归通知、不重发原文、不恢复员工 ready，也不把原任务记为成功。正常停止会等待通知及其审计完成。

提示自身也需要发送和查询回执，所以整体处理可能超过原回复的 2 秒等待预算。同一 IM 通道完全不可用时，无法保证故障提示送达；此时依靠本地日志排查。其他错误类别、取消、非结构化错误不会误触发这条回执超时通知。

审计由 DSH 按员工写入本地 JSONL，目录 `0700`、文件 `0600` 并加锁；只包含事件、Session、操作类型、工具名、状态、时间、回复消息 ID、trace ID、diagnosticId 和 failureCode 等元数据，不含消息正文。本地审计不可写时不开始新任务；未来远程转发只能是可选 best-effort 扩展。

## 本地运行与隔离

- `platform`：启动时从 DWS 已验证绑定确定。私聊消息经过平台可见范围授权后才投递，群聊只接受原生 @ 当前员工；均不再逐条查询 `channel binding`、visibility 或通讯录，不叠加本地白名单。
- `local_allowlist`：单聊接受 operator 或 `allowedDirectSenders`，群聊接受 `allowedGroups`，保持已有群消息触发语义。未知策略、缺少 `bindingAccessPolicy` 能力或绑定身份不符拒绝启动，须配套升级 DWS，不降级为默认放行。
- 未授权消息静默丢弃，只上报无正文的拒绝审计。
- 敏感操作优先通过 operator 私聊的 A2UI 卡片审批；能力不可用时使用 operator 私聊一次性确认码。白名单普通成员不能批准。
- 会话键包含 `agentUuid + conversationId`；`chat-sender` 还包含发送者身份。
- 每个员工拥有独立的进程、Queue、Session binding、事件 ledger、发送消息 ledger 和 `0700/0600` 状态目录。
- 先按已验证员工自身 `selfOpenDingTalkId` 过滤自发消息，再按 `eventId` 持久化去重；已发送 `openMessageId` 额外阻断回复回环。
- 启动失败按 DWS `retryable=false/true/unknown` 执行 `0/2/1` 次重试。
- 停止时先关闭 stdin，等待优雅退出，再发送 SIGTERM；正常路径不使用 SIGKILL。

`tools.enabled` 只控制 DWS Agent 工具，不控制数字员工 Channel。

## 诊断

`doctor` 和 `doctor --json` 按员工输出：

- `agentUuid`、精确 DWS Profile 和协议版本；
- 白名单数量；
- 能力探测、ready 和单聊/群聊订阅；
- 最近事件、回复和本地审计是否被观察到；
- 脱敏失败码。

诊断不输出 operator、白名单具体身份、凭据或聊天正文。

用户反馈 IM 中的 `DE-...` 编号后，在宿主日志（DWH 通常为 `var/<employee>/logs/agent.log`）中查找 `delivery_failure_notice diagnosticId=DE-...`，并在插件状态目录下的 `digital-employees/<agentUuid>/audit/<agentUuid>.jsonl` 查相同 `diagnosticId`。`reply_delivery_unknown` 记录原回执失败，`delivery_failure_notice` 记录提示的 `claimed/delivered/unknown/failed` 结果；结合审计中的 eventId、sessionId、时间定位 DWS `logs/dws.log` 的原始业务错误。排查编号属于插件本地关联键，不是服务端 trace ID；最终 `delivery_unknown` 不一定含最后一次服务端错误码，不能据此认定一定是 `1001`。本地审计无法落盘时，宿主日志会尽力记录安全的准备或审计失败状态。

## 发布与验收边界

联合验收使用固定 DSH/DWS/DEAP SHA，依次覆盖机器人无 DWS 基线、一次 connect、四类白名单消息、唯一 Session/回复/审计、重启恢复、双员工隔离和故障注入。完整步骤见 [验收清单](acceptance-checklist.md)。

业务 ack/replay/cursor 未完成前只能声明“可用 MVP”，不能承诺 exactly-once 或不丢消息。A2UI 审批／提问的能力要求、降级条件与局限见 [交互说明](a2ui-interactions.md)。普通回复的 AI Card、图片、文件、语音和无 DWS 运行模式仍后置。

## 本地联合验收

构建 DWS 后，设置 `DWS_JOINT_BINARY` 为其绝对路径，运行 `node --test test/digital-employee-chat-delivery.test.mjs`。测试使用真实 DWS 子进程、隔离绑定目录与本机受控 MCP，验证回复、主管私聊、未知回执及绑定/会话校验；不发送真实钉钉消息。未设置该变量时，常规测试只执行新旧能力协商与失败不重发的模拟用例。
