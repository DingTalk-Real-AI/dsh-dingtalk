# DSH 数字员工 Channel

数字员工是与现有机器人平级的独立 Channel。机器人模式不依赖 DWS；只有启用了 `digitalEmployees[]` 的员工才要求本机安装兼容 DWS。首期仅支持文本事件和文本引用回复，多员工从第一版开始隔离运行。

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

启动前读 DWS `channel binding --stdin`，核对身份、绑定版本及 running 期望；随后持有 DWS 内部 Profile lease，才启动 Consumer。lease 与原生 Adapter 共享运行锁，同机同配置目录互斥。旧 DSH 宿主没有该协议，升级时必须先正常退出旧宿主。

停止顺序：禁止新任务并丢弃未执行队列 → 取消审批/问题等待 → 停 Consumer → 取消并 dispose 本 Channel 自己创建/恢复的 Agent → 等待回合、事件与所有下行调用结束 → 移除监听 → 最后释放 lease。借用 Web UI 所有的运行实例会被拒绝，不 dispose 其他实例。无法确认释放时保留阻塞状态，不承诺换绑成功。

正常释放由宿主向 lease stdin 写入 `released` 确认。异常 EOF 或 lease 崩溃在 DWS 留下私有隔离标记，新实例即使取得文件锁也不能启动。仅原 `runtimeInstanceId` 的停止确认可以解除隔离；宿主已崩溃而无法取得确认时保持 blocked，不提供自动或强制接管。

插件通过 Cordis `ctx.effect` 管理控制入口和机器人 Stream 的获取与释放；卸载、重载和宿主正常退出会等待异步清理，包括仍在初始化的资源。不能用普通 `ctx.on('dispose')` 事件代替该生命周期。退出宽限内无法完成释放时仍按异常退出处理；升级插件不会自动清除旧版本遗留的租约隔离标记。

release 在上述停止完成后删除目标注册配置；普通 stop 保留配置。DWS 停止期望会在宿主重启时再次校验，旧配置不会绕过新 bindingRevision 复活员工。独立机器人仍不依赖 DWS，不重启整个宿主。

注销必须显式确认：

```text
dsh-dingtalk digital-employee unregister --agent-uuid <uuid> --json --yes
```

注册后运行交互式 `setup`，选择“管理数字员工 operator 与白名单”。新员工默认只有 operator 可私聊，额外私聊白名单和群白名单均为空。配置只保存稳定身份和 Profile selector，不保存 DWS 凭据。

## DWS/DSH 协议

DSH 启动每个员工前先执行只读能力探测，要求 DWS 同时声明：

- Event Consume；
- 文本引用回复 stdin；
- operator 私聊 stdin；
- `auditMode=local_required`；
- `protocolVersion: 1`。

事件进程固定使用参数数组启动，不经过 shell：

```text
dws --profile <corpId:userId> event consume
  user_im_message_receive_o2o_all
  user_im_message_receive_group_all
  --flatten --format ndjson
```

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

回复和 operator 私聊固定调用 `dingtalk-tag channel reply/operator-private --stdin --format json`，并要求 DWS envelope `ok=true`，业务结果从 `data` 读取。正文不会进入 argv、环境变量、配置、日志、运行状态或测试快照。回复结果必须回传 `openMessageId`、`conversationId`、`deliveryStatus` 和原幂等键。`deliveryStatus: unknown` 不自动重发，避免重复消息。

审计由 DSH 按员工写入本地 JSONL，目录 `0700`、文件 `0600` 并加锁；只包含事件、Session、操作类型、工具名、状态、时间、回复消息 ID 和 trace ID 等元数据，不含消息正文。本地审计不可写时不开始新任务；未来远程转发只能是可选 best-effort 扩展。

## 本地运行与隔离

- 单聊只接受 operator 或 `allowedDirectSenders`；群聊只接受 `allowedGroups`。
- 未授权消息静默丢弃，只上报无正文的拒绝审计。
- 敏感操作通过 operator 私聊的一次性确认码审批；白名单普通成员不能批准。
- 会话键包含 `agentUuid + conversationId`；`chat-sender` 还包含发送者身份。
- 每个员工拥有独立的进程、Queue、Session binding、事件 ledger、发送消息 ledger 和 `0700/0600` 状态目录。
- 事件按 `eventId` 持久化去重；已发送 `openMessageId` 用于阻断回复回环。
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

## 发布与验收边界

联合验收使用固定 DSH/DWS/DEAP SHA，依次覆盖机器人无 DWS 基线、一次 connect、四类白名单消息、唯一 Session/回复/审计、重启恢复、双员工隔离和故障注入。完整步骤见 [验收清单](acceptance-checklist.md)。

业务 ack/replay/cursor 未完成前只能声明“可用 MVP”，不能承诺 exactly-once 或不丢消息。AI Card、图片、文件、语音、互动卡片审批和无 DWS 运行模式均后置。
