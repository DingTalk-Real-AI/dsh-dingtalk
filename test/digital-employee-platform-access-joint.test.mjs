import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DwsDigitalEmployeeSource } from '../lib/digital-employee-runtime.js'

const employee = {
  agentUuid: 'platform-joint-employee',
  dwsProfile: 'fixture-corp:fixture-employee',
  operatorOpenDingTalkId: 'fixture-operator',
  bindingRevision: 9,
  protocolVersion: 1,
  enabled: true,
  allowedDirectSenders: [],
  allowedGroups: ['fixture-allowed-group'],
  sessionScope: 'chat',
}

function inbound(id, type, sender = 'fixture-visitor', conversation = 'fixture-private') {
  return {
    event_id: id,
    message_id: `message-${id}`,
    conversation_id: conversation,
    type,
    sender_open_dingtalk_id: sender,
    sender: '夹具访客',
    content: `夹具消息 ${id}`,
    create_time: '1',
  }
}

async function fixture(t, bindingFields, events) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'platform-access-joint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'config')
  await mkdir(path.join(config, 'digital-employees'), { recursive: true })
  const bindingPath = path.join(
    config,
    'digital-employees',
    `${createHash('sha256').update(employee.dwsProfile).digest('hex')}.json`,
  )
  // 不创建主管 Profile 或任何登录凭据；真实 DWS 的启动判定必须只读取本地绑定。
  const original = JSON.stringify({
    schemaVersion: 1,
    agentUuid: employee.agentUuid,
    dwsProfile: employee.dwsProfile,
    operatorOpenDingTalkId: employee.operatorOpenDingTalkId,
    bindingRevision: employee.bindingRevision,
    channel: 'dsh',
    bindingState: 'bound',
    desiredState: 'running',
    ...bindingFields,
  })
  await writeFile(bindingPath, original)
  const runtimeDir = path.join(
    config,
    'digital-employees',
    `employee-${createHash('sha256').update(employee.dwsProfile).digest('hex')}`,
  )
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(
    path.join(runtimeDir, 'adapter.json'),
    JSON.stringify({ binding: JSON.parse(original), selfOpenDingTalkId: 'fixture-self' }),
  )
  const env = {
    HOME: root,
    USERPROFILE: root,
    DWS_CONFIG_DIR: config,
    DWS_KEYCHAIN_DIR: path.join(root, 'keychain'),
    DWS_DISABLE_KEYCHAIN: '1',
    DWS_NO_UPDATE_CHECK: '1',
    DINGTALK_DEAP_DEV_MCP_URL: 'http://127.0.0.1:1',
    DINGTALK_CONTACT_MCP_URL: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '',
  }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
  const callsPath = path.join(root, 'calls.jsonl')
  const emittedPath = path.join(root, 'emitted')
  const bridge = path.join(root, 'bridge.cjs')
  // 仅事件传输使用夹具；capabilities/binding 全部交给实际构建的 DWS。
  await writeFile(
    bridge,
    `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args.includes('consume')) {
  process.stderr.write('[event] ready\\n');
  setTimeout(() => {
    for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n');
    fs.writeFileSync(${JSON.stringify(emittedPath)}, 'emitted');
  }, 25);
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else {
  const child = spawn(${JSON.stringify(process.env.DWS_JOINT_BINARY)}, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', () => process.exit(99));
  child.on('close', code => { process.exitCode = code ?? 98; });
}
`,
  )
  const received = []
  const runtime = new DwsDigitalEmployeeSource({
    employee,
    stateDir: path.join(root, 'state'),
    dwsCommand: process.execPath,
    dwsArgsPrefix: [bridge],
    log() {},
    onMessage(input) {
      received.push(input.event.eventId)
    },
  })
  t.after(() => runtime.stop())
  return {
    runtime,
    received,
    async finish(expectedMessages, expectedChecks) {
      const deadline = Date.now() + 5_000
      let accessChecks = []
      while (Date.now() < deadline) {
        const audit = await readFile(path.join(root, 'state', 'audit', `${employee.agentUuid}.jsonl`), 'utf8').catch(
          () => '',
        )
        accessChecks = audit
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse)
          .filter((entry) => entry.operationType === 'access_check')
        if (received.length === expectedMessages && accessChecks.length === expectedChecks) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(await readFile(emittedPath, 'utf8'), 'emitted')
      assert.equal(received.length, expectedMessages)
      assert.equal(accessChecks.length, expectedChecks)
      assert.equal(runtime.currentStatus().state, 'ready')
      // 通过公开 stop 排空事件链，确保最终断言覆盖全部已送入的事件。
      await runtime.stop()
      assert.equal(await readFile(bindingPath, 'utf8'), original, '不得迁移或改写旧绑定')
      const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(calls.filter((args) => args.includes('capabilities')).length, 1)
      assert.equal(calls.filter((args) => args.includes('binding')).length, 1, '多条入站不得逐条查询绑定或可见范围')
      assert.equal(calls.length, 3, '只能探测能力、读取一次绑定和启动事件消费')
      return calls.find((args) => args.includes('consume'))
    },
  }
}

test(
  '真实 DWS + 插件：旧受管绑定无需主管凭据，连续私聊和群 @ 零远端授权查询',
  { skip: !process.env.DWS_JOINT_BINARY },
  async (t) => {
    const first = inbound('private-a', 'user_im_message_receive_o2o_all')
    const second = inbound('private-b', 'user_im_message_receive_o2o_all')
    const f = await fixture(t, { runtimeBindingId: 'fixture-server-binding', deviceId: 'fixture-device' }, [
      first,
      first,
      second,
      inbound('self-untracked', 'user_im_message_receive_o2o_all', 'fixture-self'),
      inbound('group-at', 'user_im_message_receive_at', 'fixture-visitor', 'fixture-new-group'),
      inbound('group-plain', 'user_im_message_receive_group_all', 'fixture-visitor', 'fixture-new-group'),
    ])
    await f.runtime.prepare()
    await f.runtime.start()
    const topics = await f.finish(3, 3)
    assert.deepEqual(f.received, ['private-a', 'private-b', 'group-at'])
    assert.ok(topics.includes('user_im_message_receive_at'))
    assert.ok(!topics.includes('user_im_message_receive_group_all'))
  },
)

test(
  '真实 DWS + 插件：只有历史主管字段的非受管绑定仍使用本地白名单',
  { skip: !process.env.DWS_JOINT_BINARY },
  async (t) => {
    const f = await fixture(t, { supervisorProfile: 'missing-corp:missing-manager' }, [
      inbound('visitor-denied', 'user_im_message_receive_o2o_all'),
      inbound('operator-allowed', 'user_im_message_receive_o2o_all', employee.operatorOpenDingTalkId),
      inbound('group-allowed', 'user_im_message_receive_group_all', 'fixture-visitor', 'fixture-allowed-group'),
      inbound('group-denied', 'user_im_message_receive_at', 'fixture-visitor', 'fixture-new-group'),
    ])
    await f.runtime.start()
    const topics = await f.finish(2, 4)
    assert.deepEqual(f.received, ['operator-allowed', 'group-allowed'])
    assert.ok(topics.includes('user_im_message_receive_group_all'))
  },
)
