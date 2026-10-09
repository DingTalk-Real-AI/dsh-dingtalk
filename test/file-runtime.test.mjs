import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Bridge as RealBridge } from '../lib/bridge.js'
import { strictAgentContext } from './helpers/strict-agent-context.mjs'

let source
// 只替换传输和 turn 完成信号，保持 apply 的授权、队列、工作区与文件链路真实。
mock.module('../lib/inbound-source.js', {
  namedExports: {
    RobotStreamSource: class {
      constructor(options) {
        source = options
      }
      async start() {}
      stop() {}
    },
  },
})
mock.module('../lib/digital-employee-control.js', {
  namedExports: {
    serveEmployeeControl: async () => ({ async close() {} }),
  },
})
mock.module('../lib/bridge.js', {
  namedExports: {
    Bridge: class extends RealBridge {
      constructor(agents, _renderer, bindings, options) {
        super(agents, { onInbound: async () => {} }, bindings, options)
      }
    },
  },
})
const { apply, Config } = await import('../lib/index.js')

test(
  '公开 apply：未授权不下载，/cd 后落盘并注入可读引用，模型可回传文件，失败不伪造成功',
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-file-runtime-'))
    const workspace = path.join(root, 'workspace'),
      next = path.join(root, 'next')
    await mkdir(workspace)
    await mkdir(next)
    const previous = process.env.DSH_DINGTALK_STATE_DIR
    process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'state')
    const lifecycle = new Context(),
      scopes = [],
      agents = new Map(),
      messages = [],
      requests = []
    const original = globalThis.fetch
    let failDownload = false
    let onFollowup
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).includes('oauth2')) return Response.json({ accessToken: 'fixture-token' })
      if (String(url).includes('messageFiles/download')) {
        return failDownload
          ? Response.json({}, { status: 403 })
          : Response.json({ downloadUrl: 'https://fixture.invalid/content' })
      }
      if (url === 'https://fixture.invalid/content') return new Response('fixture PDF')
      if (String(url).includes('/media/upload')) return Response.json({ errcode: 0, media_id: 'fixture-media' })
      return Response.json({ processQueryKey: 'fixture-receipt' })
    }
    t.after(async () => {
      await lifecycle.fiber.dispose()
      for (const scope of scopes) await scope.dispose()
      globalThis.fetch = original
      if (previous === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
      else process.env.DSH_DINGTALK_STATE_DIR = previous
      await rm(root, { recursive: true, force: true })
    })
    const ctx = {
      effect: (...args) => lifecycle.effect(...args),
      credentials: { async resolve() {} },
      llm: {},
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) },
      agents: {
        get: (id) => agents.get(id),
        async create(options) {
          const tools = new Map()
          const scope = strictAgentContext((tool) => {
            tools.set(tool.name, tool)
            return () => tools.delete(tool.name)
          })
          scopes.push(scope)
          const agent = {
            id: options.sessionId,
            ctx: scope.ctx,
            status: 'idle',
            tools,
            followup(message) {
              messages.push({ message, agent, cwd: options.meta.cwd })
              onFollowup?.()
            },
          }
          await options.setup?.(scope.ctx, agent)
          agents.set(agent.id, agent)
          return { agent }
        },
      },
      on() {},
      get(name) {
        if (name === 'workspaceRegistry')
          return {
            resolveByPath: async (cwd) => ({ path: cwd, sessionIds: [], async attachSession() {} }),
          }
        return undefined
      },
    }
    await apply(
      ctx,
      Config({
        accounts: [{ id: 'fixture', clientId: 'fixture', clientSecret: 'fixture', ownerStaffId: 'owner' }],
        workspace,
        tools: { enabled: false },
        emotionFirstResponse: false,
        replyMode: { direct: 'text', group: 'text' },
      }),
    )
    let sequence = 0
    const send = (changes = {}) =>
      source.onMessage({
        msgId: String(++sequence),
        conversationId: 'chat',
        conversationType: 'direct',
        senderStaffId: 'owner',
        text: '',
        sessionWebhook: 'https://fixture.invalid/reply',
        contentParts: [{ type: 'file', downloadCode: 'fixture-code', fileName: '../../报告.pdf' }],
        ...changes,
      })
    await send({ senderStaffId: 'stranger' })
    assert.equal(requests.filter(({ url }) => url.includes('messageFiles/download')).length, 0)
    assert.equal(messages.length, 0)
    await send({ text: `/cd ${next}`, contentParts: [] })
    const accepted = new Promise((resolve) => {
      onFollowup = resolve
    })
    await send()
    await accepted
    assert.equal(messages.length, 1)
    assert.equal(messages[0].cwd, next)
    const text = messages[0].message.content[0].text
    const ref = JSON.parse(text.split('\n')[1])
    assert.equal(ref.fileName, '报告.pdf')
    assert.ok(ref.path.startsWith(next + path.sep))
    assert.equal(await readFile(ref.path, 'utf8'), 'fixture PDF')
    assert.doesNotMatch(text, /fixture-code|fixture-token/)
    const agent = messages[0].agent
    await agent.tools.get('send_file').execute({ path: ref.path }, { agent, signal: new AbortController().signal })
    const sent = requests.find(({ url }) => url.endsWith('oToMessages/batchSend'))
    assert.deepEqual(JSON.parse(sent.init.body).userIds, ['owner'])
    failDownload = true
    const failed = new Promise((resolve) => {
      onFollowup = resolve
    })
    await send()
    await failed
    assert.equal(messages.length, 2)
    assert.match(messages[1].message.content[0].text, /下载或保存失败/)
    assert.doesNotMatch(messages[1].message.content[0].text, /已保存/)
    await lifecycle.fiber.dispose()
    await assert.rejects(
      agent.tools.get('send_file').execute({ path: ref.path }, { agent, signal: new AbortController().signal }),
      /route_unavailable/,
    )
  },
)
