import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { authorizeDigitalEmployeeEvent, DwsDigitalEmployeeSource } from '../lib/digital-employee-runtime.js'
import { apply } from '../lib/index.js'

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('等待 fake DWS 运行时行为超时')
}

const employee = {
  agentUuid: 'employee-runtime-1',
  name: '值班助手',
  enabled: true,
  dwsProfile: 'corp-runtime:user-runtime',
  operatorOpenDingTalkId: 'operator-open-id',
  allowedDirectSenders: ['allowed-open-id'],
  allowedGroups: ['allowed-group'],
  sessionScope: 'chat-sender',
  protocolVersion: 1,
}

async function writeFakeDwsCommand(root, name, source, pathCommand = false) {
  if (pathCommand) {
    const command = path.join(root, name)
    await writeFile(command, source, { mode: 0o755 })
    await chmod(command, 0o755)
    return { dwsCommand: command, dwsArgsPrefix: [] }
  }
  const script = path.join(root, `${name}.cjs`)
  await writeFile(script, source, 'utf8')
  return { dwsCommand: process.execPath, dwsArgsPrefix: [script] }
}

test('本地白名单分别覆盖 operator、额外私聊、群白名单和默认拒绝', () => {
  const base = {
    schemaVersion: 1,
    eventId: 'access-event',
    messageId: 'access-message',
    conversationId: 'direct-conversation',
    conversationType: 'direct',
    senderOpenDingTalkId: 'operator-open-id',
    senderName: '用户',
    text: '正文',
    createdAt: '1',
  }
  assert.equal(authorizeDigitalEmployeeEvent(employee, base), true)
  assert.equal(authorizeDigitalEmployeeEvent(employee, { ...base, senderOpenDingTalkId: 'allowed-open-id' }), true)
  assert.equal(authorizeDigitalEmployeeEvent(employee, { ...base, senderOpenDingTalkId: 'intruder' }), false)
  assert.equal(
    authorizeDigitalEmployeeEvent(employee, {
      ...base,
      conversationType: 'group',
      conversationId: 'allowed-group',
      senderOpenDingTalkId: 'intruder',
    }),
    true,
  )
  assert.equal(
    authorizeDigitalEmployeeEvent(employee, {
      ...base,
      conversationType: 'group',
      conversationId: 'blocked-group',
    }),
    false,
  )
})

async function createFakeDws(root, pathCommand = false) {
  const source = `#!/usr/bin/env node
const fs = require('node:fs')
const record = process.env.FAKE_DWS_RECORD
const args = process.argv.slice(2)
const operation = args.includes('capabilities') ? 'capabilities' : args.includes('reply') ? 'reply' : args.includes('operator-private') ? 'operator-private' : args.includes('consume') ? 'consume' : 'unknown'
fs.appendFileSync(record, JSON.stringify({ operation, args, credentialEnvKeys: Object.keys(process.env).filter((key) => /TOKEN|AUTH_?CODE|CLIENT_?SECRET|PASSWORD|CREDENTIAL/i.test(key)) }) + '\\n')
if (operation === 'capabilities') {
  process.stdout.write(JSON.stringify({ ok: true, outcome: 'success', data: { schemaVersion: 1, protocolVersion: 1, auditMode: 'local_required', capabilities: { eventConsume: true, replyStdin: true, operatorPrivateStdin: true } }, meta: {} }))
  process.exit(0)
}

let input = ''
if (operation === 'consume') {
  process.stderr.write('[event] ready event_count=0 bus_pid=123\\n')
  const events = [
    { type: 'user_im_message_receive_group_all', event_id: 'event-allowed', message_id: 'message-allowed', conversation_id: 'allowed-group', sender_open_dingtalk_id: 'allowed-open-id', sender: '成员', content: '只应通过 stdin 回复的正文', event_time: '1' },
    { type: 'user_im_message_receive_group_all', event_id: 'event-allowed', message_id: 'message-allowed', conversation_id: 'allowed-group', sender_open_dingtalk_id: 'allowed-open-id', sender: '成员', content: '重复正文', event_time: '1' },
    { type: 'user_im_message_receive_group_all', event_id: 'event-denied', message_id: 'message-denied', conversation_id: 'blocked-group', sender_open_dingtalk_id: 'intruder', sender: '越权用户', content: '越权正文', create_time: '2' },
    { type: 'user_im_message_receive_group_all', event_id: 'event-self', message_id: 'outgoing-1', conversation_id: 'allowed-group', sender_open_dingtalk_id: 'employee-runtime-1', sender: '数字员工', content: '自回复正文', timestamp: '3' },
  ]
  process.stdout.write('{bad json}\\n')
  const first = JSON.stringify(events[0])
  process.stdout.write(first.slice(0, 20))
  setTimeout(() => {
    process.stdout.write(first.slice(20) + '\\n')
    process.stdout.write(JSON.stringify(events[1]) + '\\n')
    process.stdout.write(JSON.stringify(events[2]) + '\\n')
    setTimeout(() => process.stdout.write(JSON.stringify(events[3]) + '\\n'), 50)
  }, 10)
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
} else {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    const value = input ? JSON.parse(input) : {}
    process.stdout.write(JSON.stringify({ ok: true, outcome: 'success', data: { openMessageId: operation === 'reply' ? 'outgoing-1' : 'operator-message-1', conversationId: value.conversationId || 'operator-conversation', deliveryStatus: 'delivered', idempotencyKey: value.idempotencyKey }, meta: {} }))
  })
}
`
  return writeFakeDwsCommand(root, 'dws', source, pathCommand)
}

async function createRetryFakeDws(root) {
  const source = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('capabilities')) {
  process.stdout.write(JSON.stringify({ ok: true, outcome: 'success', data: { schemaVersion: 1, protocolVersion: 1, auditMode: 'local_required', capabilities: { eventConsume: true, replyStdin: true, operatorPrivateStdin: true } }, meta: {} }))
  process.exit(0)
}
if (args.includes('consume')) {
  const file = process.env.FAKE_DWS_ATTEMPT_FILE
  let count = 0
  try { count = Number(fs.readFileSync(file, 'utf8')) || 0 } catch {}
  count++
  fs.writeFileSync(file, String(count))
  const failCount = Number(process.env.FAKE_DWS_FAIL_COUNT)
  if (count <= failCount) {
    if (process.env.FAKE_DWS_RETRYABLE !== 'unknown') process.stderr.write('retryable=' + process.env.FAKE_DWS_RETRYABLE + '\\n')
    process.exit(1)
  }
  process.stderr.write('[event] ready event_count=0\\n')
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}
`
  return writeFakeDwsCommand(root, 'dws-retry', source)
}

async function createAuditFailFakeDws(root) {
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('capabilities')) {
  process.stdout.write(JSON.stringify({ ok: true, outcome: 'success', data: { schemaVersion: 1, protocolVersion: 1, auditMode: 'local_required', capabilities: { eventConsume: true, replyStdin: true, operatorPrivateStdin: true } }, meta: {} }))
  process.exit(0)
}

if (args.includes('consume')) {
  process.stderr.write('[event] ready event_count=0\\n')
  process.stdout.write(JSON.stringify({ type: 'user_im_message_receive_group_all', event_id: 'audit-blocked-event', message_id: 'audit-blocked-message', conversation_id: 'allowed-group', sender_open_dingtalk_id: 'allowed-open-id', sender: '成员', content: '不得进入 Agent 的正文', event_time: '1' }) + '\\n')
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}
`
  return writeFakeDwsCommand(root, 'dws-audit-fail', source)
}

async function createSlowExitFakeDws(root) {
  const source = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const file = process.env.FAKE_DWS_SUBSCRIPTION_STATE
const readState = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { attempts: 0, active: 0, maxActive: 0 } } }
const writeState = (state) => fs.writeFileSync(file, JSON.stringify(state))
if (args.includes('capabilities')) {
  process.stdout.write(JSON.stringify({ ok: true, outcome: 'success', data: { schemaVersion: 1, protocolVersion: 1, auditMode: 'local_required', capabilities: { eventConsume: true, replyStdin: true, operatorPrivateStdin: true } }, meta: {} }))
  process.exit(0)
}
if (args.includes('consume')) {
  const state = readState()
  state.attempts++
  state.active++
  state.maxActive = Math.max(state.maxActive, state.active)
  writeState(state)
  const finish = () => {
    const latest = readState()
    latest.active--
    writeState(latest)
    process.exit(0)
  }
  process.stdin.resume()
  if (state.attempts === 1) {
    const hold = setInterval(() => {}, 1000)
    process.stdin.on('end', () => {})
    process.on('SIGTERM', () => setTimeout(() => { clearInterval(hold); finish() }, 100))
  } else {
    process.stderr.write('[event] ready bus_pid=456\\n')
    process.stdin.on('end', finish)
    process.on('SIGTERM', finish)
  }
}
`
  return writeFakeDwsCommand(root, 'dws-slow-exit', source)
}

function createHost() {
  const handlers = new Map()
  const agents = new Map()
  const followups = []
  const sessions = []
  const emit = (name, ...args) => {
    for (const handler of handlers.get(name) ?? []) handler(...args)
  }
  const ctx = {
    credentials: { resolve: async () => undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'model' }) },
    agents: {
      get: (id) => agents.get(id),
      resume: async () => {
        throw new Error('restart test deliberately has no live agent')
      },
      create: async (options) => {
        const scoped = new Map()
        const agentCtx = {
          agent: undefined,
          tools: { register: () => () => {} },
          on(name, handler) {
            scoped.set(name, handler)
            return () => scoped.delete(name)
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
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已处理' }] } } },
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
        sessions.push({ sessionId: options.sessionId, scoped })
        return { agent, dispose: async () => {} }
      },
    },
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        resolveByPath: async () => ({ path: '/test-workspace', sessionIds: [], attachSession: async () => {} }),
        create: async (workspace) => ({ path: workspace, sessionIds: [], attachSession: async () => {} }),
      }
    },
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => list.splice(list.indexOf(handler), 1)
    },
  }
  return { ctx, followups, sessions, dispose: () => emit('dispose') }
}

function pluginConfig(workspace, digitalEmployees) {
  return {
    accounts: [],
    digitalEmployees,
    clientId: '',
    clientSecret: '',
    workspace,
    markdownTitle: 'DSH',
    interactionCardTemplateId: '',
    ownerStaffId: '',
    senderAccess: 'owner',
    allowedSenders: [],
    groupAccess: 'none',
    groupAllowlist: [],
    replyMode: { direct: 'text', group: 'text' },
    streaming: { enabled: false, throttleMs: 500, maxCardChars: 15_000 },
    asyncMode: false,
    ackText: '处理中',
    queueAckText: '排队中',
    questionTimeoutMs: 10_000,
    approvalTimeoutMs: 10_000,
    tools: { enabled: false },
    sessionScope: 'chat',
    imageMode: 'never',
    emotionFirstResponse: false,
    rejectNotice: false,
    debug: false,
  }
}

test('fake DWS 验证 ready、半行/坏包隔离、白名单、去重、自回复 ledger 和安全 stdin', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-runtime-'))
  const stateDir = path.join(root, 'state')
  const recordFile = path.join(root, 'invocations.ndjson')
  const dwsInvocation = await createFakeDws(root)
  const originalRecord = process.env.FAKE_DWS_RECORD
  const originalToken = process.env.DWS_ACCESS_TOKEN
  let runtime
  process.env.FAKE_DWS_RECORD = recordFile
  process.env.DWS_ACCESS_TOKEN = 'must-not-reach-child'
  t.after(async () => {
    await runtime?.stop()
    if (originalRecord === undefined) delete process.env.FAKE_DWS_RECORD
    else process.env.FAKE_DWS_RECORD = originalRecord
    if (originalToken === undefined) delete process.env.DWS_ACCESS_TOKEN
    else process.env.DWS_ACCESS_TOKEN = originalToken
    await rm(root, { recursive: true, force: true })
  })

  const accepted = []
  const logs = []
  runtime = new DwsDigitalEmployeeSource({
    employee,
    stateDir,
    ...dwsInvocation,
    readyTimeoutMs: 2_000,
    log: (line) => logs.push(line),
    onMessage: async (input) => {
      accepted.push(input)
      await runtime.replySink.reply(input.event, 'session-safe-id', '回复正文只能进入 stdin')
    },
  })
  await runtime.start()
  await waitFor(() => accepted.length === 1 && runtime.currentStatus().lastReplyAt)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(runtime.currentStatus().state, 'ready')
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].scopeKey, 'employee-runtime-1:allowed-group#allowed-open-id')
  assert.equal(accepted[0].message.text, '只应通过 stdin 回复的正文')
  assert.ok(logs.includes('event parse rejected (invalid_json)'))

  const records = (await readFile(recordFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const consumer = records.find((item) => item.operation === 'consume')
  assert.deepEqual(consumer.args, [
    '--profile',
    'corp-runtime:user-runtime',
    'event',
    'consume',
    'user_im_message_receive_o2o_all',
    'user_im_message_receive_group_all',
    '--flatten',
    '--format',
    'ndjson',
  ])
  assert.ok(records.every((item) => item.credentialEnvKeys.length === 0))
  assert.doesNotMatch(JSON.stringify(records), /回复正文|越权正文|自回复正文|must-not-reach-child/)
  assert.equal(records.filter((item) => item.operation === 'reply').length, 1)
  const reply = records.find((item) => item.operation === 'reply')
  assert.deepEqual(reply.args.slice(2), [
    'dingtalk-tag',
    'channel',
    'reply',
    '--channel',
    'dsh',
    '--stdin',
    '--format',
    'json',
  ])

  if (process.platform !== 'win32') {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(stateDir, 'ledger.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(stateDir, 'runtime.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(stateDir, 'audit'))).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(stateDir, 'audit', 'employee-runtime-1.jsonl'))).mode & 0o777, 0o600)
  }
  assert.doesNotMatch(await readFile(path.join(stateDir, 'ledger.json'), 'utf8'), /正文/)
  assert.doesNotMatch(await readFile(path.join(stateDir, 'audit', 'employee-runtime-1.jsonl'), 'utf8'), /正文/)

  await runtime.stop()
  assert.equal(runtime.currentStatus().state, 'stopped')
})

test('ledger 损坏时隔离目标员工并持久化 doctor 可见的 fail-closed 状态', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-corrupt-ledger-'))
  const stateDir = path.join(root, 'state')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, 'ledger.json'), '{not-json', 'utf8')

  assert.throws(
    () =>
      new DwsDigitalEmployeeSource({
        employee,
        stateDir,
        dwsCommand: '/must/not/run/dws',
        log() {},
        onMessage() {},
      }),
    /digital_employee_ledger_corrupt/,
  )
  const status = JSON.parse(await readFile(path.join(stateDir, 'runtime.json'), 'utf8'))
  assert.equal(status.state, 'failed')
  assert.equal(status.failureCode, 'ledger_corrupt')
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(stateDir, 'runtime.json'))).mode & 0o777, 0o600)
  }
})

test('启动失败严格执行 retryable=false/true/unknown 的 0/2/1 重试预算', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-retry-'))
  const dwsInvocation = await createRetryFakeDws(root)
  const originalAttempt = process.env.FAKE_DWS_ATTEMPT_FILE
  const originalFailCount = process.env.FAKE_DWS_FAIL_COUNT
  const originalRetryable = process.env.FAKE_DWS_RETRYABLE
  const runtimes = []
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
    for (const [key, value] of [
      ['FAKE_DWS_ATTEMPT_FILE', originalAttempt],
      ['FAKE_DWS_FAIL_COUNT', originalFailCount],
      ['FAKE_DWS_RETRYABLE', originalRetryable],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  for (const scenario of [
    { hint: 'true', failures: 2, expectedAttempts: 3, succeeds: true },
    { hint: 'unknown', failures: 1, expectedAttempts: 2, succeeds: true },
    { hint: 'false', failures: 1, expectedAttempts: 1, succeeds: false },
  ]) {
    const attemptFile = path.join(root, `attempt-${scenario.hint}`)
    process.env.FAKE_DWS_ATTEMPT_FILE = attemptFile
    process.env.FAKE_DWS_FAIL_COUNT = String(scenario.failures)
    process.env.FAKE_DWS_RETRYABLE = scenario.hint
    const runtime = new DwsDigitalEmployeeSource({
      employee: { ...employee, agentUuid: `employee-retry-${scenario.hint}` },
      stateDir: path.join(root, `state-${scenario.hint}`),
      ...dwsInvocation,
      readyTimeoutMs: 1_000,
      log: () => {},
      onMessage: () => {},
    })
    runtimes.push(runtime)
    if (scenario.succeeds) {
      await runtime.start()
      assert.equal(runtime.currentStatus().state, 'ready')
    } else {
      await assert.rejects(() => runtime.start(), /event_consumer_exited_before_ready/)
      assert.equal(runtime.currentStatus().state, 'failed')
    }
    assert.equal(Number(await readFile(attemptFile, 'utf8')), scenario.expectedAttempts)
    await runtime.stop()
  }
})

test('ready 超时会等待旧订阅进程退出后再重试，不并行创建等价订阅', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-no-overlap-'))
  const dwsInvocation = await createSlowExitFakeDws(root)
  const stateFile = path.join(root, 'subscription-state.json')
  const originalStateFile = process.env.FAKE_DWS_SUBSCRIPTION_STATE
  process.env.FAKE_DWS_SUBSCRIPTION_STATE = stateFile
  const runtime = new DwsDigitalEmployeeSource({
    employee: { ...employee, agentUuid: 'employee-no-overlap' },
    stateDir: path.join(root, 'state'),
    ...dwsInvocation,
    readyTimeoutMs: 300,
    log: () => {},
    onMessage: () => {},
  })
  t.after(async () => {
    await runtime.stop()
    if (originalStateFile === undefined) delete process.env.FAKE_DWS_SUBSCRIPTION_STATE
    else process.env.FAKE_DWS_SUBSCRIPTION_STATE = originalStateFile
    await rm(root, { recursive: true, force: true })
  })

  await runtime.start()
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(state, { attempts: 2, active: 1, maxActive: 1 })
})

test('本地审计不可写时 fail-closed，不创建新 Agent 任务', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-audit-fail-'))
  const dwsInvocation = await createAuditFailFakeDws(root)
  let runtime
  t.after(async () => {
    await runtime?.stop()
    await rm(root, { recursive: true, force: true })
  })
  const accepted = []
  const stateDir = path.join(root, 'state')
  runtime = new DwsDigitalEmployeeSource({
    employee: { ...employee, agentUuid: 'employee-audit-fail' },
    stateDir,
    ...dwsInvocation,
    readyTimeoutMs: 1_000,
    log: () => {},
    onMessage: (input) => accepted.push(input),
  })
  await writeFile(path.join(stateDir, 'audit'), '阻止创建审计目录', 'utf8')

  await assert.rejects(() => runtime.start())
  assert.equal(accepted.length, 0)
  assert.equal(runtime.currentStatus().failureCode, 'audit_unavailable')
})

test('白名单先于调度且不同会话不受长任务阻塞', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-control-'))
  let releaseTask
  const task = new Promise((resolve) => {
    releaseTask = resolve
  })
  const seen = []
  const audits = []
  const runtime = new DwsDigitalEmployeeSource({
    employee,
    stateDir: path.join(root, 'state'),
    log: () => {},
    onMessage: async (input) => {
      seen.push(input.event.eventId)
      if (input.event.eventId === 'control-event') releaseTask()
      else await task
    },
  })
  runtime.replySink.audit = async (fields) => audits.push(fields)
  t.after(async () => {
    releaseTask()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  const ordinary = {
    schemaVersion: 1,
    eventId: 'ordinary-event',
    messageId: 'ordinary-message',
    conversationId: 'allowed-group',
    conversationType: 'group',
    senderOpenDingTalkId: 'allowed-open-id',
    senderName: '成员',
    text: '触发等待审批的任务',
    createdAt: '1',
  }
  const control = {
    ...ordinary,
    eventId: 'control-event',
    messageId: 'control-message',
    conversationId: 'operator-conversation',
    conversationType: 'direct',
    senderOpenDingTalkId: 'operator-open-id',
    text: '确认 ABC123',
  }
  const denied = {
    ...ordinary,
    eventId: 'denied-event',
    messageId: 'denied-message',
    conversationId: 'blocked-group',
  }

  await runtime.handleEvent(ordinary)
  await runtime.handleEvent(denied)
  assert.ok(audits.some((item) => item.eventId === 'denied-event' && item.status === 'denied'))
  await runtime.handleEvent(control)
  await waitFor(() => seen.length === 2)
  assert.deepEqual(seen, ['ordinary-event', 'control-event'])
})

test(
  '无机器人时启动两个数字员工，复用 Bridge/Queue/Session 并在重启后抑制重复回复',
  { skip: process.platform === 'win32' ? 'Windows PATH 测试不能安全执行脚本型 fake DWS' : false },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-host-'))
    const binDir = path.join(root, 'bin')
    await writeFile(path.join(root, '.keep'), '')
    await mkdir(binDir, { recursive: true })
    const fake = await createFakeDws(binDir, true)
    assert.equal(fake.dwsCommand, path.join(binDir, 'dws'))
    const recordFile = path.join(root, 'host-invocations.ndjson')
    const stateDir = path.join(root, 'state')
    const originalPath = process.env.PATH
    const originalRecord = process.env.FAKE_DWS_RECORD
    const originalState = process.env.DSH_DINGTALK_STATE_DIR
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    process.env.FAKE_DWS_RECORD = recordFile
    process.env.DSH_DINGTALK_STATE_DIR = stateDir
    const hosts = []
    t.after(async () => {
      for (const host of hosts) host.dispose()
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalRecord === undefined) delete process.env.FAKE_DWS_RECORD
      else process.env.FAKE_DWS_RECORD = originalRecord
      if (originalState === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
      else process.env.DSH_DINGTALK_STATE_DIR = originalState
      await rm(root, { recursive: true, force: true })
    })

    const employees = [
      employee,
      { ...employee, agentUuid: 'employee-runtime-2', dwsProfile: 'corp-runtime:user-runtime-2' },
    ]
    const first = createHost()
    hosts.push(first)
    await apply(first.ctx, pluginConfig(path.join(root, 'workspace'), employees))
    await waitFor(async () => {
      try {
        const records = (await readFile(recordFile, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        return first.followups.length === 2 && records.filter((item) => item.operation === 'reply').length === 2
      } catch {
        return false
      }
    })
    assert.equal(new Set(first.followups.map((item) => item.sessionId)).size, 2)
    assert.ok(first.followups.every((item) => item.message.content[0].text === '只应通过 stdin 回复的正文'))

    first.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const beforeRestart = (await readFile(recordFile, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"operation":"reply"')).length
    const second = createHost()
    hosts.push(second)
    await apply(second.ctx, pluginConfig(path.join(root, 'workspace'), employees))
    await new Promise((resolve) => setTimeout(resolve, 150))
    const afterRestart = (await readFile(recordFile, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"operation":"reply"')).length
    assert.equal(second.followups.length, 0)
    assert.equal(afterRestart, beforeRestart)
  },
)
