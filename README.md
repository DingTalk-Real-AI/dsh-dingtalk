# DSH DingTalk

[简体中文](README.zh-CN.md) | English

Connect local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to DingTalk over a Stream connection, without a public inbound endpoint.

Node.js `^22.19.0 || >=24.0.0` is required. The bot works only while local `dsh web` is running and the computer is online; it does not keep running in the cloud after sleep, network loss, or process exit.

## AI Native setup (recommended)

An AI agent can inspect the setup plan, execute explicitly approved non-secret steps, and resume from a checkpoint. QR URLs, Client Secrets, and plaintext `/bind` codes are excluded from machine JSON and checkpoints and are assigned to a separate terminal handoff that you operate yourself.

```text
read-only inspection and plan
→ explicit dependency, plugin, and configuration approvals
→ AI execution with a non-secret checkpoint
→ private human QR/Secret/binding handoff
→ AI checkpoint resume
→ explicit dsh web start or restart
→ doctor plus one real-message acceptance check
```

You can give this prompt to an AI coding agent:

```text
Install the DingTalk connector using the AI Native setup flow in this README. Run the read-only plan first and show me the plan and non-secret answers before apply. Never request, read, or record a Client ID, Client Secret, QR URL, Device Code, /bind code, or owner staff ID. At a private checkpoint, pause so I can continue in a separate local terminal, then validate with JSON resume and doctor --json. Never automatically start, stop, or restart dsh web.
```

Resolve the stable release version first, then pin every step to that version:

```bash
npx @dingtalk-real-ai/dsh-dingtalk@latest --version
```

Record the output as `<version>`, then generate a strictly read-only plan. Use `default` for a new installation; select an account explicitly when several already exist.

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --plan --json --account default
```

The plan only reads local configuration and the process table, and runs `dsh --version` and `pnpm --version`. It never installs, writes files, creates binding codes, or controls processes. Its stable output includes `planId`, actions, required approvals, and an `answerTemplate`. Replace every `null` with an explicit choice and save the result as JSON:

```json
{
  "schemaVersion": 1,
  "planId": "setup-plan-<from-plan>",
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

Keep DSH or pnpm installation approval `false` when the plan does not request that action. Set it to `true` only after explicit user approval; machine mode never assumes “yes.” Apply the plan with:

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --apply --json --answers <answers.json>
```

Common outcomes:

| `status`                       | Next action                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `blocked`                      | A required approval is missing; revise the answers, then create and apply a fresh plan.                                            |
| `failed`                       | Inspect stable `error.code` / `stepId`; raw subprocess errors are never copied into machine output.                                |
| `awaiting_private_credentials` | In a separate local terminal, run the same version with `setup --resume <checkpoint-id>` and personally scan or enter credentials. |
| `awaiting_private_binding`     | Run the same private resume locally to display a new one-time owner-binding code.                                                  |
| `awaiting_bind`                | Start DSH Web, wait for the bot to connect, then send the displayed `/bind <one-time-code>` in a DingTalk direct message.          |
| `start_required`               | Explicitly run `dsh web` in a dedicated terminal.                                                                                  |
| `restart_required`             | Explicitly restart `dsh web` with the existing process manager; machine setup never kills it.                                      |
| `completed`                    | Configuration is complete and a previously stopped `dsh web` is now running; continue with `doctor --json`.                        |

JSON mode writes exactly one complete JSON document to stdout. Exit code `0` means the protocol returned successfully, including human-wait states and diagnostic `warning/unverified`; `1` means execution or diagnostics failed; `2` means invalid arguments or answers. Automation should depend on `schemaVersion`, `kind`, `status`, `id`, and `code`, not display messages.

Private resume omits `--json` and is accepted only in an interactive terminal:

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id>
```

The TTY check prevents accidental pipe or headless use; it cannot prove that a human owns the terminal. Automation that allocates or records a PTY can capture what is displayed. Stop the agent at this handoff and run the command yourself in a terminal session that the agent does not control or record.

After the private step or owner binding, let the AI re-inspect real state. Concurrent resumes are serialized and checkpointed completed steps are skipped. If the process is killed after an external command succeeds but before its checkpoint write, the same exact-version idempotent command can be retried.

```bash
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id> --json
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --json
```

Finally, send one real direct message to the bot. `doctor` validates local configuration and recent runtime observations; it does not replace live message-path acceptance.

Checkpoints use mode `0600` and reject dedicated Client ID, Client Secret, QR/device-code, owner-ID, and plaintext `/bind` fields. They do store the explicitly approved non-secret setup choices, including sender and group allowlists, so treat them as private local metadata. Credentials remain in DSH's private credential store, while owner challenges are persisted only as salted digests.

Dead setup-lock owners are normally recovered automatically. If a process is force-killed during lock cleanup itself, the next run deliberately fails closed instead of risking concurrent writes. After verifying that no setup process is still running, remove only the orphan `.lock` and matching `.owner.*` artifacts beside the affected checkpoint or web profile; never delete checkpoint JSON or credential files.

## Interactive setup

Without AI orchestration, use the original guided flow:

```bash
npx @dingtalk-real-ai/dsh-dingtalk@latest setup
```

The guide checks DSH and pnpm, asks before installing a missing or incompatible dependency, installs this exact connector version, collects credentials, configures DWS, image and access policies, creates the owner-binding code, and offers to start `dsh web`. It never upgrades an existing DSH installation automatically.

`npx` runs the CLI for this invocation and does not add `dsh-dingtalk` to PATH. New accounts initially allow all senders and groups; for personal use, prefer owner-only sender access and no group access, then expand deliberately.

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

For every machine step belonging to one checkpoint, replace `<version>` with the exact version printed before planning and keep it unchanged through validation.

```bash
# Install and configure, or reopen the configuration menu
npx @dingtalk-real-ai/dsh-dingtalk@latest setup

# Produce a read-only machine plan
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --plan --json --account default

# Apply explicit non-secret answers
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --apply --json --answers <answers.json>

# Private human handoff; requires an interactive terminal
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id>

# Idempotent machine resume
npx @dingtalk-real-ai/dsh-dingtalk@<version> setup --resume <checkpoint-id> --json

# Validate local state and DingTalk credentials
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor

# Stable, redacted machine diagnostics
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --json

# Avoid network calls
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --offline
npx @dingtalk-real-ai/dsh-dingtalk@<version> doctor --offline --json
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

New credentials are stored in `$DSH_HOME/.credentials.yaml` with owner-only permissions. The default account uses `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET`; additional accounts use namespaced references. For example, `support-bot` uses `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID` and `DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET`. Setup reads both the legacy flat document and the versioned v1 document. Immediately before a private write it probes the actual DSH on the same `PATH`, writes the flat layout before `0.1.1-rc.1`, and writes v1 from that version onward. Layout changes run under the shared DSH writer lock and preserve unrelated references, records, and representable comments. If an older DSH encounters a v1 document with non-empty `records`, setup refuses a lossy downgrade and asks you to upgrade DSH first. Setup can also migrate an existing default account from `$DSH_HOME/.env` and removes legacy plaintext profile overrides during migration.

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
