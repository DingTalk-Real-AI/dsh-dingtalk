import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceLinker } from '../lib/workspace.js'

test('/cd 的会话应挂接目标 cwd 的工作区，而不是默认工作区', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-switch-'))
  const cwd = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = path.join(cwd, 'target')
  await mkdir(target)
  const workspaces = new Map(
    [cwd, target].map((dir) => [
      dir,
      {
        path: dir,
        sessionIds: [],
        async attachSession(id) {
          if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
        },
      },
    ]),
  )
  const linker = new WorkspaceLinker({
    cwd,
    resolveRegistry: () => ({ resolveByPath: async (dir) => workspaces.get(dir) }),
    resolvePersistence: () => undefined,
    log() {},
  })
  await linker.start()
  await linker.attach('switched-session', target)
  assert.deepEqual(workspaces.get(target).sessionIds, ['switched-session'])
  assert.deepEqual(workspaces.get(cwd).sessionIds, [])
})

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

test('并发切换按目录分别注册一次，路径中的点号不导致重复注册', async () => {
  const defaultCwd = path.resolve('fixture-default')
  const target = path.resolve('fixture-target')
  const created = []
  const linker = new WorkspaceLinker({
    cwd: defaultCwd,
    resolveRegistry: () => ({
      async resolveByPath() {
        return undefined
      },
      async create(dir) {
        created.push(dir)
        return { path: dir, sessionIds: [], async attachSession() {} }
      },
    }),
    resolvePersistence: () => undefined,
    log() {},
  })
  await Promise.all([
    linker.start(),
    linker.attach('a', target),
    linker.attach('b', path.join(target, '.')),
    linker.attach('c', defaultCwd),
  ])
  assert.deepEqual(created.sort(), [defaultCwd, target].sort())
})

test('注册失败或服务暂不可用后，下次挂接能重试且不会影响默认工作区', async () => {
  for (const reason of ['missing-service', 'registration-failed']) {
    let available = false
    const attached = []
    const logs = []
    const registry = {
      async resolveByPath() {
        if (!available) throw new Error('fixture registration failed')
        return {
          path: path.resolve('target'),
          sessionIds: [],
          async attachSession(id) {
            attached.push(id)
          },
        }
      },
    }
    const linker = new WorkspaceLinker({
      cwd: path.resolve('default'),
      resolveRegistry: () => (reason === 'missing-service' && !available ? undefined : registry),
      resolvePersistence: () => undefined,
      attempts: 1,
      retryIntervalMs: 0,
      log: (line) => logs.push(line),
    })
    await linker.attach('session', path.resolve('target'))
    assert.deepEqual(attached, [])
    assert.equal(logs.length, 1)
    available = true
    await linker.attach('session', path.resolve('target'))
    assert.deepEqual(attached, ['session'])
  }
})

test('目标工作区仅迁移匹配 cwd 的历史会话，并保留旧 attach 调用的默认行为', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ws-history-'))
  const cwd = await realpath(root)
  const target = path.join(cwd, 'target')
  await mkdir(target)
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaces = new Map(
    [cwd, target].map((dir) => [
      dir,
      {
        path: dir,
        sessionIds: [],
        async attachSession(id) {
          if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
        },
      },
    ]),
  )
  const linker = new WorkspaceLinker({
    cwd,
    resolveRegistry: () => ({ resolveByPath: async (dir) => workspaces.get(dir) }),
    resolvePersistence: () => ({
      list: async () => [
        { id: 'old-default', cwd },
        { id: 'old-target', cwd: target },
        { id: 'target-child', cwd: target, origin: 'subagent' },
        { id: 'removed', cwd: path.join(cwd, 'removed') },
      ],
    }),
    log() {},
  })
  await linker.attach('new-default')
  await linker.attach('new-target', target)
  assert.deepEqual(workspaces.get(cwd).sessionIds, ['old-default', 'new-default'])
  assert.deepEqual(workspaces.get(target).sessionIds, ['old-target', 'new-target'])
})
