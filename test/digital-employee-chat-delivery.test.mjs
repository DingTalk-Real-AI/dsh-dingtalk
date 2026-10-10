import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DwsDigitalEmployeeReplySink } from '../lib/digital-employee-reply-sink.js'

const employee = {
  agentUuid: 'fixture-employee',
  dwsProfile: 'fixture-corp:fixture-user',
  operatorOpenDingTalkId: 'DAAAAAAAAAAAiE',
  bindingRevision: 7,
  protocolVersion: 1,
}
const event = { eventId: 'fixture-event', messageId: 'fixture-message', conversationId: 'fixture-conversation' }

function sink(options = {}) {
  return new DwsDigitalEmployeeReplySink({
    employee,
    ledger: { markSentMessage() {} },
    auditSink: { async audit() {} },
    onFailure() {},
    onReply() {},
    onAudit() {},
    ...options,
  })
}

test('仅声明 chatDelivery 即可接入，正文仅经 stdin 且失败不切换重发', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'employee-chat-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const trace = path.join(root, 'calls.jsonl')
  const script = path.join(root, 'dws.cjs')
  await writeFile(
    script,
    `
const fs = require('node:fs'); const args = process.argv.slice(2);
let body = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => body += c);
process.stdin.on('end', () => {
 fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, body}) + '\\n');
 if (args.includes('capabilities')) { console.log(JSON.stringify({ok:true,outcome:'success',data:{schemaVersion:1,protocolVersion:1,auditMode:'local_required',capabilities:{eventConsume:true,chatDelivery:true}}})); return; }
 if (body.includes('FAIL_ONCE')) { process.exitCode=1; return; }
 const value = {conversationId:args.includes('+messages-reply') ? args[args.indexOf('--group')+1] : 'operator-chat',idempotencyKey:args[args.indexOf('--idempotency-key')+1]};
 const receipt = {openMessageId:'sent',conversationId:value.conversationId || 'operator-chat',deliveryStatus:'delivered',idempotencyKey:value.idempotencyKey};
 console.log(JSON.stringify(receipt));
});
`,
  )
  const client = sink({ dwsCommand: process.execPath, dwsArgsPrefix: [script] })
  await client.probe()
  await client.reply(event, 'session', '回复正文只允许 stdin')
  await client.operatorPrivate('审批正文只允许 stdin', 'approval')
  await assert.rejects(client.reply(event, 'session', 'FAIL_ONCE'), /dws_exit/)
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 4, '失败后不得回退旧协议重发')
  for (const call of calls.slice(1)) assert.ok(!call.args.some((a) => /正文|FAIL_ONCE/.test(a)))
  assert.ok(calls[1].args.includes('+messages-reply'))
  assert.ok(calls[2].args.includes('+messages-send'))
  assert.ok(calls[1].args.includes('--yes'))
  assert.equal(calls[1].body, '回复正文只允许 stdin')
  const metadata = JSON.parse(calls[1].args[calls[1].args.indexOf('--employee-context') + 1])
  assert.deepEqual(metadata, { agentUuid: employee.agentUuid, channel: 'dsh', bindingRevision: 7 })
  assert.equal(calls[2].args[calls[2].args.indexOf('--open-dingtalk-id') + 1], employee.operatorOpenDingTalkId)
})

for (const chatDelivery of [undefined, false]) {
  test(`缺少 chatDelivery=true 拒绝启动并提示升级 (${chatDelivery})`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'employee-old-dws-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const trace = path.join(root, 'calls.jsonl')
    const script = path.join(root, 'dws.cjs')
    await writeFile(
      script,
      `
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({ok:true,outcome:'success',data:{schemaVersion:1,protocolVersion:1,auditMode:'local_required',capabilities:${JSON.stringify({ eventConsume: true, replyStdin: true, operatorPrivateStdin: true, ...(chatDelivery === undefined ? {} : { chatDelivery }) })}}}));
`,
    )
    const failures = []
    let audits = 0
    const client = sink({
      dwsCommand: process.execPath,
      dwsArgsPrefix: [script],
      onFailure: (code) => failures.push(code),
      auditSink: {
        async audit() {
          audits++
        },
      },
    })
    await assert.rejects(client.probe(), /请升级 DWS.*chatDelivery=true/)
    assert.deepEqual(failures, ['incompatible_dws_capabilities'])
    assert.equal(audits, 0)
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].includes('capabilities'), '旧 DWS 不得进入发送或回退路径')
  })
}

// 使用真实构建的 DWS 和受控 HTTP MCP；不访问真实钉钉账号或发送业务消息。
test('本地联合验收：DSH → 实际 DWS → 受控 MCP', { skip: !process.env.DWS_JOINT_BINARY }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dws-joint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'config')
  await mkdir(path.join(config, 'digital-employees'), { recursive: true })
  const profile = employee.dwsProfile
  const bindingPath = path.join(
    config,
    'digital-employees',
    `${createHash('sha256').update(profile).digest('hex')}.json`,
  )
  const binding = {
    schemaVersion: 1,
    agentUuid: employee.agentUuid,
    dwsProfile: profile,
    operatorOpenDingTalkId: employee.operatorOpenDingTalkId,
    channel: 'dsh',
    bindingRevision: 7,
    bindingState: 'bound',
    desiredState: 'running',
  }
  const saveBinding = (extra = {}) => writeFile(bindingPath, JSON.stringify({ ...binding, ...extra }))
  await saveBinding()
  await writeFile(
    path.join(config, 'profiles.json'),
    JSON.stringify({
      version: 2,
      currentProfile: profile,
      profiles: [{ corpId: 'fixture-corp', userId: 'fixture-user' }],
    }),
  )
  let scenario = 'success'
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rpc = JSON.parse(Buffer.concat(chunks).toString())
    const name = rpc.params?.name
    let value
    if (name) calls.push({ name, args: rpc.params.arguments })
    if (name === 'list_messages_by_ids') {
      if (scenario === 'change-binding') await saveBinding({ bindingRevision: 8 })
      value = {
        result: [
          {
            openMessageId: event.messageId,
            openConversationId: scenario === 'wrong-conversation' ? 'other' : event.conversationId,
            senderOpenDingTalkId: employee.operatorOpenDingTalkId,
          },
        ],
      }
    } else if (name === 'send_personal_message') {
      value = { openTaskId: 'fixture-send-task' }
    } else if (name === 'query_message_send_status') {
      value = {
        openMessageId: 'fixture-sent',
        openConversationId: event.conversationId,
        sendStatus: scenario === 'unknown' ? 'PENDING' : 'SUCCESS',
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
  const client = sink({ dwsCommand: process.env.DWS_JOINT_BINARY, dwsArgsPrefix: ['--token', 'joint-fixture-only'] })
  await client.probe()
  for (const mode of [
    'reply',
    'operator',
    'unknown',
    'stale',
    'stopped',
    'wrong-operator',
    'change-binding',
    'wrong-conversation',
  ]) {
    await t.test(mode, async () => {
      scenario = mode
      calls.length = 0
      await saveBinding()
      if (mode === 'stale') await saveBinding({ bindingRevision: 8 })
      if (mode === 'stopped') await saveBinding({ desiredState: 'stopped' })
      if (mode === 'wrong-operator') await saveBinding({ operatorOpenDingTalkId: 'other-operator' })
      const action = () =>
        mode === 'operator' || mode === 'wrong-operator'
          ? client.operatorPrivate('请求主管确认', mode)
          : client.reply(event, 'session', '联合验收回复', mode)
      if (['stale', 'stopped', 'wrong-operator', 'change-binding', 'wrong-conversation'].includes(mode)) {
        await assert.rejects(action())
        assert.equal(calls.filter((c) => c.name === 'send_personal_message').length, 0)
      } else {
        const result = await action()
        assert.equal(result.deliveryStatus, mode === 'unknown' ? 'unknown' : 'delivered')
        assert.equal(result.openMessageId, 'fixture-sent')
        assert.equal(calls.filter((c) => c.name === 'send_personal_message').length, 1)
        assert.equal(calls.filter((c) => c.name === 'query_message_send_status').length, 1)
        const sent = calls.find((c) => c.name === 'send_personal_message').args
        if (mode === 'operator') assert.equal(sent.receiverOpenDingTalkId, employee.operatorOpenDingTalkId)
        else assert.equal(JSON.parse(sent.content).referenceOpenMessageId, event.messageId)
      }
    })
  }
})

for (const policy of ['deap_visibility', 'local_allowlist', 'invalid']) {
  test(`绑定访问判定 ${policy}，严校验响应身份且不退回本地放行`, async () => {
    const client = sink()
    client.useVisibilityAccess = true
    let returned = {
      agentUuid: employee.agentUuid,
      dwsProfile: employee.dwsProfile,
      channel: 'dsh',
      bindingRevision: 7,
      bindingState: 'bound',
      desiredState: 'running',
      accessPolicy: policy,
      allowed: false,
    }
    client.execJson = async (args, input) => {
      assert.ok(args.includes('binding'))
      assert.equal(input.senderOpenDingTalkId, 'open-sender')
      return returned
    }
    const inbound = { ...event, senderOpenDingTalkId: 'open-sender', senderName: 'name' }
    if (policy === 'invalid') await assert.rejects(client.visibilityAccess(inbound), /invalid_visibility_access/)
    else assert.equal(await client.visibilityAccess(inbound), policy === 'local_allowlist' ? undefined : false)
    returned = { ...returned, agentUuid: 'wrong' }
    await assert.rejects(client.visibilityAccess(inbound), /binding_not_authorized/)
  })
}
