import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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
    setTimeout(() => process.stdout.write(JSON.stringify({type:'user_card_action_triggered',payload:{body:{}}})+'\\n'), 40)
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
