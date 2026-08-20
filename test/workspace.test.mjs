import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceLinker } from '../lib/workspace.js'

test('启动时迁移同 cwd 的历史会话，并在后续消息中挂接当前会话', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-workspace-'))
  const other = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-other-'))
  const canonicalCwd = await realpath(cwd)
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  })

  const attached = []
  const workspace = {
    path: canonicalCwd,
    sessionIds: [],
    async attachSession(sessionId) {
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
      attached.push(sessionId)
    },
  }
  const linker = new WorkspaceLinker({
    cwd,
    resolveRegistry: () => ({
      async resolveByPath() {
        return workspace
      },
      async create() {
        throw new Error('不应重复创建工作区')
      },
    }),
    resolvePersistence: () => ({
      async list() {
        return [
          { id: 'history-match', cwd },
          { id: 'history-child', cwd, origin: 'subagent' },
          { id: 'history-other', cwd: other },
          { id: 'history-no-cwd' },
        ]
      },
    }),
    log() {},
  })

  await linker.start()
  await linker.attach('current-session')

  assert.deepEqual(workspace.sessionIds, ['current-session', 'history-match'])
  assert.deepEqual(attached, ['history-match', 'current-session'])
})

test('工作区不存在时创建一次，重复 start 和 attach 保持幂等', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-workspace-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let created = 0
  const workspace = {
    path: cwd,
    sessionIds: [],
    async attachSession(sessionId) {
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
    },
  }
  const linker = new WorkspaceLinker({
    cwd,
    resolveRegistry: () => ({
      async resolveByPath() {
        return undefined
      },
      async create() {
        created++
        return workspace
      },
    }),
    resolvePersistence: () => ({
      async list() {
        return []
      },
    }),
    log() {},
  })

  await Promise.all([linker.start(), linker.start()])
  await linker.attach('session-1')
  await linker.attach('session-1')

  assert.equal(created, 1)
  assert.deepEqual(workspace.sessionIds, ['session-1'])
})
