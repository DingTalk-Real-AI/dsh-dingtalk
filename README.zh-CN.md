# DSH 钉钉连接器

简体中文 | [English](README.md)

把运行在本机的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接入钉钉。连接器通过 Stream 长连接收发消息，无需公网入口。

需要 Node.js `^22.19.0 || >=24.0.0`。机器人只在本机 `dsh web` 运行且网络在线时工作；电脑休眠、断网或进程退出后不会在云端继续执行。

## 数字员工 Channel（文本 MVP）

数字员工是与机器人平级的新 Channel：机器人仍可在不安装 DWS 的环境中工作；只有启用数字员工时才要求兼容 DWS companion runtime。DWS 负责 connect、授权码交换和 Profile 凭据，DSH 负责本地白名单、事件进程、Session、Queue、Agent、文本回复和诊断，DSH 不保存 Token、AuthCode 或 Client Secret。

接入必须由 DWS `dingtalk-tag connect --channel dsh` 发起，并通过 stdin 幂等调用本包的 `digital-employee register`。注册后重新运行 `setup` 管理 operator、私聊 OpenDingTalkId 和群 openConversationId 白名单。`doctor` 会按员工显示能力、ready、订阅、最近事件/回复/审计和脱敏失败码。

当前公开 DWS 尚须发布完整的安全回复、operator 私聊、审计和 capability 契约后才能做真实联合验收；缺少任一契约时该员工 fail-closed，不影响机器人或其他员工。详细接口、运行边界和发布门禁见 [数字员工 Channel 文档](docs/digital-employees.md)。业务 ack/replay/cursor 未完成前，本能力不承诺 exactly-once 或不丢消息。

## AI Native 安装（推荐）

AI 可以读取安装计划、执行经过批准的非秘密步骤，并从 checkpoint 续跑；扫码链接、Client Secret 和 `/bind` 明文不会进入机器 JSON 或 checkpoint，而是交给你亲自操作的独立终端。

```text
只读检查与计划
→ 明确批准依赖、插件和配置写入
→ AI 执行并保存非秘密 checkpoint
→ 你在私密终端完成扫码/Secret/绑定口令
→ AI 从 checkpoint 续跑
→ 显式启动或重启 dsh web
→ doctor + 一条真实消息验收
```

可以把下面这句话直接交给 AI 编程助手：

```text
请按本仓库 README 的 AI Native setup 流程安装钉钉连接器。先运行只读 plan，展示计划和非秘密 answers 给我确认后再 apply；不要索取、读取或记录 Client ID、Client Secret、扫码链接、Device Code、/bind 口令或管理员 staffId。遇到 private checkpoint 时暂停，让我在独立本机终端完成，再用同一 checkpoint 的 JSON resume 和 doctor --json 验收。不要自动启动、停止或重启 dsh web。若 JSON resume 仅因进程探测为 unknown（例如沙箱无法执行 ps）而返回 restart_required，不要自动重启或循环 resume；先保持现有 dsh web 运行，用 doctor --json 和一条真实私聊消息验收，并记录进程探测受限。仅当验收失败或该进程早于本次配置写入启动时，才请我重启。
```

建议先查询正式版版本号，后续所有步骤固定使用同一版本：

```bash
npx @dingtalk-real-ai/dsh-dingtalk@latest --version
```

把输出记为 `<version>`，然后生成严格只读计划。新安装使用 `default`；已有多个机器人时必须显式指定账号。

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --plan --json --account default
```

plan 只读取本地配置和进程表，并运行 `dsh --version`、`pnpm --version`；不会安装插件、写文件、生成绑定口令或启停进程。输出包含稳定的 `planId`、动作、所需批准和 `answerTemplate`。把模板中的 `null` 全部替换为明确选择后保存为 JSON，例如：

```json
{
  "schemaVersion": 1,
  "planId": "setup-plan-<来自 plan>",
  "accountId": "default",
  "approvals": {
    "installDsh": false,
    "installPnpm": false,
    "installPlugin": true,
    "writeProfile": true
  },
  "features": {
    "dwsEnabled": false,
    "imageMode": "auto",
    "senderAccess": "owner",
    "allowedSenders": [],
    "groupAccess": "none",
    "groupAllowlist": []
  }
}
```

没有出现在计划中的 DSH 或 pnpm 安装项应保持 `false`。出现时只有获得你的明确批准后才能改为 `true`；机器模式不会使用默认“是”。执行计划：

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --apply --json --answers <answers.json>
```

常见结果：

| `status`                       | 下一步                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `blocked`                      | 缺少明确批准；修改 answers 后重新 plan/apply。                                      |
| `failed`                       | 查看稳定的 `error.code` / `stepId`；输出不会包含子进程原始错误。                    |
| `awaiting_private_credentials` | 在独立本机终端运行同版本的 `setup --resume <checkpoint-id>`，亲自扫码或输入凭据。   |
| `awaiting_private_binding`     | 在独立本机终端运行同一个 private resume，现场获取一次性绑定口令。                   |
| `awaiting_bind`                | 启动 DSH Web，等待机器人连接后，在钉钉私聊发送终端显示的 `/bind <一次性口令>`。     |
| `start_required`               | 在专用终端显式运行 `dsh web`。                                                      |
| `restart_required`             | 原先已运行或无法探测的 `dsh web` 可能需要重启；按下方进程探测说明处理。             |
| `completed`                    | 配置完成，且检测到原先未运行的 `dsh web` 已在配置后启动；继续运行 `doctor --json`。 |

若 `failed` 的 `error.code` 为 `dsh_upgrade_required`，说明旧版 DSH 无法无损读取现有凭据记录；先升级 DSH，再重新 plan/apply。setup 不会改写原凭据文件，也不会把记录或 Secret 放进 JSON。

`restart_required` 是保守结果：机器 setup 不会杀进程，并把无法执行的进程探测视为 `unknown`。若沙箱无法执行 `ps`，不要直接认定已经联通的进程仍使用旧配置；先保持现有进程，用 `doctor --json` 和一条真实私聊消息验收，并记录进程探测受限。仅当验收失败或该进程早于本次配置写入启动时才重启。

JSON 模式的 stdout 始终只有一个完整 JSON 文档。退出码 `0` 表示协议成功返回（包括等待人工步骤、诊断 `warning/unverified`），`1` 表示执行或诊断失败，`2` 表示参数或 answers 无效。自动化应依赖 `schemaVersion`、`kind`、`status`、`id` 和 `code`，不要解析展示文案。

private resume 不带 `--json`，且只允许在交互式终端中运行：

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id>
```

TTY 检查只能避免误用管道或无头执行，不能证明终端由真人独占；能够创建或录制 PTY 的自动化仍可捕获屏幕内容。到达这个接力点后应停止 AI 执行，由你在 AI 无法控制或录制的独立终端中亲自运行命令。

完成私密步骤或绑定后，让 AI 继续检查真实状态；并发 resume 会被串行化，checkpoint 已确认完成的步骤不会重复。若进程在外部命令成功后、checkpoint 写入前被强制终止，恢复时可能重试同一个精确版本的幂等命令。

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id> --json
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --json
```

最后私聊机器人发送一条真实消息。`doctor` 能验证本机配置和最近运行状态，但不能代替真实消息链路验收。

checkpoint 位于本机状态目录，文件权限为 `0600`，拒绝专用的 Client ID、Client Secret、扫码/Device Code、管理员 ID 和 `/bind` 明文字段。它会保存你明确批准的非秘密安装选项，包括发送者与群白名单，因此仍应作为本机私有元数据保护；凭据写入 DSH 私有凭据存储，绑定文件只保存加盐摘要。

setup 通常会自动回收死进程遗留的写锁。若进程恰好在清理写锁期间被强制终止，下一次执行会选择 fail-closed，避免并发覆盖。确认没有 setup 进程仍在运行后，只清理对应 checkpoint 或 web profile 旁遗留的 `.lock` 与匹配的 `.owner.*` 文件；不要删除 checkpoint JSON 或凭据文件。

## 人工交互式安装

不使用 AI 编排时，运行原有引导即可：

```bash
npx @dingtalk-real-ai/dsh-dingtalk@latest setup
```

引导会检查 DSH 和 pnpm，在缺失或版本不兼容时先征求确认，安装当前精确版本插件，收集凭据，配置 DWS、图片和访问范围，生成管理员绑定口令，并询问是否启动 `dsh web`。已有 DSH 版本不会自动升级。

`npx` 只运行本次 CLI，不会把 `dsh-dingtalk` 写入 PATH。首次安装的新机器人默认允许所有发送者和所有群；个人使用建议改为“仅管理员”和“禁止群聊”，再按需放开。

### 企业私有 npm 源

DSH 处于预发布阶段时，主包及其子包的预发布版本必须在 registry 中完整同步。Nexus、Verdaccio、自建 cnpm 等企业私有源若只同步了主包或部分子包，安装可能报 `ETARGET`、`notarget` 或 `ERR_PNPM_NO_MATCHING_VERSION`；这表示当前 registry 缺少所需版本，不是连接器配置错误。

setup 会在安装插件前读取 `npm config get registry`，并把不含 URL 内嵌凭据的 registry 写入 `$DSH_HOME/profiles/web/.npmrc`（默认 `~/.dsh/profiles/web/.npmrc`），让外层 npm 与 DSH 拉起的 pnpm 使用同一个源。已有 scoped registry、认证和其他 `.npmrc` 配置会保留。若企业源缺包，可用一个已同步完整的源重试；该覆盖会同时传到后续 pnpm：

```bash
npm_config_registry=https://registry.npmjs.org npx @dingtalk-real-ai/dsh-dingtalk@latest setup
```

也可以手动设置并验证 web profile 的目录级配置；自定义 `DSH_HOME` 时请替换目录：

```bash
mkdir -p ~/.dsh/profiles/web
cd ~/.dsh/profiles/web
npm config set registry https://registry.npmjs.org --location=project
pnpm config get registry
```

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

同一个 checkpoint 的所有机器步骤都应把 `<version>` 替换为 plan 前读到的精确版本，并一直保持到验收结束。

```bash
# 首次安装，或重新打开配置菜单
npx @dingtalk-real-ai/dsh-dingtalk@latest setup

# 生成 AI 可消费的只读计划
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --plan --json --account default

# 按非秘密 answers 执行
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --apply --json --answers <answers.json>

# 私密人工接力；必须在交互式终端运行
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id>

# AI 从同一 checkpoint 幂等续跑
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id> --json

# 检查本机状态并联网验证钉钉凭据
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor

# 输出稳定、脱敏的机器诊断报告
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --json

# 不发起网络请求
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --offline
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --offline --json

# 仅供 DWS connect 通过 stdin 调用；不要手工传递 Token/AuthCode
dsh-dingtalk digital-employee register --stdin --json
dsh-dingtalk digital-employee unregister --agent-uuid <uuid> --json --yes
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

新凭据写入 `$DSH_HOME/.credentials.yaml`，文件权限仅限当前用户。默认机器人使用 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`；其他机器人使用带机器人标识的独立引用，例如 `support-bot` 对应 `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID` 和 `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET`。setup 同时读取 DSH 的旧扁平格式与 v1 版本化格式；每次私密写入前都会用同一 `PATH` 重新确认实际 DSH 版本，`0.1.1-rc.1` 之前写扁平格式，之后写 v1。在共享的 DSH 写锁内切换格式时，setup 会保留无关引用、记录和可表示的注释；若旧版 DSH 遇到含非空 `records` 的 v1 文档，setup 会拒绝有损展平并要求先升级 DSH。`$DSH_HOME/.env` 中已有的默认机器人凭据也可以由 setup 迁移；旧 profile 中的明文凭据覆盖会在迁移时清理。

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
