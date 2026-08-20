import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { apply } from '../lib/index.js'

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('等待公开运行时行为超时')
}

function baseConfig(workspace, access) {
  return {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    workspace,
    markdownTitle: 'DSH',
    interactionCardTemplateId: '',
    ownerStaffId: 'owner',
    senderAccess: access.senderAccess,
    allowedSenders: access.allowedSenders,
    groupAccess: access.groupAccess,
    groupAllowlist: access.groupAllowlist,
    replyMode: { direct: 'text', group: 'text' },
    streaming: { enabled: false, throttleMs: 500, maxCardChars: 15_000 },
    asyncMode: false,
    ackText: '处理中',
    queueAckText: '排队中',
    questionTimeoutMs: 300_000,
    approvalTimeoutMs: 300_000,
    tools: { enabled: false },
    sessionScope: 'chat-sender',
    imageMode: 'never',
    emotionFirstResponse: false,
    rejectNotice: false,
    debug: false,
  }
}

function createHost(workspace) {
  const eventHandlers = new Map()
  const agents = new Map()
  const created = []
  const followups = []
  const workspaceSessions = []

  const emit = (name, ...args) => {
    for (const handler of eventHandlers.get(name) ?? []) handler(...args)
  }
  const registry = {
    get: (id) => agents.get(id),
    resume: async () => {
      throw new Error('测试不应恢复旧会话')
    },
    create: async (options) => {
      const scopedHandlers = new Map()
      const agentCtx = {
        agent: undefined,
        tools: { register: () => () => {} },
        on(name, handler) {
          scopedHandlers.set(name, handler)
          return () => scopedHandlers.delete(name)
        },
      }
      const agent = {
        id: options.sessionId,
        status: 'idle',
        ctx: agentCtx,
        followup(message) {
          followups.push({ sessionId: options.sessionId, message })
          queueMicrotask(() => {
            emit(
              'session/event',
              { id: options.sessionId },
              {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: '已处理' }] } },
              },
            )
            emit('session/event', { id: options.sessionId }, { type: 'turn/end', data: { reason: {} } })
          })
        },
        steer() {},
        cancel() {},
      }
      agentCtx.agent = agent
      await options.setup?.(agentCtx)
      agents.set(options.sessionId, agent)
      created.push({ sessionId: options.sessionId, cwd: options.meta?.cwd, agent, scopedHandlers })
      return { agent, dispose: async () => {} }
    },
  }
  const linkedWorkspace = {
    path: workspace,
    sessionIds: workspaceSessions,
    async attachSession(sessionId) {
      if (!workspaceSessions.includes(sessionId)) workspaceSessions.push(sessionId)
    },
  }
  const ctx = {
    agents: registry,
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'model' }) },
    credentials: { resolve: async () => undefined },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          resolveByPath: async () => linkedWorkspace,
          create: async () => linkedWorkspace,
        }
      }
      return undefined
    },
    on(name, handler) {
      const handlers = eventHandlers.get(name) ?? []
      handlers.push(handler)
      eventHandlers.set(name, handlers)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
  }
  return {
    ctx,
    created,
    followups,
    dispose: () => emit('dispose'),
  }
}

function delivery(messageId, senderStaffId, conversationId, conversationType = '2', text = `消息-${messageId}`) {
  return {
    headers: { messageId },
    data: JSON.stringify({
      msgId: messageId,
      msgtype: 'text',
      conversationType,
      conversationId,
      senderStaffId,
      senderNick: '测试用户',
      text: { content: text },
      createAt: messageId,
      sessionWebhook: 'https://example.test/session',
    }),
  }
}

test('公开插件运行时执行发送者和群策略，并按群成员隔离会话', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-runtime-access-'))
  const originalStateDir = process.env.DSH_DINGTALK_STATE_DIR
  const originalFetch = globalThis.fetch
  const originalConnect = DWClient.prototype.connect
  const originalDisconnect = DWClient.prototype.disconnect
  const originalRegister = DWClient.prototype.registerCallbackListener
  const originalCallbackResponse = DWClient.prototype.socketCallBackResponse
  const streamClients = []
  const runtimeHosts = []
  const sent = []

  t.after(async () => {
    for (const host of runtimeHosts) host.dispose()
    if (originalStateDir === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
    else process.env.DSH_DINGTALK_STATE_DIR = originalStateDir
    globalThis.fetch = originalFetch
    DWClient.prototype.connect = originalConnect
    DWClient.prototype.disconnect = originalDisconnect
    DWClient.prototype.registerCallbackListener = originalRegister
    DWClient.prototype.socketCallBackResponse = originalCallbackResponse
    await rm(root, { recursive: true, force: true })
  })

  DWClient.prototype.registerCallbackListener = function (topic, callback) {
    let record = streamClients.find((item) => item.client === this)
    if (!record) {
      record = { client: this, callbacks: new Map() }
      streamClients.push(record)
    }
    record.callbacks.set(topic, callback)
  }
  DWClient.prototype.connect = async function () {
    const socket = new EventEmitter()
    socket.readyState = 1
    socket.ping = () => {}
    this.socket = socket
  }
  DWClient.prototype.disconnect = async function () {
    if (this.socket) this.socket.readyState = 3
  }
  DWClient.prototype.socketCallBackResponse = () => {}
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return { ok: true, json: async () => ({ accessToken: 'test-token', expireIn: 7200 }) }
    }
    sent.push({ url, body: JSON.parse(init.body) })
    return { ok: true, text: async () => '' }
  }

  process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'allowlist-state')
  const allowlistHost = createHost(path.join(root, 'allowlist-workspace'))
  runtimeHosts.push(allowlistHost)
  await apply(
    allowlistHost.ctx,
    baseConfig(path.join(root, 'allowlist-workspace'), {
      senderAccess: 'allowlist',
      allowedSenders: ['member-a', 'member-b'],
      groupAccess: 'allowlist',
      groupAllowlist: ['group-a'],
    }),
  )
  const allowlistInbound = streamClients[0].callbacks.get(TOPIC_ROBOT)

  await allowlistInbound(delivery('allowed-a', 'member-a', 'group-a'))
  await waitFor(() => allowlistHost.created.length === 1 && allowlistHost.followups.length === 1)

  const groupSession = allowlistHost.created[0]
  const groupApproval = groupSession.scopedHandlers.get('approval/request')
  assert.equal(typeof groupApproval, 'function')
  const approvalPromise = groupApproval(
    {
      agent: groupSession.agent,
      toolName: 'bash',
      reason: '验证群成员敏感操作审批',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )
  await waitFor(() => sent.some((item) => item.body.markdown?.text?.includes('验证群成员敏感操作审批')))
  const approvalText = sent.find((item) => item.body.markdown?.text?.includes('验证群成员敏感操作审批')).body.markdown
    .text
  const approvalCode = approvalText.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(approvalCode)
  await allowlistInbound(delivery('owner-approval', 'owner', 'group-a', '2', `确认 ${approvalCode}`))
  assert.equal(await approvalPromise, 'allowed-once')
  assert.equal(allowlistHost.followups.length, 1)

  await allowlistInbound(delivery('blocked-sender', 'intruder', 'group-a'))
  await allowlistInbound(delivery('blocked-group', 'member-b', 'group-b'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(allowlistHost.created.length, 1)
  assert.equal(allowlistHost.followups.length, 1)

  await allowlistInbound(delivery('allowed-b', 'member-b', 'group-a'))
  await waitFor(() => allowlistHost.created.length === 2 && allowlistHost.followups.length === 2)
  assert.notEqual(allowlistHost.created[0].sessionId, allowlistHost.created[1].sessionId)

  await allowlistInbound(delivery('direct-member', 'member-a', 'direct-member-a', '1'))
  await waitFor(() => allowlistHost.created.length === 3 && allowlistHost.followups.length === 3)
  const directSession = allowlistHost.created[2]
  const directApproval = directSession.scopedHandlers.get('approval/request')
  assert.equal(
    await directApproval(
      {
        agent: directSession.agent,
        toolName: 'bash',
        signal: new AbortController().signal,
      },
      async () => 'allowed-once',
    ),
    'unavailable',
  )
  assert.ok(sent.some((item) => item.body.markdown?.text?.includes('敏感操作只能由机器人管理员批准')))

  process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'all-state')
  const allHost = createHost(path.join(root, 'all-workspace'))
  runtimeHosts.push(allHost)
  await apply(
    allHost.ctx,
    baseConfig(path.join(root, 'all-workspace'), {
      senderAccess: 'all',
      allowedSenders: [],
      groupAccess: 'all',
      groupAllowlist: [],
    }),
  )
  const allInbound = streamClients[1].callbacks.get(TOPIC_ROBOT)
  await allInbound(delivery('open-to-all', 'any-member', 'any-group'))
  await waitFor(() => allHost.followups.length === 1)

  assert.deepEqual(allHost.followups[0].message.content, [{ type: 'text', text: '消息-open-to-all' }])
  await waitFor(() => sent.filter((item) => item.body.msgtype === 'text').length === 4)
})
