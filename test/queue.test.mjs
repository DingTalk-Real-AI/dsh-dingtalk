import assert from 'node:assert/strict'
import test from 'node:test'

import { Queue } from '../lib/queue.js'

test('employee queue close rejects new work and drain awaits the active task', async () => {
  const q = new Queue(() => {})
  let release,
    ran = 0
  q.run('a', async () => {
    ran++
    await new Promise((r) => {
      release = r
    })
  })
  await new Promise((r) => setImmediate(r))
  q.run('a', async () => {
    ran++
  })
  q.close()
  q.run('b', async () => {
    ran++
  })
  let drained = false
  const done = q.drain().then(() => {
    drained = true
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(drained, false)
  release()
  await done
  assert.equal(ran, 1)
})

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
