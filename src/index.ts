/**
 * dsh-dingtalk — DingTalk IM channel plugin for DeepSeek Harness.
 * Inbound: DingTalk Stream long connection (no public endpoint needed).
 * Outbound: AI Card streaming (default) / markdown / text / asyncMode,
 * with 🤔 first-response emotion, per-conversation serial queue, and
 * slash commands. See README for the capability matrix.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  accountStateDir,
  configuredAccountSpecs,
  DEFAULT_ACCOUNT_ID,
  resolveRuntimeAccounts,
  type RuntimeAccount,
} from './accounts.js'
import { Config } from './config.js'
import { startStream } from './stream.js'
import { Outbound } from './outbound.js'
import { Emotion } from './emotion.js'
import { AICard, CardCapability, type CardTarget } from './aicard.js'
import { Renderer } from './renderer.js'
import { Bridge } from './bridge.js'
import { JsonStore } from './jsonstore.js'
import { Queue } from './queue.js'
import { Commands, isSessionControl, type ModelOverride } from './commands.js'
import { QuestionManager } from './questions.js'
import { WorkspaceLinker } from './workspace.js'
import { InteractionCards } from './interaction-card.js'
import { OwnerBinding } from './owner.js'
import { DwsTools } from './tools.js'
import { downloadImageByCode } from './media.js'
import { modelAcceptsImages } from './image-mode.js'
import { exactPackageSpec } from './package-info.js'
import { resolveStateDir } from './paths.js'
import { cardTarget } from './targets.js'
import type {
  HostAgentContext,
  HostAgentPresets,
  HostAgentRegistry,
  HostDefaultModel,
  HostSession,
  HostSessionEvent,
} from './host.js'

export const name = 'dingtalk-channel'
export const inject = ['agents', 'agentDefaultModel', 'credentials', 'llm']
export { Config }

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = (line: string) => console.log(`[dsh-dingtalk ${new Date().toTimeString().slice(0, 8)}] ${line}`)

  const credentialProvider = (ctx as any).credentials as
    | {
        resolve(ref: string): Promise<{ value: string } | undefined>
      }
    | undefined
  const resolveCredential = async (ref: string): Promise<string> => {
    try {
      return (await credentialProvider?.resolve(ref))?.value ?? ''
    } catch (error) {
      log(`credential ${ref} unavailable (${error instanceof Error ? error.message : error})`)
      return ''
    }
  }
  const resolution = await resolveRuntimeAccounts(configuredAccountSpecs(config), resolveCredential, process.env)
  for (const id of resolution.missingCredentialAccountIds) log(`robot ${id}: missing credentials — skipped`)
  for (const id of resolution.duplicateAccountIds)
    log(`robot ${id}: clientId already used by an earlier robot — skipped`)
  if (!resolution.accounts.length) {
    log('no configured DingTalk robots could start')
    return
  }

  const cwd = config.workspace || path.join(os.homedir(), 'dsh-dingtalk-workspace')
  fs.mkdirSync(cwd, { recursive: true })
  const primary = resolution.accounts[0]
  const dwsTools = new DwsTools({
    workspace: cwd,
    clientId: primary.clientId,
    clientSecret: primary.clientSecret,
    exposeCredentials: resolution.accounts.length === 1,
    log,
  })
  if (config.tools.enabled) void dwsTools.enable()

  await Promise.all(
    resolution.accounts.map(async (account) => {
      try {
        await startAccount(ctx, config, account, cwd, dwsTools)
      } catch (error) {
        log(`robot ${account.id}: failed to start (${error instanceof Error ? error.message : error})`)
      }
    }),
  )
}

async function startAccount(
  ctx: Context,
  config: Config,
  account: RuntimeAccount,
  cwd: string,
  dwsTools: DwsTools,
): Promise<void> {
  const { clientId, clientSecret } = account
  const log = (line: string) =>
    console.log(`[dsh-dingtalk:${account.id} ${new Date().toTimeString().slice(0, 8)}] ${line}`)
  const interactionCardTemplateId =
    config.interactionCardTemplateId || process.env.DINGTALK_INTERACTION_CARD_TEMPLATE_ID || ''
  const stateDir = accountStateDir(resolveStateDir(), account.id)
  let streamStatus: 'connecting' | 'connected' | 'reconnecting' | 'stopped' = 'connecting'
  const owner = new OwnerBinding({
    file: path.join(stateDir, 'owner.json'),
    configuredOwner:
      account.ownerStaffId || (account.id === DEFAULT_ACCOUNT_ID ? process.env.DINGTALK_OWNER_STAFF_ID || '' : ''),
    legacyAllowedSenders: account.senderAccess === 'owner' ? account.allowedSenders : [],
    senderAccess: account.senderAccess,
    allowedSenders: account.allowedSenders,
    groupAccess: account.groupAccess,
    allowedGroups: account.groupAllowlist,
  })
  // Onboarding gap guard: an unbound connector silently rejects everyone, so
  // say at boot HOW to claim it (the code itself never goes into logs).
  {
    const s = owner.status()
    if (!s.bound) {
      log(
        s.challengeReady
          ? 'owner not bound — 有效绑定口令已生成：请用属主账号私聊机器人发送 /bind <口令>'
          : `owner not bound — 请在本机运行 \`npx ${exactPackageSpec} setup\` 生成一次性口令，再私聊机器人发送 /bind <口令>`,
      )
    } else {
      log('owner bound')
    }
  }

  // DSH workspaces require explicit session membership in addition to cwd.
  // The services start asynchronously after this plugin, so resolve lazily.
  const workspace = new WorkspaceLinker({
    cwd,
    resolveRegistry: () => (ctx as any).get?.('workspaceRegistry'),
    resolvePersistence: () => (ctx as any).get?.('sessionPersistence'),
    log,
  })
  void workspace.start()

  // Host services are typed structurally (see host.ts); inject guarantees presence.
  const agents = (ctx as any).agents as HostAgentRegistry
  const defaultModel = (ctx as any).agentDefaultModel as HostDefaultModel
  const currentDefault = () => {
    try {
      return defaultModel.currentSelection()
    } catch (err) {
      log(`default model unavailable (${err instanceof Error ? err.message : err}); letting the host decide`)
      return undefined
    }
  }

  const outbound = new Outbound({ clientId, clientSecret }, log)
  // Shared by question/plan-review/approval cards and the queue busy card.
  const interactionCards = interactionCardTemplateId
    ? new InteractionCards(() => outbound.token(), clientId, interactionCardTemplateId, log)
    : undefined
  const cardCapabilityFile = path.join(stateDir, 'capabilities.json')
  const cardCapability = new CardCapability((reason) => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      cardCapabilityFile,
      `${JSON.stringify(
        {
          aiCard: { available: false, reason, observedAt: Date.now() },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    fs.chmodSync(cardCapabilityFile, 0o600)
  })
  const emotion = new Emotion(() => outbound.token(), clientId, log)
  const renderer = new Renderer({
    config,
    outbound,
    emotion,
    createCard: (target: CardTarget) =>
      AICard.create({
        token: () => outbound.token(),
        robotCode: clientId,
        target,
        capability: cardCapability,
        log,
      }),
    log,
  })
  const bindings = new JsonStore<string>(path.join(stateDir, 'bindings.json'), log)
  const modelOverrides = new JsonStore<ModelOverride>(path.join(stateDir, 'models.json'), log)
  const workspaceOverrides = new JsonStore<string>(path.join(stateDir, 'workspaces.json'), log)
  const queue = new Queue(log)
  const questions = new QuestionManager({
    outbound,
    markdownTitle: config.markdownTitle,
    timeoutMs: config.questionTimeoutMs,
    approvalTimeoutMs: config.approvalTimeoutMs,
    approvalUserId: () => owner.status().ownerStaffId,
    interactionCards,
    log,
  })
  const bridge = new Bridge(agents, renderer, bindings, {
    cwd,
    log,
    modelOverrides,
    workspaceOverrides,
    modelSelection: currentDefault,
    resolveImage: async (downloadCode, scopeKey) => {
      const legacyMode = config.attachImages === true ? 'always' : config.attachImages === false ? 'never' : undefined
      const route = modelOverrides.get(scopeKey) ?? currentDefault()
      const accepted = await modelAcceptsImages(legacyMode ?? config.imageMode, route as any, (ctx as any).llm)
      if (!accepted) return null
      try {
        const attachments = (ctx as any).get?.('attachments')
        if (!attachments?.saveImage) {
          log('attachments service unavailable; image dropped to text note')
          return null
        }
        const image = await downloadImageByCode(await outbound.token(), clientId, downloadCode, log)
        if (!image) return null
        const ref = await attachments.saveImage({ data: image.data, mediaType: image.mediaType })
        log(`inbound image stored (${image.mediaType}, ${image.data.length} bytes)`)
        return { type: 'image', attachment: ref }
      } catch (err) {
        log(`inbound image failed: ${err instanceof Error ? err.message : err}`)
        return null
      }
    },
    onAgentMessage: (agent, msg) => {
      // A session may already be live because the Web UI loaded it before this
      // channel sees a message. Creation/resume setup is skipped in that path,
      // so attach the channel shadow through the live Agent.ctx as well.
      questions.installFor(agent)
      questions.bindSession(agent.id, msg)
      void workspace.attach(agent.id)
    },
    compose: async () => {
      // Optional service: a deployment without a roster runs preset-less
      // (host-composition tools only), matching apiproxy's fallback.
      const presets = (ctx as any).get?.('agentPresets') as HostAgentPresets | undefined
      if (!presets) {
        return { setup: async (agentCtx: HostAgentContext) => questions.install(agentCtx) }
      }
      try {
        const resolved = await presets.resolve(undefined)
        return {
          agentPreset: resolved.id,
          setup: async (agentCtx: HostAgentContext) => {
            await presets.mount(agentCtx, resolved.id)
            questions.install(agentCtx)
          },
        }
      } catch (err) {
        log(`preset compose failed (${err instanceof Error ? err.message : err}); continuing with DingTalk tools only`)
        return { setup: async (agentCtx: HostAgentContext) => questions.install(agentCtx) }
      }
    },
  })
  const commands = new Commands({
    agents,
    outbound,
    bindings,
    modelOverrides,
    queue,
    defaultModel: currentDefault,
    toolsStatusLine: () => dwsTools.statusLine(),
    workspaceOverrides,
    defaultWorkspace: cwd,
    listWorkspaces: async () => {
      try {
        const registry = (ctx as any).get?.('workspaceRegistry')
        if (!registry?.list) return []
        const items = await registry.list()
        return (Array.isArray(items) ? items : []).map((w: any) => ({ path: w.path ?? String(w), title: w.title }))
      } catch {
        return []
      }
    },
    connectorStatus: () => {
      const ownerStatus = owner.status()
      const senderAccess =
        ownerStatus.senderAccess === 'all'
          ? '所有人'
          : ownerStatus.senderAccess === 'owner'
            ? '仅管理员'
            : `管理员 + ${ownerStatus.allowedSenderCount} 人`
      const groupAccess =
        ownerStatus.groupAccess === 'all'
          ? '所有群'
          : ownerStatus.groupAccess === 'none'
            ? '已关闭'
            : `${ownerStatus.allowedGroupCount} 个群`
      return [
        `管理员：${ownerStatus.bound ? '已绑定' : '未绑定'}`,
        `发送者：${senderAccess}`,
        `群聊：${groupAccess}`,
        `Stream：${streamStatus}`,
        `AI Card：${cardCapability.available ? '可尝试' : `已降级（${cardCapability.reason}）`}`,
        `敏感审批：${interactionCardTemplateId ? '互动卡片' : '管理员私聊文字确认码'}`,
      ]
    },
    markdownTitle: config.markdownTitle,
    log,
  })

  ;(ctx as any).on('session/event', (session: HostSession, event: HostSessionEvent) => {
    renderer.onSessionEvent(session, event)
  })

  // Reject visibility (Feishu SDK's reject-with-reason lesson): tell the
  // sender once per hour why the bot ignores them, instead of dead silence.
  const rejectNoticedAt = new Map<string, number>()
  const accessReplyQueues = new Map<string, Promise<void>>()
  const queueAccessReply = (conversationId: string, send: () => Promise<unknown>): Promise<void> => {
    const previous = accessReplyQueues.get(conversationId) ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        await send()
      })
    accessReplyQueues.set(conversationId, queued)
    void queued
      .finally(() => {
        if (accessReplyQueues.get(conversationId) === queued) accessReplyQueues.delete(conversationId)
      })
      .catch(() => undefined)
    return queued
  }
  const noticeReject = async (
    msg: { conversationId: string; sessionWebhook: string },
    key: string,
    text: string,
  ): Promise<void> => {
    if (!config.rejectNotice) return
    const last = rejectNoticedAt.get(key)
    if (last !== undefined && Date.now() - last < 60 * 60_000) return
    rejectNoticedAt.set(key, Date.now())
    await queueAccessReply(msg.conversationId, () =>
      outbound.sendMarkdown(msg.sessionWebhook, config.markdownTitle, text),
    )
  }
  const stop = await startStream({
    clientId,
    clientSecret,
    debug: config.debug,
    seenFile: path.join(stateDir, 'seen.json'),
    log,
    onUnsupported: (msgtype, sessionWebhook) => {
      void noticeReject(
        { conversationId: `unsupported:${sessionWebhook}`, sessionWebhook },
        `msgtype:${msgtype}`,
        `📎 暂不支持处理 ${msgtype === 'file' ? '文件' : msgtype === 'audio' ? '语音' : msgtype === 'video' ? '视频' : `该类型（${msgtype}）`}消息，请用文字${msgtype === 'file' ? '粘贴关键内容' : '描述'}。`,
      )
    },
    onStatus: (status) => {
      streamStatus = status
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const runtimeFile = path.join(stateDir, 'runtime.json')
      fs.writeFileSync(
        runtimeFile,
        `${JSON.stringify(
          {
            stream: { status, observedAt: Date.now() },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      )
      fs.chmodSync(runtimeFile, 0o600)
    },
    onMessage: async (msg) => {
      const access = owner.authorize(msg)
      if (access.kind === 'bound') {
        log('owner binding completed from direct message')
        await queueAccessReply(msg.conversationId, () =>
          outbound.sendMarkdown(
            msg.sessionWebhook,
            config.markdownTitle,
            '✅ 刚才发送的绑定指令已成功，无需重复发送。消息访问范围按 setup 配置生效；敏感操作审批仍只接受管理员。',
          ),
        )
        return
      }
      if (access.kind === 'denied') {
        log(`inbound access denied (${access.reason})`)
        const notice =
          access.reason === 'binding-command-malformed'
            ? '绑定指令格式不正确。请私聊发送 setup 显示的完整 `/bind <口令>`，并确保命令与口令之间只有普通空格。'
            : access.reason === 'owner-not-bound' || access.reason.startsWith('binding-')
              ? '这条消息未处理：Connector 尚未完成管理员绑定。请私聊发送当前 setup 已显示的一次性绑定指令；若已经发送，请等待成功回执，无需重新运行 setup。'
              : '当前用户或群聊未获授权。'
        await noticeReject(msg, `${msg.senderStaffId}:${msg.conversationId}:${access.reason}`, notice)
        return
      }
      await accessReplyQueues.get(msg.conversationId)?.catch(() => undefined)
      log(`inbound message accepted (${msg.conversationType})`)

      // Any new bubble below a live streaming card breaks reading order —
      // mark the turn so its next frame rolls over to a fresh card at the bottom.
      renderer.notifyInterleaved(msg.conversationId)

      // Session scope key: chat-sender isolates each group member's session.
      const scopeKey =
        account.sessionScope === 'chat-sender' && msg.conversationType === 'group'
          ? `${msg.conversationId}#${msg.senderStaffId}`
          : msg.conversationId

      // Picture without vision support: answer honestly instead of a silent drop.
      if (msg.imageDownloadCodes?.length) {
        const legacyMode = config.attachImages === true ? 'always' : config.attachImages === false ? 'never' : undefined
        const route = modelOverrides.get(scopeKey) ?? currentDefault()
        const accepted = await modelAcceptsImages(legacyMode ?? config.imageMode, route as any, (ctx as any).llm)
        if (!accepted) {
          await queueAccessReply(msg.conversationId, () =>
            outbound.sendMarkdown(
              msg.sessionWebhook,
              config.markdownTitle,
              '🖼️ 图片已收到，但当前会话模型没有声明图片输入能力。请切换到支持图片的模型；自定义模型还需要在 DSH 模型配置中声明 `input: [text, image]`。',
            ),
          )
          if (!msg.text) return
        }
      }

      // Session lifecycle must win over an outstanding question. Otherwise
      // `/new` would be consumed as a free-text answer and preserve old work.
      if (isSessionControl(msg.text) && (await commands.handle(msg, scopeKey))) return

      // A tool may be waiting inside the active queued turn. Consume its
      // matching answer before commands/queue to avoid a circular wait.
      if (questions.handleInbound(msg)) return

      // Commands and queue choices answer immediately, outside the queue.
      if (await commands.handle(msg, scopeKey)) return

      if (config.emotionFirstResponse) emotion.add(msg.msgId, msg.conversationId)
      const lane = { skipped: false, started: false }
      queue.run(
        scopeKey,
        async () => {
          lane.started = true
          if (lane.skipped) {
            if (config.emotionFirstResponse) await emotion.recall(msg.msgId, msg.conversationId)
            return
          }
          await bridge.process(msg, scopeKey)
        },
        (position) => {
          const target = cardTarget(msg)
          const noticeText = [
            `${config.queueAckText}（第 ${position} 位），不回复则排队等待`,
            '- 回复 `1` 或 `/stop` —— 打断当前任务，尽快处理本条',
            '- 回复 `2` —— 把本条并入当前任务（引导方向，不打断）',
          ].join('\n')
          // Carrier preference: interactive card with real buttons (approve =
          // interrupt, reject = steer; waiting is simply not pressing) →
          // updatable AI Card whose choice outcome morphs it in place →
          // plain bubble. Text answers 1/2 stay valid on every carrier.
          const noticeCard = (async (): Promise<AICard | null> => {
            if (interactionCards) {
              const outTrackId = `busy_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
              const ok = await interactionCards.create({
                outTrackId,
                kind: 'queue-choice',
                target,
                title: `${config.queueAckText}（第 ${position} 位）`,
                detail: '不操作则排队等待；也可直接回复 1（打断）/ 2（并入）。',
                approveLabel: '⛔ 打断当前任务',
                rejectLabel: '➡️ 并入当前任务',
              })
              if (ok) {
                commands.registerBusyCard(outTrackId, scopeKey)
                return null
              }
            }
            const card = await AICard.create({
              token: () => outbound.token(),
              robotCode: clientId,
              target,
              capability: cardCapability,
              log,
            })
            if (!card) {
              void outbound.sendMarkdown(msg.sessionWebhook, config.markdownTitle, noticeText)
              return null
            }
            try {
              await card.finish(noticeText)
              return card
            } catch {
              void outbound.sendMarkdown(msg.sessionWebhook, config.markdownTitle, noticeText)
              return null
            }
          })()
          commands.markBusyNotice(scopeKey, {
            queuedMsg: msg,
            skip: () => {
              lane.skipped = true
            },
            started: () => lane.started,
            noticeCard,
          })
        },
      )
    },
    onCardCallback: async (callback) => {
      const handled = questions.handleCardCallback(callback) || (await commands.handleCardCallback(callback))
      if (!handled) return {}
      const approved = callback.actionIds[0] === 'approve'
      return {
        cardData: { cardParamMap: { status: approved ? 'approved' : 'rejected' } },
        cardUpdateOptions: { updateCardDataByKey: true },
      }
    },
  })
  ;(ctx as any).on('dispose', () => stop())

  log(
    `channel up: workspace=${cwd} replyMode=${config.replyMode.direct}/${config.replyMode.group} streaming=${config.streaming.enabled} async=${config.asyncMode}`,
  )
}
