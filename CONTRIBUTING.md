# 贡献指南

感谢参与 DSH 钉钉连接器。外部贡献通过 GitHub Issue 和 Pull Request 进行。

## 开始开发

```bash
pnpm install
pnpm run ci
```

请勿在测试、日志、Issue 或提交中加入真实 Client Secret、二维码、绑定口令、聊天内容或内部地址。

## Pull Request

- 一个 PR 只解决一个清晰问题。
- 标题使用 Conventional Commits，例如 `fix(stream): reconnect after heartbeat timeout`。
- 功能修改应补充行为测试；测试通过公开 CLI、运行时行为或 NPM tarball 边界验证，不绑定私有实现。
- 描述中说明用户影响、验证命令和已知限制。
- 维护者使用 squash merge，最终 PR 标题决定自动版本号。

较大的行为或接口变化请先创建 Issue 对齐设计。
