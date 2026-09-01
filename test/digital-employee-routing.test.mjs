import assert from 'node:assert/strict'
import test from 'node:test'

import { routeDigitalEmployeePreTask } from '../lib/digital-employee-routing.js'

function input(text) {
  return {
    event: {},
    message: { msgId: 'message-1', text },
    scopeKey: 'employee:conversation',
  }
}

test('/new 和 /stop 在等待问题时仍优先走会话控制', async () => {
  const calls = []
  const commands = {
    async handle(message) {
      calls.push(`command:${message.text}`)
      return true
    },
  }
  const interactive = {
    async handleInbound(value) {
      calls.push(`interactive:${value.message.text}`)
      return true
    },
  }

  assert.equal(await routeDigitalEmployeePreTask(input('/new'), commands, interactive), true)
  assert.deepEqual(calls, ['command:/new'])
})

test('非会话控制消息先交给待回答问题，再交给普通命令', async () => {
  const calls = []
  const commands = {
    async handle(message) {
      calls.push(`command:${message.text}`)
      return false
    },
  }
  const interactive = {
    async handleInbound(value) {
      calls.push(`interactive:${value.message.text}`)
      return true
    },
  }

  assert.equal(await routeDigitalEmployeePreTask(input('1'), commands, interactive), true)
  assert.deepEqual(calls, ['interactive:1'])
})
