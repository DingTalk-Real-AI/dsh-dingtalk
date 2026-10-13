import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LocalDigitalEmployeeAuditLog } from '../lib/digital-employee-audit.js'
import { DigitalEmployeeLedger } from '../lib/digital-employee-ledger.js'
import { DwsDigitalEmployeeReplySink } from '../lib/digital-employee-reply-sink.js'

const employee = {
  agentUuid: 'notice-employee',
  dwsProfile: 'fixture-corp:fixture-user',
  operatorOpenDingTalkId: 'DAAAAAAAAAAAiE',
  bindingRevision: 7,
  protocolVersion: 1,
}
const event = { eventId: 'notice-event', messageId: 'notice-message', conversationId: 'notice-conversation' }
const originalText = '原回复中的业务内容 ORIGINAL_BODY_PRIVATE'
const privateError = 'PRIVATE_STDERR_TEXT 不得转发的服务端自由文本'
const unknownError = {
  error: { code: 5, category: 'internal', reason: 'delivery_unknown', retryable: false, message: privateError },
}

async function fixture(t, configuration = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'failure-notice-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const trace = path.join(root, 'calls.jsonl')
  const failureMarker = path.join(root, 'failure-observed')
  const script = path.join(root, 'dws.cjs')
  const ledgerPath = path.join(root, 'ledger.json')
  await writeFile(
    script,
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const originalText = ${JSON.stringify(originalText)};
const config = ${JSON.stringify(configuration)};
const originalError = config.originalError ?? ${JSON.stringify(unknownError)};
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, body, failureObserved: fs.existsSync(${JSON.stringify(failureMarker)}) }) + '\\n');
  if (body === originalText) {
    const error = typeof originalError === 'string' ? originalError : JSON.stringify(originalError);
    process.stderr.write(error, () => process.exit(config.exitCode ?? 5));
    return;
  }
  if (config.noticeError) {
    process.stderr.write(JSON.stringify(config.noticeError), () => process.exit(5));
    return;
  }
  setTimeout(() => {
    console.log(JSON.stringify({
      openMessageId: 'notice-sent',
      conversationId: args[args.indexOf('--group') + 1],
      deliveryStatus: 'delivered',
      idempotencyKey: args[args.indexOf('--idempotency-key') + 1],
      ...config.noticeResult,
    }));
  }, config.noticeDelay ?? 0);
});
`,
  )
  const records = { failures: [], replies: [], audit: [], log: [] }
  function createClient(options = {}) {
    const ledger = options.ledger ?? new DigitalEmployeeLedger(ledgerPath)
    const client = new DwsDigitalEmployeeReplySink({
      employee,
      dwsCommand: process.execPath,
      dwsArgsPrefix: [script],
      ledger,
      auditSink: {
        async audit(fields) {
          records.audit.push(fields)
        },
      },
      onFailure(code) {
        records.failures.push(code)
        writeFileSync(failureMarker, code)
      },
      onReply() {
        records.replies.push('reply')
      },
      onAudit() {},
      log(line) {
        records.log.push(line)
      },
      ...options,
    })
    return { client, ledger }
  }
  async function calls() {
    try {
      return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  return { root, ledgerPath, records, createClient, calls }
}

test('回执未知后只向原消息发送一次可排查故障通知，原回复保持失败', async (t) => {
  const f = await fixture(t)
  const { client, ledger } = f.createClient()
  await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  const calls = await f.calls()
  assert.equal(calls.length, 2, '原正文调用一次，故障提示调用一次')
  assert.equal(calls[0].body, originalText)
  const notice = calls[1]
  assert.equal(notice.failureObserved, true, '先阻断正常处理，再执行独立故障通知')
  assert.ok(notice.args.includes('+messages-reply'))
  assert.equal(notice.args[notice.args.indexOf('--group') + 1], event.conversationId)
  assert.equal(notice.args[notice.args.indexOf('--message-id') + 1], event.messageId)
  assert.notEqual(
    notice.args[notice.args.indexOf('--idempotency-key') + 1],
    calls[0].args[calls[0].args.indexOf('--idempotency-key') + 1],
  )
  assert.match(notice.body, /DE-[a-f0-9]{16}/)
  assert.match(notice.body, /送达|回执|确认/)
  assert.doesNotMatch(notice.body, /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT/)
  assert.ok(!notice.args.some((arg) => /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT|DE-[a-f0-9]{16}/.test(arg)))
  assert.deepEqual(f.records.failures, ['reply_failed'])
  assert.deepEqual(f.records.replies, [])
  assert.equal(ledger.hasSentMessage('notice-sent'), true)
  const diagnosticId = notice.body.match(/DE-[a-f0-9]{16}/)[0]
  assert.ok(f.records.audit.some((entry) => entry.diagnosticId === diagnosticId && entry.failureCode))
  assert.ok(
    f.records.log.some((line) => line.includes(diagnosticId)),
    '本地日志与 IM 提示共用排查编号',
  )
  assert.doesNotMatch(JSON.stringify(f.records), /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT/)
})

test('故障通知自己的回执也未知时停止，不递归通知、不重发原文、不恢复运行态', async (t) => {
  const f = await fixture(t, { noticeError: unknownError })
  const { client, ledger } = f.createClient()
  await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  await client.drain()
  const calls = await f.calls()
  assert.equal(calls.length, 2)
  assert.equal(calls.filter((call) => call.body === originalText).length, 1)
  assert.deepEqual(f.records.failures, ['reply_failed'])
  assert.deepEqual(f.records.replies, [])
  assert.equal(ledger.hasSentMessage('notice-sent'), false)
  assert.ok(
    f.records.audit.some(
      (entry) =>
        entry.operationType === 'delivery_failure_notice' &&
        ['unknown', 'failed'].includes(entry.status) &&
        entry.diagnosticId,
    ),
  )
  assert.ok(f.records.log.length > 0)
  assert.doesNotMatch(JSON.stringify(f.records), /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT/)
})

test('同一事件重复失败及账本重载均不重复发送故障通知', async (t) => {
  const f = await fixture(t)
  const first = f.createClient()
  await assert.rejects(first.client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  await assert.rejects(first.client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  const second = f.createClient()
  assert.equal(second.ledger.hasSentMessage('notice-sent'), true)
  await assert.rejects(second.client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  const calls = await f.calls()
  assert.equal(calls.filter((call) => call.body !== originalText).length, 1)
  assert.equal(calls.filter((call) => call.body === originalText).length, 3)
  assert.deepEqual(f.records.replies, [])
})

test('故障通知失败后重载也不重复发送，防止未知送达造成重复提示', async (t) => {
  const f = await fixture(t, { noticeError: unknownError })
  await assert.rejects(f.createClient().client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  await assert.rejects(f.createClient().client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  const calls = await f.calls()
  assert.equal(calls.filter((call) => call.body !== originalText).length, 1)
})

test('同一事件的并发失败只竞争到一次故障通知', async (t) => {
  const f = await fixture(t, { noticeDelay: 20 })
  const { client } = f.createClient()
  await Promise.all([
    assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/),
    assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/),
  ])
  const calls = await f.calls()
  assert.equal(calls.filter((call) => call.body !== originalText).length, 1)
  assert.equal(calls.filter((call) => call.body === originalText).length, 2)
})

test('本地真实审计文件保留 IM 排查编号与失败类型', async (t) => {
  const f = await fixture(t)
  const stateDir = path.join(f.root, 'audit-state')
  const { client } = f.createClient({ auditSink: new LocalDigitalEmployeeAuditLog(stateDir, employee.agentUuid) })
  await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  const calls = await f.calls()
  const diagnosticId = calls[1].body.match(/DE-[a-f0-9]{16}/)[0]
  const raw = await readFile(path.join(stateDir, 'audit', `${employee.agentUuid}.jsonl`), 'utf8')
  const audit = raw.trim().split('\n').map(JSON.parse)
  assert.ok(audit.some((entry) => entry.diagnosticId === diagnosticId && entry.failureCode === 'delivery_unknown'))
  assert.ok(audit.some((entry) => entry.replyMessageId === 'notice-sent' && entry.diagnosticId === diagnosticId))
  assert.doesNotMatch(raw, /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT/)
})

for (const noticeResult of [
  { conversationId: 'wrong-conversation' },
  { idempotencyKey: 'wrong-key' },
  { openMessageId: '' },
]) {
  test(`故障通知回执不匹配时不能登记送达：${JSON.stringify(noticeResult)}`, async (t) => {
    const f = await fixture(t, { noticeResult })
    const { client, ledger } = f.createClient()
    await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
    assert.equal((await f.calls()).length, 2)
    assert.equal(ledger.hasSentMessage('notice-sent'), false)
    assert.deepEqual(f.records.replies, [])
    assert.deepEqual(f.records.failures, ['reply_failed'])
    assert.ok(
      f.records.audit.some((entry) => entry.operationType === 'delivery_failure_notice' && entry.status === 'failed'),
    )
  })
}

test('旧版账本缺少故障通知字段时可升级并持久化去重', async (t) => {
  const f = await fixture(t)
  await writeFile(f.ledgerPath, JSON.stringify({ seenEvents: { earlier: 1 }, sentMessageIds: { previous: 1 } }))
  const { client, ledger } = f.createClient()
  assert.equal(ledger.hasEvent('earlier'), true)
  assert.equal(ledger.hasSentMessage('previous'), true)
  await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  const loaded = new DigitalEmployeeLedger(f.ledgerPath)
  assert.equal(loaded.hasEvent('earlier'), true)
  assert.equal(loaded.hasSentMessage('previous'), true)
  assert.equal(loaded.hasSentMessage('notice-sent'), true)
})

for (const [name, originalError] of [
  ['自由文本包含 delivery_unknown', `Business error delivery_unknown ${privateError}`],
  ['JSON 后附自由文本', `${JSON.stringify(unknownError)}\n${privateError}`],
  ['其他结构化错误', { error: { ...unknownError.error, reason: 'binding_not_authorized' } }],
  ['错误类别不匹配', { error: { ...unknownError.error, category: 'validation' } }],
  ['错误退出码字段不匹配', { error: { ...unknownError.error, code: 1 } }],
  ['错误标记可重试', { error: { ...unknownError.error, retryable: true } }],
  ['缺少错误标记', { reason: 'delivery_unknown' }],
  ['超长 stderr', `${JSON.stringify(unknownError)}${'x'.repeat(256 * 1024)}`],
]) {
  test(`非预期错误不发送故障通知：${name}`, async (t) => {
    const f = await fixture(t, { originalError })
    const { client } = f.createClient()
    await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_/)
    const calls = await f.calls()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body, originalText)
    assert.deepEqual(f.records.failures, ['reply_failed'])
    assert.deepEqual(f.records.replies, [])
    assert.doesNotMatch(JSON.stringify(f.records), /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT/)
  })
}

test('进程退出码不匹配结构化错误时不发送故障通知', async (t) => {
  const f = await fixture(t, { exitCode: 1 })
  await assert.rejects(f.createClient().client.reply(event, 'notice-session', originalText), /dws_exit_1/)
  assert.equal((await f.calls()).length, 1)
})

test('审计无法落盘时只保留原失败，不发送缺少审计的故障提示', async (t) => {
  const f = await fixture(t)
  const { client } = f.createClient({
    auditSink: {
      async audit() {
        throw new Error(`audit unavailable ${privateError}`)
      },
    },
  })
  await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  assert.equal((await f.calls()).length, 1)
  assert.equal(f.records.failures[0], 'reply_failed')
  assert.deepEqual(f.records.replies, [])
  assert.ok(f.records.log.length > 0)
  assert.doesNotMatch(JSON.stringify(f.records), /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT/)
})

test('账本持久化失败时不发送故障提示，原错误保持不变', async (t) => {
  const f = await fixture(t)
  const { client } = f.createClient()
  // 使用真实文件系统故障：账本目标变成目录，原子 rename 必须失败。
  await mkdir(f.ledgerPath)
  await assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  assert.equal((await f.calls()).length, 1)
  assert.equal(f.records.failures[0], 'reply_failed')
  assert.deepEqual(f.records.replies, [])
  assert.ok(f.records.log.length > 0)
  assert.doesNotMatch(JSON.stringify(f.records), /ORIGINAL_BODY_PRIVATE|PRIVATE_STDERR_TEXT/)
})

test('drain 和会话等待包含异步审计以及故障通知，不在原发送结束时提前完成', async (t) => {
  const f = await fixture(t, { noticeDelay: 50 })
  let enterAudit
  const auditEntered = new Promise((resolve) => {
    enterAudit = resolve
  })
  let releaseAudit
  const auditReleased = new Promise((resolve) => {
    releaseAudit = resolve
  })
  const { client } = f.createClient({
    auditSink: {
      async audit(fields) {
        f.records.audit.push(fields)
        enterAudit()
        await auditReleased
      },
    },
  })
  const failedReply = assert.rejects(client.reply(event, 'notice-session', originalText), /dws_exit_5/)
  let drained = false
  const drain = client.drain().then(() => {
    drained = true
  })
  let conversationDone = false
  const conversation = client.waitForPendingReplies(event.conversationId).then(() => {
    conversationDone = true
  })
  const timeout = setTimeout(() => enterAudit('timeout'), 2_000)
  try {
    assert.notEqual(await auditEntered, 'timeout', '应进入通知前的审计')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(drained, false, 'drain 必须等待通知前置审计')
    assert.equal(conversationDone, false, '后续事件不能越过未完成的故障通知')
  } finally {
    clearTimeout(timeout)
    releaseAudit()
    await Promise.all([failedReply, drain, conversation])
  }
  assert.equal((await f.calls()).length, 2)
  assert.equal(drained, true)
  assert.equal(conversationDone, true)
})
