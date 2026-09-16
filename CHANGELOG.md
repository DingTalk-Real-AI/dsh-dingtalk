# Changelog

为避免发布流程向受保护的 `main` 分支写回提交，本文件不由发布任务自动改写。每个版本的完整变更记录由 semantic-release 生成并保存在 GitHub Releases 中。

## Unreleased

- 新增独立于数字员工的 A2UI approve / ask 通用交互模块；兼容原子卡片 `a2uiEvent.action.context` 回调，并按显式 UID 或 OpenDingTalkId 身份空间校验服务端操作人。默认运行时尚未接线。
