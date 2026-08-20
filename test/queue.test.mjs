import assert from 'node:assert/strict'
import test from 'node:test'

import { Queue } from '../lib/queue.js'

test('clear 丢弃尚未开始的旧消息，运行中的任务自行取消后释放 lane', async () => {
  const queue = new Queue(() => {})
  let release
  let secondRan = false
  const firstStarted = new Promise((resolve) => {
    queue.run('conversation-1', async () => {
      resolve()
      await new Promise((done) => {
        release = done
      })
    })
  })
  await firstStarted
  queue.run('conversation-1', async () => {
    secondRan = true
  })

  queue.clear('conversation-1')
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(secondRan, false)
  assert.equal(queue.depth('conversation-1'), 0)
})
