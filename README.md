# DSH DingTalk

[简体中文](README.zh-CN.md) | English

DingTalk connector for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It connects a local DSH Web agent to DingTalk over a Stream connection, without requiring a public inbound endpoint.

> DSH must be installed before setup. Setup keeps an existing DSH version unchanged; after upgrading DSH, run `doctor` first and report incompatibilities through GitHub Issues.

## Before you start

- Node.js `^22.19.0 || >=24.0.0` is required. If the version is unsupported, `setup` stops and explains why; upgrade Node.js, then run it again.
- The connector runs on your computer. The DingTalk bot can process messages only while `dsh web` is running and the computer is online. It goes offline when the terminal is closed, the computer sleeps, or the network disconnects; it does not continue in the cloud.

## Quick start

Run one command:

```bash
npx @dingtalk-real-ai/dsh-dingtalk@latest setup
```

`npx` downloads and runs the CLI for this invocation; it does **not** add `dsh-dingtalk` to your shell's PATH. To reopen setup or run diagnostics later, use the same `npx` form below. If you prefer the shorter `dsh-dingtalk` commands, install the package globally in the optional section.

The guided setup checks for DSH and installs the latest release only when DSH is absent. It keeps an existing DSH version unchanged, installs this exact plugin version into the `web` profile, creates or configures one or more DingTalk bot accounts, configures optional DWS, image, sender and group access, stores credentials, generates owner-binding codes, and offers to start `dsh web`. New bot accounts default to all senders and all groups.

When DSH Web is ready, send the displayed command to the bot in a direct message:

```text
/bind <one-time-code>
```

This final DingTalk action proves that the owner controls the bot conversation. The code expires after ten minutes and is never stored in plaintext.

## How to use it: manual steps or assisted execution

You can mix both modes, and you always start the task:

1. **Operate locally:** run `npx @dingtalk-real-ai/dsh-dingtalk@latest setup` in a terminal to change settings, or `npx @dingtalk-real-ai/dsh-dingtalk@latest doctor` to inspect the connection. To stop the service, press `Ctrl+C` in the terminal running `dsh web`.
2. **Ask the bot to help:** after `dsh web` is connected, send the bot a goal such as “run this project's tests and explain any failures.” The bot works in the current conversation workspace within the operations allowed by DSH. It asks you for missing details, Plan Review, or sensitive-operation approval through messages or interactive cards.

If a project lives on an external volume or a volume named `A`, for example `/Volumes/A/my-project`, send this in that DingTalk conversation first:

```text
/cd /Volumes/A/my-project
```

Wait for the confirmation that new tasks will run in that directory, then send the task. Merely placing files there does **not** start a background scan or execute anything; it selects the workspace for tasks you explicitly send. Use `/cd reset` to return to the default workspace.

To let the bot use DingTalk calendar, group chat, Todo, and other DWS functions, enable DWS during `setup` and run `dws auth login` locally when prompted. Normal chat does not require DWS. Never send Client Secrets, binding codes, or other credentials to the bot.

Sensitive operations always need confirmation. With an interactive-card template configured, the bound owner can allow or reject them in the card. Without a template, the bound owner can use an owner-only text confirmation code; unanswered or invalid requests fail closed.

## Features

- Direct messages and configured group chats.
- Guided access policies for all senders, owner-only, or selected sender staff IDs, and for all, no, or selected groups.
- AI Card streaming, Markdown and text replies.
- Native DSH session persistence, model selection, workspace switching, cancellation and queues.
- DSH user questions, Plan Review and fail-closed sensitive-operation approval via owner-only text codes or optional interactive cards.
- QR-based DingTalk app registration with manual Client ID / Client Secret fallback.
- Multiple DingTalk bot accounts in one `dsh web` process, with isolated credentials, Stream connections, owner bindings and runtime state.
- Optional DWS tools and a bundled DWS skill.
- Picture and mixed image/text `richText` intake with `auto`, `always` and `never` modes. `auto` reads the active DSH model's `inputModalities` metadata.
- Owner binding, per-chat authorization and deduplication.
- Read-only diagnostics through `doctor`.

Only the DSH `web` profile is supported in the first release. macOS and Linux are supported; Windows is experimental.

## Commands

Use these commands after following the recommended `npx` installation path:

```bash
# Install and configure, or reopen the configuration menu
npx @dingtalk-real-ai/dsh-dingtalk@latest setup

# Validate local state and DingTalk credentials
npx @dingtalk-real-ai/dsh-dingtalk@latest doctor

# Avoid network calls
npx @dingtalk-real-ai/dsh-dingtalk@latest doctor --offline
```

The `npx` command does not create a persistent `dsh-dingtalk` command. If you want that shorter form, install the package globally once:

```bash
npm install --global @dingtalk-real-ai/dsh-dingtalk@latest
dsh-dingtalk setup
dsh-dingtalk doctor
```

Re-running `setup` does not reset the connector. The menu lets you add a bot account, change credentials for a selected account, inspect or regenerate that account's owner binding, change DWS, image and access settings, or run diagnostics. Account IDs must start with a lowercase letter, contain only lowercase letters, digits and hyphens, and be at most 32 characters. Secrets are never printed back to the terminal.

Image mode controls connector admission only; it cannot make a text-only model accept images. `auto` requires the active model's `inputModalities` to contain `image`. `always` skips only the connector check, so the DSH model adapter and gateway must still support images. For a custom model that genuinely supports images, declare the following on its entry in `~/.dsh/settings.yaml`, then restart `dsh web`:

```yaml
input:
  - text
  - image
```

Do not add this declaration to a gateway that cannot actually accept images: the image would become durable session history before the provider rejects the request.

New bot accounts default to all senders and all groups. Access policies are configured per bot account. Group sessions are isolated per sender so members do not share context. When using allowlists, separate sender staff IDs or group openConversationIds with commas or spaces. Existing installations without the new policy fields retain the previous owner-only and no-group behavior until setup is run again.

Chat access never grants sensitive approval authority. Interactive-card and text-code approvals remain owner-only. The owner can approve a group member's request in the same group; sensitive operations requested from another member's direct chat are rejected.

## Advanced installation

The one-command setup is recommended. Advanced users may install the package through DSH directly:

```bash
dsh plugin --profile web add @dingtalk-real-ai/dsh-dingtalk@latest
dsh web
```

If configuration is incomplete, the plugin logs the exact-version `npx ... setup` recovery command.

## Credentials and local files

New credentials are stored in `$DSH_HOME/.credentials.yaml` with owner-only permissions. The default account uses `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET`; additional accounts use namespaced references. For example, `support-bot` uses `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID` and `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET`. Setup reads and writes the versioned DSH credential document, updates only these DingTalk references under the shared DSH writer lock, and preserves unrelated references, records, and comments. A legacy flat credential document is migrated to the DSH v1 layout on the next setup write. Setup can also migrate an existing default account from `$DSH_HOME/.env` and removes legacy plaintext profile overrides during migration.

The default account keeps its runtime state under `~/.dsh-dingtalk/`. Additional accounts are isolated under `~/.dsh-dingtalk/accounts/<account-id>/`; owner bindings, session mappings, deduplication and capability state are not shared across accounts. Owner challenges are stored as salted digests, never as plaintext codes. `doctor` reports each account separately.

## DWS

DWS integration is disabled by default. Enable it from setup to mount the bundled DWS skill in the DingTalk workspace. DWS remains responsible for its own installation and user login; if it is missing or logged out, ordinary DingTalk messaging continues to work. Multi-account mode shares one DSH workspace and user-level DWS login, and does not export any bot application's credentials as process-wide DWS credentials.

## Development

```bash
pnpm install
pnpm run ci
```

CI validates formatting, types, unit and CLI behavior, the exact NPM tarball, and installation of that tarball into the latest DSH `web` profile.

Pull request titles follow Conventional Commits, for example:

```text
feat(setup): add guided onboarding
fix(stream): reconnect after heartbeat timeout
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Support and contributions

The source is publicly maintained by DingTalk Real AI. GitHub Issues and Pull Requests are welcome. Report security vulnerabilities through GitHub Private vulnerability reporting; never disclose credentials or sensitive data in a public issue.

## License and attribution

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
