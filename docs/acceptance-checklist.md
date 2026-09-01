# 0.5.0 组织首发验收清单

没有完成本清单，不得确认组织仓库迁移完成。

## 自动门禁

- [ ] Ubuntu CI 通过。
- [ ] macOS CI 通过。
- [ ] NPM tarball 白名单通过。
- [ ] tarball 可安装到当次最新版 DSH `web` profile。
- [ ] DSH Web 启动冒烟通过。
- [ ] `THIRD_PARTY_NOTICES.md` 已记录精确上游 commit。
- [ ] Secret 扫描没有发现凭据、内部地址或测试账号数据。
- [ ] NPM 发布不依赖长期 Token，Trusted Publisher OIDC 生效。
- [ ] NPM provenance 指向 `DingTalk-Real-AI/dsh-dingtalk` 的准确提交与 workflow。
- [ ] `latest` 指向 `0.5.0`，个人仓库时期遗留的 `beta` dist-tag 已移除。

## 真实链路

- [ ] 全新环境执行 `npx @dingtalk-real-ai/dsh-dingtalk@latest setup`。
- [ ] 扫码创建应用成功。
- [ ] 手动凭据备用流程成功。
- [ ] `dsh web` 启动并建立 Stream 连接。
- [ ] 同一 `dsh web` 至少同时连接两个机器人，并分别完成消息收发。
- [ ] 两个机器人的管理员绑定、会话映射和去重状态相互隔离。
- [ ] 停止或配置错误其中一个机器人，不影响另一个机器人继续收发消息。
- [ ] 私聊 `/bind` 成功，口令随后失效。
- [ ] 私聊文本与 AI Card 流式回复正常。
- [ ] 群聊白名单和未授权拒绝行为正确。
- [ ] DWS 开启、关闭、未安装和未登录状态提示正确。
- [ ] 支持图片的模型可以接收图片。
- [ ] 不支持图片或元数据未知时安全降级。
- [ ] 重复执行 setup 能新增机器人或修改选中机器人，且不覆盖其他机器人与功能设置。
- [ ] `doctor` 按机器人输出，且每个机器人的结论与真实状态一致。

验收记录只保存版本、commit、时间、平台和结果，不保存二维码、Secret 或聊天内容。

## 数字员工联合验收（发布阻塞）

- [ ] 固定 DSH、DWS、DEAP 精确 SHA、测试组织和数字员工。
- [ ] 无 DWS 环境中机器人安装、升级、消息闭环和 doctor 基线不变。
- [ ] 兼容 DWS 的 capability probe 同时确认 Event Consume、回复 stdin、operator 私聊 stdin 和审计 stdin。
- [ ] `connect --channel dsh` 一次完成绑定、独立 Profile 凭据落盘和幂等 register；DSH 配置中没有 Token/AuthCode/Secret。
- [ ] setup 确认 operator，并配置一个额外私聊身份和一个群会话。
- [ ] 白名单内私聊进入 Agent；白名单外私聊静默拒绝且只有无正文审计。
- [ ] 白名单群进入 Agent；非白名单群静默拒绝且只有无正文审计。
- [ ] 一个事件只映射到一个 DSH Session、一次 Agent turn、一次文本引用回复和一条可查询审计链。
- [ ] `deliveryStatus: unknown` 不自动重发；已发送 `openMessageId` 不回流为新任务。
- [ ] 重启 DSH 后 Session 恢复，eventId 不重复执行，没有遗留等价订阅。
- [ ] 两个数字员工的进程、Profile、白名单、状态目录、Session 和回复身份完全隔离。
- [ ] DWS 缺失、协议不兼容、Profile 撤销、ready 超时、坏 NDJSON 和回复失败只隔离目标员工。
- [ ] 远程审计不可用时目标员工不开始新任务，机器人和其他员工继续工作。
- [ ] 进程列表、argv、环境、日志、配置、状态文件、快照和服务端审计均无凭据与聊天正文。
- [ ] 状态目录权限为 `0700`，状态、ledger 和 Session binding 文件权限为 `0600`。
- [ ] macOS/Linux CI、fake DWS 协议测试、`pnpm run ci` 和 NPM tarball smoke 全部通过。
- [ ] DWS 未提供业务 ack/replay/cursor 时，发布说明只声明“可用 MVP”，不承诺 exactly-once 或不丢消息。
