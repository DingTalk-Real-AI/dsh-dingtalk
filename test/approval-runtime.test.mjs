import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

let deliveryClock = Date.now()

function delivery(messageId, text, options = {}) {
  return {
    headers: { messageId: `delivery-${messageId}` },
    data: {
      msgId: messageId,
      msgtype: 'text',
      createAt: String(options.createAt ?? ++deliveryClock),
      conversationId: options.conversationId ?? 'direct-1',
      conversationType: options.conversationType ?? '1',
      senderStaffId: options.senderStaffId ?? 'owner-1',
      text: { content: text },
      sessionWebhook: options.sessionWebhook ?? `https://reply.test/${messageId}`,
    },
  }
}

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待公开审批运行时状态超时')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('公开 apply 运行时允许管理员通过私聊或同群一次性文字码审批并在超时后拒绝', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-approval-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previousStateDir = process.env.DSH_DINGTALK_STATE_DIR
  process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'state')
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
    else process.env.DSH_DINGTALK_STATE_DIR = previousStateDir
  })

  let robotListener
  class FakeClient {
    constructor() {
      this.socket = new EventEmitter()
      this.socket.readyState = 1
      this.socket.ping = () => this.socket.emit('pong')
    }
    registerCallbackListener(topic, listener) {
      if (topic === '/robot') robotListener = listener
    }
    async connect() {}
    async disconnect() {}
    socketCallBackResponse() {}
  }
  mock.module('dingtalk-stream', {
    namedExports: {
      DWClient: FakeClient,
      TOPIC_ROBOT: '/robot',
      TOPIC_CARD: '/card',
    },
  })
  t.after(() => mock.restoreAll())

  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return { ok: true, json: async () => ({ accessToken: 'redacted', expireIn: 7200 }) }
    }
    requests.push({ url, body: JSON.parse(init.body) })
    return { ok: true }
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { apply } = await import(`../lib/index.js?approval-runtime=${Date.now()}`)
  const dispose = []
  const listeners = new Map()
  let sessionEvent
  let followupCount = 0
  const workspace = { path: root, sessionIds: [], async attachSession() {} }
  const agentContext = {
    agent: undefined,
    tools: { register() {} },
    on(name, listener) {
      listeners.set(name, listener)
    },
  }
  const agent = {
    id: '',
    status: 'idle',
    ctx: agentContext,
    followup() {
      followupCount += 1
      queueMicrotask(() =>
        sessionEvent({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }),
      )
    },
    cancel() {},
  }
  const ctx = {
    credentials: { async resolve() {} },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      resume: async () => {
        throw new Error('不应恢复不存在的 Agent')
      },
      create: async (options) => {
        agent.id = options.sessionId
        agentContext.agent = agent
        await options.setup?.(agentContext)
        return { agent }
      },
    },
    agentDefaultModel: { currentSelection: () => undefined },
    get(name) {
      if (name === 'workspaceRegistry') {
        return { resolveByPath: async () => workspace, create: async () => workspace }
      }
      if (name === 'sessionPersistence') return { list: async () => [] }
      return undefined
    },
    on(event, listener) {
      if (event === 'dispose') dispose.push(listener)
      if (event === 'session/event') sessionEvent = listener
    },
  }
  const config = {
    accounts: [
      {
        id: 'default',
        enabled: true,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        ownerStaffId: 'owner-1',
        groupAllowlist: ['direct-1'],
      },
    ],
    clientId: '',
    clientSecret: '',
    workspace: root,
    markdownTitle: 'DSH',
    interactionCardTemplateId: '',
    ownerStaffId: '',
    allowedSenders: [],
    groupAllowlist: [],
    replyMode: { direct: 'markdown', group: 'markdown' },
    streaming: { enabled: true, throttleMs: 500, maxCardChars: 15_000 },
    asyncMode: false,
    ackText: '',
    queueAckText: '',
    questionTimeoutMs: 300_000,
    approvalTimeoutMs: 80,
    tools: { enabled: false },
    sessionScope: 'chat',
    imageMode: 'auto',
    emotionFirstResponse: false,
    rejectNotice: false,
    debug: false,
  }

  await apply(ctx, config)
  t.after(() => dispose.forEach((listener) => listener()))

  await robotListener(delivery('start', '开始'))
  await waitUntil(() => typeof listeners.get('approval/request') === 'function' && followupCount === 1)
  const approve = listeners.get('approval/request')
  let fallbackCalls = 0
  const outcome = approve(
    {
      agent,
      toolName: 'workspace.write',
      reason: '需要修改工作区',
      signal: new AbortController().signal,
    },
    async () => {
      fallbackCalls += 1
      return 'unavailable'
    },
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fallbackCalls, 0)
  await waitUntil(() => requests.some((request) => request.body?.markdown?.text?.includes('审批敏感操作')))
  const approvalText = requests.find((request) => request.body?.markdown?.text?.includes('审批敏感操作')).body.markdown
    .text
  const code = approvalText.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(code)

  let settled = false
  void outcome.then(() => {
    settled = true
  })
  await robotListener(delivery('group-confirm', `确认 ${code}`, { conversationType: '2', senderStaffId: 'other-user' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  await robotListener(delivery('other-confirm', `确认 ${code}`, { senderStaffId: 'other-user' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  await robotListener(delivery('owner-confirm', `确认 ${code}`))
  assert.equal(await outcome, 'allowed-once')

  const timedOut = approve(
    {
      agent,
      toolName: 'workspace.delete',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )
  assert.equal(await timedOut, 'unavailable')
  assert.match(requests.at(-1).body.markdown.text, /审批已超时/)

  const approvalMessageCount = requests.filter((request) =>
    request.body?.markdown?.text?.includes('审批敏感操作'),
  ).length
  await robotListener(delivery('group-start', '群聊操作', { conversationType: '2' }))
  await waitUntil(() => followupCount === 2)
  const groupOutcome = approve(
    {
      agent,
      toolName: 'workspace.write',
      signal: new AbortController().signal,
    },
    async () => 'unavailable',
  )
  await waitUntil(
    () =>
      requests.filter((request) => request.body?.markdown?.text?.includes('审批敏感操作')).length ===
      approvalMessageCount + 1,
  )
  const groupApprovalText = requests.filter((request) => request.body?.markdown?.text?.includes('审批敏感操作')).at(-1)
    .body.markdown.text
  const groupCode = groupApprovalText.match(/`确认 ([A-Z0-9]{6})`/)?.[1]
  assert.ok(groupCode)
  await robotListener(delivery('group-owner-confirm', `确认 ${groupCode}`, { conversationType: '2' }))
  assert.equal(await groupOutcome, 'allowed-once')
})
