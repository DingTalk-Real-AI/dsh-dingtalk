# 开发约束

- 本仓库只发布 `@dingtalk-real-ai/dsh-dingtalk`，不拆分公共 SDK。
- 第一版只适配最新版 DeepSeek Harness 的 `web` profile。
- 使用 Node.js `^22.19.0 || >=24.0.0` 与 pnpm 11；提交前运行 `pnpm run ci`。
- 不得提交真实 Client Secret、二维码、绑定口令、用户消息、内部地址或内网仓库内容。
- `setup`、`doctor`、消息桥接和 NPM tarball 是稳定的行为边界；变更这些行为时应先补测试。
- Release workflow 只允许从 `main` 手动触发；首次组织发布固定为 `0.5.0`，后续由 Conventional Commits 自动计算版本。
- NPM 发布必须使用 Trusted Publisher OIDC 和 provenance，不得恢复长期 NPM Token。
- Release workflow 不得向 `main` 写回版本或 Changelog 提交；版本号和 Release Notes 由 semantic-release 在发布时生成。
