# DSH 钉钉连接器

简体中文 | [English](README.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的钉钉连接器。它通过免公网入口的 Stream 长连接，把本机 DSH Web Agent 接入钉钉。

> 兼容范围：当前只保证兼容最新版 DSH。升级 DSH 后如遇到问题，请先运行 `doctor` 并通过 GitHub Issue 反馈。

## 开始前先了解两件事

- 需要 Node.js `^22.19.0 || >=24.0.0`。没有合适版本时，`setup` 会停止并说明原因；请先升级 Node.js 后重试。
- 连接器运行在你的电脑上。只有 `dsh web` 正在运行且电脑联网时，钉钉机器人才能处理消息；关闭终端、休眠或断网后，它会暂时离线，不会在云端继续执行。

## 一条命令开始

```bash
npx @dingtalk-real-ai/dsh-dingtalk@latest setup
```

`npx` 会为本次执行下载并运行 CLI，**不会**把 `dsh-dingtalk` 写入 shell 的 PATH。以后重新配置或运行诊断时，请继续使用下方的 `npx` 写法；若希望使用更短的 `dsh-dingtalk` 命令，可按后文的可选全局安装方式安装。

引导程序会依次完成：

```text
检查或安装最新版 DSH
→ 把当前精确版本插件安装到 web profile
→ 扫码创建钉钉应用，或填写已有凭据
→ 可继续新增其他钉钉机器人
→ 询问是否开启 DWS
→ 配置图片处理模式
→ 配置允许的发送者和群聊范围（首次默认全部允许）
→ 把凭据写入 DSH 凭据存储
→ 生成一次性管理员绑定口令
→ 询问是否启动 dsh web
```

DSH Web 启动后，在钉钉私聊机器人发送终端显示的命令：

```text
/bind <一次性口令>
```

这是唯一需要在钉钉中完成的人工步骤，用于确认管理员确实控制机器人会话。口令十分钟后过期，磁盘只保存加盐摘要。

## 怎么使用：手动操作或让机器人协助执行

两种方式可以混用，始终由你发起任务：

1. **在电脑上手动操作**：在终端运行 `npx @dingtalk-real-ai/dsh-dingtalk@latest setup` 修改配置，运行 `npx @dingtalk-real-ai/dsh-dingtalk@latest doctor` 检查连接；需要停止服务时在运行 `dsh web` 的终端按 `Ctrl+C`。
2. **在钉钉里让机器人协助执行**：确认 `dsh web` 已连接后，直接私聊机器人描述目标，例如“检查这个项目的测试并告诉我失败原因”。机器人会在当前会话工作区中完成 DSH 允许的操作，并在需要补充信息、Plan Review 或敏感操作审批时，通过消息或互动卡片向你确认。

如果项目放在外接盘或名为 A 的卷中，例如 `/Volumes/A/my-project`，先在对应钉钉会话发送：

```text
/cd /Volumes/A/my-project
```

收到“新任务在该目录执行”后，再发送要做的事。把文件放进该目录**不会**触发后台扫描或自动执行；它只是把后续由你发起的任务放到正确工作区。发送 `/cd reset` 可恢复默认工作区。

要让机器人操作钉钉日历、群聊、待办等 DWS 能力，请在 `setup` 中开启 DWS，并按提示在本机执行 `dws auth login`。普通聊天不依赖 DWS；不要把 Client Secret、绑定口令或其他凭据发到机器人对话中。

敏感操作始终需要确认。配置互动卡片模板后，绑定管理员可以在卡片中允许或拒绝；未配置模板时，绑定管理员可使用管理员专用的文字确认码，未回答或无效的请求会安全拒绝。

## 能力

- 私聊和按策略允许的群聊。
- setup 可选择允许所有发送者、仅管理员或指定 sender staffId，也可选择所有群、禁止群聊或指定群。
- AI Card 流式回复，以及 Markdown、文本降级。
- DSH session 持久化、模型切换、工作区切换、取消和排队。
- DSH 原生用户提问、Plan Review 和 fail-closed 敏感操作审批；文字确认码和可选互动卡片均只接受管理员。
- 扫码创建钉钉应用，手动 Client ID / Client Secret 作为备用。
- 单个 `dsh web` 可同时连接多个钉钉机器人；每个机器人拥有独立凭据、Stream 连接、管理员绑定和运行状态。
- 可选 DWS 工具和随包提供的 DWS skill。
- 支持纯图片和图片文字混排的 `richText` 输入，并提供 `auto`、`always`、`never` 三种模式；`auto` 读取当前 DSH 模型的 `inputModalities`。
- 唯一管理员绑定、会话授权和消息去重。
- `doctor` 只读诊断。

第一版只支持 DSH `web` profile。macOS 和 Linux 为正式支持平台，Windows 为实验性平台。

## 命令

按推荐的 `npx` 方式安装后，请使用以下命令：

```bash
# 首次安装，或重新打开配置菜单
npx @dingtalk-real-ai/dsh-dingtalk@latest setup

# 检查本机状态并联网验证钉钉凭据
npx @dingtalk-real-ai/dsh-dingtalk@latest doctor

# 不发起网络请求
npx @dingtalk-real-ai/dsh-dingtalk@latest doctor --offline
```

`npx` 不会创建可长期使用的 `dsh-dingtalk` 命令。若希望使用该短命令，可执行一次可选的全局安装：

```bash
npm install --global @dingtalk-real-ai/dsh-dingtalk@latest
dsh-dingtalk setup
dsh-dingtalk doctor
```

重复执行 `setup` 不会重置连接器。配置菜单可以新增机器人、修改指定机器人的凭据、访问范围、DWS 与图片设置、查看或重新生成指定机器人的管理员绑定口令，或运行诊断。机器人标识必须以小写字母开头，只能包含小写字母、数字和连字符，最长 32 位。若已有多个启用机器人，绑定菜单会标明各自的“已绑定”或“待绑定”状态；setup 会为尚无有效口令的待绑定机器人生成口令，无需重复执行 setup。Secret 永远不会回显。

图片模式只控制连接器是否接收图片，不能把纯文本模型变成视觉模型。`auto` 仅在当前模型声明 `inputModalities` 包含 `image` 时接收；`always` 只跳过连接器检查，DSH 模型适配器和实际网关仍须支持图片。自定义模型若确实支持图片，请在 `~/.dsh/settings.yaml` 的对应模型条目声明：

```yaml
input:
  - text
  - image
```

修改模型配置后需要重启 `dsh web`。如果网关实际上不支持图片，不要添加该声明，否则图片会进入会话后在模型请求阶段失败。

每个新机器人默认允许所有发送者和所有群聊，访问策略按机器人分别配置。群聊按成员隔离会话，避免不同成员共享上下文；管理员始终允许访问。选择指定 sender 或指定群时，多个 staffId / openConversationId 可用逗号或空格分隔；群 ID 可用 `dws chat +chat-search --query "群名" --format json` 查询。已有安装如果尚未配置这些新策略，会继续保持原来的仅管理员、禁止群聊行为，直到再次运行 setup 修改功能配置。

开放聊天权限不会开放敏感审批：互动卡片和文字确认码仍只接受管理员。其他成员在群里触发敏感操作时，管理员可在同一群审批；其他成员私聊触发的敏感操作会直接拒绝。

## 高级安装方式

推荐使用一条命令的 setup。高级用户也可以使用 DSH 原生命令：

```bash
dsh plugin --profile web add @dingtalk-real-ai/dsh-dingtalk@latest
dsh web
```

如果配置不完整，插件启动日志会显示带当前精确版本的 `npx ... setup` 恢复命令。

## 凭据和本地文件

新凭据写入 `$DSH_HOME/.credentials.yaml`，文件权限仅限当前用户。默认机器人使用 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`；其他机器人使用带机器人标识的独立引用，例如 `support-bot` 对应 `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID` 和 `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET`。`$DSH_HOME/.env` 中已有的默认机器人凭据可以由 setup 迁移；旧 profile 中的明文凭据覆盖会在迁移时清理。

默认机器人的运行状态继续位于 `~/.dsh-dingtalk/`，其他机器人隔离在 `~/.dsh-dingtalk/accounts/<机器人标识>/`。管理员绑定、会话映射、消息去重和能力状态不会跨机器人共享；管理员绑定口令不会以明文落盘。`doctor` 会按机器人分别展示诊断结果。

## DWS

DWS 默认关闭。开启后，setup 会把随包提供的 DWS skill 挂载到钉钉工作区。DWS 自己负责安装和用户登录；即使 DWS 缺失或未登录，普通钉钉消息能力仍能工作。多机器人模式共用一个 DSH 工作区和用户级 DWS 登录，不会把某个机器人的应用凭据导出为进程级 DWS 凭据。

## 本地开发

```bash
pnpm install
pnpm run ci
```

CI 会检查格式、类型、单元和 CLI 行为、真实 NPM tarball，以及该 tarball 在最新版 DSH `web` profile 中的安装和启动。

Pull Request 标题使用 Conventional Commits：

```text
feat(setup): add guided onboarding
fix(stream): reconnect after heartbeat timeout
```

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 支持与贡献

源码由 DingTalk Real AI 公开维护，欢迎通过 GitHub Issue 报告问题并提交 Pull Request。安全漏洞请使用 GitHub Private vulnerability reporting，不要在公开 Issue 中披露凭据或敏感数据。

## 许可证和来源

MIT。参见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
