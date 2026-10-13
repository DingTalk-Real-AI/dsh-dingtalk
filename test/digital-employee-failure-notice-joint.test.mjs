import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LocalDigitalEmployeeAuditLog } from '../lib/digital-employee-audit.js'
import { DigitalEmployeeLedger } from '../lib/digital-employee-ledger.js'
import { DwsDigitalEmployeeReplySink } from '../lib/digital-employee-reply-sink.js'

const employee = {
  agentUuid: 'joint-notice-employee',
  dwsProfile: 'fixture-corp:fixture-user',
  operatorOpenDingTalkId: 'DAAAAAAAAAAAiE',
  bindingRevision: 7,
  protocolVersion: 1,
}
const event = {
  eventId: 'joint-notice-event',
  messageId: 'joint-notice-source',
  conversationId: 'joint-notice-conversation',
}
const originalText = '联合夹具业务正文 ORIGINAL_BODY_PRIVATE'
const rawErrorText = 'Business error PRIVATE_SERVER_DETAIL'
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))

async function fixture(t, scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notice-joint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'config')
  const state = path.join(root, 'state')
  await mkdir(path.join(config, 'digital-employees'), { recursive: true })
  await writeFile(
    path.join(config, 'digital-employees', `${createHash('sha256').update(employee.dwsProfile).digest('hex')}.json`),
    JSON.stringify({
      schemaVersion: 1,
      agentUuid: employee.agentUuid,
      dwsProfile: employee.dwsProfile,
      operatorOpenDingTalkId: employee.operatorOpenDingTalkId,
      bindingRevision: employee.bindingRevision,
      channel: 'dsh',
      bindingState: 'bound',
      desiredState: 'running',
    }),
  )
  await writeFile(
    path.join(config, 'profiles.json'),
    JSON.stringify({
      version: 2,
      currentProfile: employee.dwsProfile,
      profiles: [{ corpId: 'fixture-corp', userId: 'fixture-user' }],
    }),
  )
  const calls = []
  const failures = []
  const logs = []
  let replies = 0
  let runtimeState = 'ready'
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rpc = JSON.parse(Buffer.concat(chunks).toString())
    const name = rpc.params?.name
    let value
    if (name) calls.push({ name, args: rpc.params.arguments, at: performance.now(), runtimeState })
    if (name === 'list_messages_by_ids') {
      value = {
        result: [
          {
            openMessageId: event.messageId,
            openConversationId: event.conversationId,
            senderOpenDingTalkId: employee.operatorOpenDingTalkId,
          },
        ],
      }
    } else if (name === 'send_personal_message') {
      const index = calls.filter((call) => call.name === name).length
      value = { openTaskId: index === 1 ? 'original-task' : 'notice-task' }
    } else if (name === 'query_message_send_status') {
      const taskId = rpc.params.arguments.openTaskId
      const queries = calls.filter((call) => call.name === name && call.args.openTaskId === taskId)
      const pending =
        (taskId === 'original-task' && (scenario !== 'recovered' || queries.length === 1)) ||
        (taskId === 'notice-task' && scenario === 'notice-unknown')
      if (pending) {
        // 延迟发生在真实 HTTP 请求内，验证请求耗时也包含在原来的 2 秒预算中。
        if (scenario !== 'recovered') await sleep(350)
        value = { success: false, errorCode: '1001', errorMsg: rawErrorText }
      } else {
        value = {
          openMessageId: taskId === 'original-task' ? 'original-delivered' : 'notice-delivered',
          openConversationId: event.conversationId,
          sendStatus: 'SUCCESS',
        }
      }
    } else if (rpc.method === 'initialize') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } },
        }),
      )
      return
    } else if (!rpc.id) {
      res.writeHead(202)
      res.end()
      return
    } else value = { success: false, errorCode: 'UNEXPECTED', errorMsg: 'unexpected fixture request' }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  // 真实 DWS 仅使用夹具账号和本机 MCP；代理阻断任何非本机请求。
  const env = {
    HOME: root,
    USERPROFILE: root,
    DWS_CONFIG_DIR: config,
    DWS_KEYCHAIN_DIR: path.join(root, 'keychain'),
    DWS_DISABLE_KEYCHAIN: '1',
    DWS_ALLOW_HTTP_ENDPOINTS: '1',
    DWS_TRUSTED_DOMAINS: '127.0.0.1,localhost,::1',
    DWS_NO_UPDATE_CHECK: '1',
    DINGTALK_CHAT_MCP_URL: base,
    DINGTALK_IM_MCP_URL: base,
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1',
  }
  for (const [key, value] of Object.entries(env)) {
    const before = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    })
  }
  const ledger = new DigitalEmployeeLedger(path.join(state, 'ledger.json'))
  const client = new DwsDigitalEmployeeReplySink({
    employee,
    ledger,
    auditSink: new LocalDigitalEmployeeAuditLog(state, employee.agentUuid),
    dwsCommand: process.env.DWS_JOINT_BINARY,
    dwsArgsPrefix: ['--token', 'joint-fixture-only'],
    onFailure(code) {
      failures.push(code)
      runtimeState = 'failed'
    },
    onReply() {
      replies++
    },
    onAudit() {},
    log(line) {
      logs.push(line)
    },
  })
  return {
    client,
    calls,
    failures,
    logs,
    ledger,
    replies: () => replies,
    runtimeState: () => runtimeState,
    audit: async () =>
      (await readFile(path.join(state, 'audit', `${employee.agentUuid}.jsonl`), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse),
  }
}

// 不发送真实钉钉消息：这组测试跨越真实 DWS 二进制、回执重试和插件故障通知。
for (const scenario of ['notice-delivered', 'notice-unknown', 'recovered']) {
  test(
    `真实 DWS 回执 1001 与独立故障通知：${scenario}`,
    { skip: !process.env.DWS_JOINT_BINARY, timeout: 30_000 },
    async (t) => {
      const f = await fixture(t, scenario)
      const action = f.client.reply(event, 'joint-notice-session', originalText)
      if (scenario === 'recovered') await action
      else await assert.rejects(action, /dws_exit_5/)
      await f.client.drain()
      const sends = f.calls.filter((call) => call.name === 'send_personal_message')
      const queries = f.calls.filter((call) => call.name === 'query_message_send_status')
      const originalQueries = queries.filter((call) => call.args.openTaskId === 'original-task')
      const audit = await f.audit()
      assert.equal(sends.length, scenario === 'recovered' ? 1 : 2)
      assert.equal(JSON.parse(sends[0].args.content).content, originalText)
      for (const call of sends) {
        assert.equal(call.args.openConversationId, event.conversationId)
        assert.equal(JSON.parse(call.args.content).referenceOpenMessageId, event.messageId)
      }
      if (scenario === 'recovered') {
        assert.equal(originalQueries.length, 2)
        assert.deepEqual(f.failures, [])
        assert.equal(f.replies(), 1)
        assert.equal(f.runtimeState(), 'ready')
        assert.equal(f.ledger.hasSentMessage('original-delivered'), true)
        assert.ok(audit.every((entry) => !entry.diagnosticId))
      } else {
        assert.deepEqual(f.failures, ['reply_failed'])
        assert.equal(f.replies(), 0, '故障提示送达不能算原任务回复成功')
        assert.equal(f.runtimeState(), 'failed')
        assert.equal(sends[1].runtimeState, 'failed', '进入 fail-closed 后才尝试独立通知')
        assert.notEqual(sends[0].args.uuid, sends[1].args.uuid)
        const notice = JSON.parse(sends[1].args.content).content
        const diagnosticId = notice.match(/DE-[a-f0-9]{16}/)?.[0]
        assert.ok(diagnosticId)
        assert.doesNotMatch(notice, /ORIGINAL_BODY_PRIVATE|PRIVATE_SERVER_DETAIL/)
        assert.ok(audit.some((entry) => entry.diagnosticId === diagnosticId && entry.failureCode))
        const noticeAudit = audit.filter((entry) => entry.operationType === 'delivery_failure_notice')
        assert.deepEqual(
          noticeAudit.map((entry) => entry.status),
          ['claimed', scenario === 'notice-delivered' ? 'delivered' : 'unknown'],
        )
        assert.ok(noticeAudit.every((entry) => entry.diagnosticId === diagnosticId && entry.eventId === event.eventId))
        assert.ok(f.logs.some((line) => line.includes(diagnosticId)))
        assert.doesNotMatch(JSON.stringify({ audit, logs: f.logs }), /ORIGINAL_BODY_PRIVATE|PRIVATE_SERVER_DETAIL/)
        assert.equal(f.ledger.hasSentMessage('notice-delivered'), scenario === 'notice-delivered')
        const exhaustedTasks = scenario === 'notice-unknown' ? ['original-task', 'notice-task'] : ['original-task']
        for (const taskId of exhaustedTasks) {
          const taskQueries = queries.filter((call) => call.args.openTaskId === taskId)
          assert.ok(taskQueries.length > 1 && taskQueries.length <= 8)
          assert.ok(
            taskQueries.every((call) => call.at - taskQueries[0].at < 2000),
            '2 秒外不启动新查询',
          )
        }
        assert.ok(sends[1].at - originalQueries[0].at >= 1900, '原回执重试预算用尽后才发通知')
        if (scenario === 'notice-delivered') {
          assert.equal(queries.filter((call) => call.args.openTaskId === 'notice-task').length, 1)
        }
      }
      t.diagnostic(JSON.stringify({ scenario, sends: sends.length, queries: queries.length, failures: f.failures }))
    },
  )
}
