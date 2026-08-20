# DSH DingTalk 发布仓库实施规格

本仓库是 `@dingtalk-real-ai/dsh-dingtalk` 的 DingTalk Real AI 官方公开主线。它以验收通过的源码快照建立干净 initial commit，不继承个人孵化仓库或内网仓库的 Git 历史。

## 第一版范围

- 只发布一个 NPM 包，不发布独立 SDK。
- 只保证兼容最新版本 DeepSeek Harness，并只管理 `web` profile。
- 首选入口为 `npx @dingtalk-real-ai/dsh-dingtalk@latest setup`。
- `setup` 负责 DSH 检查、精确版本插件安装、钉钉应用凭据、DWS 开关、图片模式、管理员绑定和启动提示。
- `doctor` 是只读诊断入口。
- 单个 `dsh web` 实例可启动多个钉钉机器人；各机器人的凭据、Stream、管理员绑定和状态文件相互隔离，单个机器人故障不得阻止其他机器人启动。
- 旧版单机器人配置继续可用，并由 `setup` 安全迁移到 `accounts[]` 与凭据引用。
- macOS 与 Linux 为支持平台，Windows 为实验性平台。

## 已确认的测试边界

1. CLI：用户通过 `setup` 新增或修改指定机器人，以及通过 `doctor` 观察到的分机器人行为。
2. 插件运行时：多机器人连接隔离，以及钉钉消息、绑定、图片和 DSH session 之间的公开行为。
3. 发布物：从干净构建生成的 NPM tarball 能安装到最新 DSH 的临时 `web` profile。

## 发布边界

- Pull Request 与 `main` 自动执行 CI。
- 仓库只允许 squash merge；符合 Conventional Commits 的 PR 标题成为 `main` 上的提交标题，并作为 semantic-release 的版本计算输入。
- NPM 发布只允许在 `main` 上手动触发。
- 现有同名 NPM 包版本不可重置；组织仓库首次正式发布固定为 `0.5.0`，后续由 Conventional Commits 和 semantic-release 计算 SemVer。
- 发布使用 NPM Trusted Publisher OIDC，不保存长期发布 Token，并为公开包自动生成 provenance。
- `latest` 指向最新正式版本；`beta` 仅在未来确有预览版本时使用。
- 发布后必须读回 NPM 版本、dist-tags、provenance、Git tag、GitHub Release 和公开 CLI 行为。
