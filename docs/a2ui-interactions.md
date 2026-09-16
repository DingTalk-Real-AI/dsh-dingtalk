# A2UI approve / ask：独立于数字员工的交互模块

## 状态和范围

这是第一阶段通用模块，通过同一 NPM 包的 `@dingtalk-real-ai/dsh-dingtalk/a2ui` 子路径提供，不拆分 SDK。
默认插件启动行为不变；仅升级本包不会自动切换到 A2UI。

已实现原子卡片生成、DSH 原生请求接管、回调校验、单次恢复、显式终态更新，以及超时、取消、卸载处理。
未实现真实卡片传输、DWS 事件订阅、身份解析和默认运行时配置接线；这些由下一阶段接入方实现并做实机验收。
本阶段不是“钉钉端可直接使用”的完整功能，不宣称端到端验收通过。

## 与 PR #20 的关系

本改造基于 main `05b8d6cbe7f8a392e9af32fc79819112fcb4ad0b`，不依赖
[PR #20](https://github.com/DingTalk-Real-AI/dsh-dingtalk/pull/20)
的 `9784e08e47b623a5223488bccf17728473ca064e`。
main 已有原生 `approval/request`、`user-questions/request` 类型与处理机制。
#20 的增量负责数字员工 runtime 生命周期、租约、换绑和释放，不是 A2UI 卡片协议。

建议独立 PR 交付本模块，保留 #20 的发布门禁。需要测试数字员工时，再在临时组合分支上集成
#20、此模块和已验证的 DWS 传输，不提前合并或发布 #20，也不把测试版 DWS 当作官方已发布能力。

## 接口与职责

`A2uiInteractions` 只有请求、安装、事件处理和关闭这几类入口：

- `install(agentCtx)`：接管该 Agent 的原生 approve / ask，返回幂等卸载函数；不接管其他 Agent。
- `approve(request)`：允许一次返回 `allowed-once`，拒绝返回 `rejected`；未知身份、超时、发送失败返回 `unavailable`。
- `ask(sessionId, request)`：返回宿主格式 `{ answers: [{ id, selected, custom? }] }`；取消抛 `AbortError`，失效抛错误。
- `handleEvent(source, event)`：同步处理可信来源的卡片事件，不进入正在等待答案的会话队列。
- `close()`：结束等待并卸载监听；未完成请求不会自动恢复。

不得给同一个 Agent 同时安装旧的 `QuestionManager` / `DigitalEmployeeApprovalManager` 和本模块。
本模块只监听原生请求，不覆盖旧 `ask_user_question` tool shadow；接入阶段须选择一个请求所有者，
移除旧 shadow 或让它显式调用 `ask()`。不能因卡片发不出去而自动降级到另一个授权渠道。

接入方注入两个真实变化的接口：

1. `route(sessionId, kind)`：从可信配置返回目标、允许操作人的身份和 `bindingId`。
   `operatorUid` 与 `operatorOpenDingTalkId` 必须二选一，分别匹配服务端 `operatorDTO` 的同名身份空间，不能混用。
   approve 必须选已验证的管理员；ask 通常选提问对象。无法解析就返回 `undefined`，不可默认拿发送者当审批人。
   `bindingId` 是接入方的授权版本标识，撤权或换绑后必须变化，不能复用旧值。
   每次回调重新读取路由，校验目标、操作人及授权版本；已经改变的绑定无法批准旧请求。
2. `transport.create/update`：创建、投递、更新卡片，处理身份凭据、网络超时和授权策略。
   `create` 得到真实 Surface 后调用 `input.render(surfaceId)`，按顺序发送消息数组，
   只有真实创建并投递成功才能返回 `{ bizId, surfaceId }`。禁止把 request ID 当卡片业务 ID，
   或随意编造 Surface ID。`target.id` 使用传输约定的 ID 空间，不跨 staffId / UID / OpenDingTalkId 猜测转换。
   `update` 接收终态组件消息，传输层还要设置对应卡片流转状态。
   两个方法必须遵守 AbortSignal；不做无条件发卡重试，不承诺 exactly-once。

示意接线（`cardTransport` 和 `trustedRoute` 必须由接入方实现，不是已实现的 DWS Adapter）：

```ts
import { A2uiInteractions } from '@dingtalk-real-ai/dsh-dingtalk/a2ui'

const interactions = new A2uiInteractions({
  source: subscriptionIdentity,
  timeoutMs: 300_000,
  route: trustedRoute,
  transport: cardTransport,
  log,
})
const uninstall = interactions.install(agentCtx)

// 在通过授权和来源校验的订阅入口调用，不把 source 从事件 context 中取出。
interactions.handleEvent(subscriptionIdentity, event)
// 单个 Agent 卸载时调用 uninstall()；整个实例关闭时调用 interactions.close()。
```

## 卡片与回调契约

approve：`Column` + `Text` + `Markdown` + `Row` + 两个 `Button`。
ask：`Column` + `Text` / `Markdown` + `ChoicePicker`（单选或多选）+ `TextField` + 提交/取消按钮。
只发 `updateComponents` 和 `updateDataModel`，不假设客户端可以自行创建 Surface。

动作名为连接器自定义的 `dsh.interaction`，不是平台事件名。平台事件为
`user_card_action_triggered`，当前适配的字段位置是：

```text
payload.body.bizInfoDTO.bizId
payload.body.operatorDTO.openDingTalkId  # operatorOpenDingTalkId 路由
payload.body.a2uiEvent.action.context.interactionId
payload.body.a2uiEvent.action.context.action
payload.body.a2uiEvent.action.context.answers  # 仅 ask submit
```

兼容旧的 `payload.body.actionData.context` 格式，以及显式配置 `operatorUid` 路由时的
`payload.body.operatorDTO.uid`。两种动作格式同时存在时，interactionId、action 和 answers 必须一致；
畸形新格式不降级到旧格式。动作格式和身份空间分别校验，不将一种身份当作另一种身份的替代值。

`operatorDTO.uid` 只接受数字字符串或安全整数；64 位 UID 若已经被普通 JSON.parse 截断，拒绝处理，
由接入方使用无损解析保留字符串。`createUid`、客户端自报身份或问题定义不能代替服务端操作人和本地请求快照。
`source` 必须来自可信订阅上下文，本模块不是 Webhook 的验签或认证层，不能将裸公网请求直接交给它。

每个请求生成独立随机 `interactionId`；回调还要同时匹配业务卡片 ID 和操作人。
首个有效终态赢得决定；重复、过期、重启前和未知请求的回调全部拒绝。
发卡返回前无法核对业务卡片 ID，此时回调拒绝处理，需要用户再次点击；不缓存未验证的早到批准。

ask 使用 `q0` 等内部表单键和 `option_0` 等选项 ID，避免任意问题 ID 进入 JSON Pointer。
提交按钮通过 `answers: { path: '/answers' }` 一次性读取表单。接收后根据保存的请求映射回原问题 ID 和宿主选项标签。
当前宿主问题契约允许跳过，空答案合法；本模块不凭空添加必填约束。如扩展必填，校验必须放在提交按钮 `checks`，
并同步做服务端校验，不能依赖 `TextField.checks`。

ask 仅补充信息，包括 Plan Review；它不是宿主工具执行授权，不会返回 `allowed-once`。
不依赖 `wantResponse` 或 `responsePath` 自动回写。决定完成后显式将根组件换成状态文字，移除可达的动作按钮。
“已批准”不代表工具执行成功。状态更新失败只记通用错误，不改变已作出的决定，不重复恢复宿主。

## 生命周期与验收

pending 只保存在内存中：宿主关闭、卸载或请求中止时结束等待。进程崩溃后没有可恢复 Promise，
重启不重新执行旧操作。晚返回的创建结果会尝试更新为失效状态，未知创建结果可能留下不可再授权的旧卡片。
关闭不保证强制终止不遵守 AbortSignal 的传输，也不等待全部终态重绘；网络资源排空由传输所属宿主负责。

本地测试覆盖原生事件入口、卡片内容、结构化答案、身份/卡片/来源不匹配、授权版本变化、并发请求、重复点击、
超时、AbortSignal、卸载、发卡失败及晚返回、终态更新失败和打包导入。

2026-09-16 使用独立 Cordis 验收夹具和 haoxiao 测试版 DWS `v0.0.0-build.27.2` 实测：
真实原子卡片点击以 `a2uiEvent.action.context` 回传，服务端操作人提供 `operatorDTO.openDingTalkId`。
修复后批准回调恢复为 `allowed-once`，ask 单选、多选和留空文本回传成功，两个终态更新获服务端接受。
本轮没有执行工具，未验证非空文本与终态客户端显示，也不等于实际 DSH Agent / 模型运行时端到端验收。

实机接入前必须验证：

- 原子组件在目标钉钉客户端可显示，输入绑定和按钮 context 求值正确。
- 真正发卡响应能取得业务 ID 和 Surface ID，且可更新终态。
- 哪个 Profile 能消费该卡片回调；实际 UID 或 OpenDingTalkId 与管理员/提问对象的可信映射。
- `action.event.context` 到上述回调字段的映射，不把静态样例当作线上证据。
- 在真实 DSH 宿主恢复原请求，且非授权人、重复点击、撤权和超时均不能执行工具。

未把用户提供的待开放协议包或完整 Catalog 随仓库分发；此处只实现所需原子消息构造。
