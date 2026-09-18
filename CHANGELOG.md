# Changelog

为避免发布流程向受保护的 `main` 分支写回提交，本文件不由发布任务自动改写。每个版本的完整变更记录由 semantic-release 生成并保存在 GitHub Releases 中。

## Unreleased

- 优化 A2UI 卡片的 Markdown 标题、说明与分组；审批/问答结束后保留只读请求和答案回执，不再只显示一句状态文字。
- 新增独立于数字员工的 A2UI approve / ask 通用交互模块；兼容原子卡片 `a2uiEvent.action.context` 回调，并按显式 UID 或 OpenDingTalkId 身份空间校验服务端操作人。
- 数字员工默认优先 A2UI 审批／提问，启动时探测发卡、更新、语义摘要和回调能力；能力缺失或首次订阅未就绪时安全降级文字，支持 `interactionMode: text` 显式回滚。投递结果未知、取消和超时不会自动开启第二个授权通道。
- 补齐文字降级的取消、超时、卸载与重复请求保护；卡片审批仍校验 operator 并写本地审计，问答只接受原提问人，机器人流程不变。
