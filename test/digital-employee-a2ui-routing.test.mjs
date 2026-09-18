import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DwsDigitalEmployeeSource } from '../lib/digital-employee-runtime.js'

test('显式卡片订阅直接走控制回调，不进入普通消息/模型队列', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a2ui-route-'))
  const fixture = path.join(root, 'consumer.cjs')
  await writeFile(
    fixture,
    `
    require('node:assert/strict').ok(process.argv.includes('user_card_action_triggered'))
    process.stderr.write('[event] ready\\n')
    setTimeout(() => {
      const bytes = Buffer.from(JSON.stringify({type:'user_card_action_triggered',payload:{body:{note:'验收备注'}}})+'\\n')
      const split = bytes.indexOf(Buffer.from('验')) + 1
      process.stdout.write(bytes.subarray(0, split))
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 20)
    }, 40)
    process.stdin.resume()
  `,
  )
  let cards = 0,
    messages = 0
  const source = new DwsDigitalEmployeeSource({
    employee: {
      agentUuid: 'test',
      dwsProfile: 'corp:employee',
      operatorOpenDingTalkId: 'operator',
      enabled: true,
      allowedDirectSenders: [],
      allowedGroups: [],
      sessionScope: 'chat',
      protocolVersion: 1,
    },
    stateDir: path.join(root, 'state'),
    dwsCommand: process.execPath,
    dwsArgsPrefix: [fixture],
    log() {},
    onMessage() {
      messages++
    },
    onCardAction(event) {
      assert.equal(event.type, 'user_card_action_triggered')
      assert.equal(event.payload.body.note, '验收备注')
      cards++
    },
  })
  source.replySink.probe = async () => {}
  try {
    await source.start()
    for (let i = 0; i < 100 && !cards; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(cards, 1)
    assert.equal(messages, 0)
  } finally {
    await source.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('卡片订阅启动被拒绝后退出旧进程，降级仅消息订阅；不接收旧卡片回调', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a2ui-subscription-fallback-'))
  const fixture = path.join(root, 'consumer.cjs')
  const record = path.join(root, 'calls.jsonl')
  await writeFile(
    fixture,
    `
    const fs = require('node:fs')
    const args = process.argv.slice(2)
    fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + '\\n')
    if (args.includes('user_card_action_triggered')) {
      process.stderr.write('unsupported event retryable=false\\n')
      process.exit(1)
    }
    process.stderr.write('[event] ready\\n')
    setTimeout(() => process.stdout.write(JSON.stringify({type:'user_card_action_triggered',payload:{body:{}}})+'\\n'), 10)
    process.stdin.resume()
  `,
  )
  let fallback = 0,
    callbacks = 0
  const source = new DwsDigitalEmployeeSource({
    employee: {
      agentUuid: 'test',
      dwsProfile: 'corp:employee',
      operatorOpenDingTalkId: 'operator',
      allowedDirectSenders: [],
      allowedGroups: [],
    },
    stateDir: path.join(root, 'state'),
    dwsCommand: process.execPath,
    dwsArgsPrefix: [fixture],
    log() {},
    onMessage() {},
    onCardAction() {
      callbacks++
    },
    onCardUnavailable() {
      fallback++
    },
  })
  source.replySink.probe = async () => {}
  t.after(async () => {
    await source.stop()
    await rm(root, { recursive: true, force: true })
  })
  await source.start()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const calls = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].includes('user_card_action_triggered'))
  assert.ok(!calls[1].includes('user_card_action_triggered'))
  assert.equal(fallback, 1)
  assert.equal(callbacks, 0)
  assert.equal(source.currentStatus().state, 'ready')
  assert.deepEqual(source.currentStatus().subscriptionTopics, [
    'user_im_message_receive_o2o_all',
    'user_im_message_receive_group_all',
  ])
})

test('订阅曾就绪后断线不能自动切换到文字授权通道', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a2ui-subscription-disconnect-'))
  const fixture = path.join(root, 'consumer.cjs')
  await writeFile(
    fixture,
    `
    process.stderr.write('[event] ready\\n')
    setTimeout(() => { process.stderr.write('retryable=false\\n'); process.exit(1) }, 50)
  `,
  )
  let fallback = 0
  const source = new DwsDigitalEmployeeSource({
    employee: { agentUuid: 'test', dwsProfile: 'corp:employee' },
    stateDir: path.join(root, 'state'),
    dwsCommand: process.execPath,
    dwsArgsPrefix: [fixture],
    log() {},
    onMessage() {},
    onCardAction() {},
    onCardUnavailable() {
      fallback++
    },
  })
  source.replySink.probe = async () => {}
  t.after(async () => {
    await source.stop()
    await rm(root, { recursive: true, force: true })
  })
  await source.start()
  for (let i = 0; i < 100 && source.currentStatus().state !== 'failed'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(source.currentStatus().state, 'failed')
  assert.equal(fallback, 0)
})
