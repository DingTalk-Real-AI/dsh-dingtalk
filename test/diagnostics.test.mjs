import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectDiagnostics, verifyDingTalkCredentials } from '../lib/diagnostics.js'

test('凭据联网验证使用有上限的超时信号', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal)
    assert.equal(init.signal.aborted, false)
    return { ok: true }
  }

  assert.equal(await verifyDingTalkCredentials('client-private-value', 'secret-private-value'), true)
})

test('doctor 区分凭据、管理员绑定、文字审批和运行期卡片权限错误', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-doctor-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(stateDir, { recursive: true, force: true })))
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({ ownerStaffId: 'owner-1' }))
  await writeFile(
    path.join(stateDir, 'capabilities.json'),
    JSON.stringify({
      aiCard: { available: false, reason: '缺少钉钉应用权限 Card.Streaming.Write', observedAt: 1 },
    }),
  )
  await writeFile(
    path.join(stateDir, 'runtime.json'),
    JSON.stringify({ stream: { status: 'connected', observedAt: Date.now() } }),
  )

  const checks = await collectDiagnostics({
    stateDir,
    clientId: 'ding-app',
    clientSecret: 'secret',
    interactionCardTemplateId: '',
    verifyCredentials: async () => true,
  })

  assert.equal(checks.find((check) => check.id === 'credentials')?.status, 'pass')
  assert.equal(checks.find((check) => check.id === 'owner')?.status, 'pass')
  assert.equal(checks.find((check) => check.id === 'interaction-card')?.status, 'warn')
  assert.match(checks.find((check) => check.id === 'interaction-card')?.detail ?? '', /文字审批可用/)
  assert.equal(checks.find((check) => check.id === 'ai-card')?.status, 'fail')
  assert.equal(checks.find((check) => check.id === 'stream')?.status, 'pass')
  assert.match(checks.find((check) => check.id === 'ai-card')?.detail ?? '', /Card\.Streaming\.Write/)
})

test('doctor 不把未在线验证的凭据误报为可用', async () => {
  const checks = await collectDiagnostics({
    stateDir: '/path/does/not/exist',
    clientId: 'ding-app',
    clientSecret: 'secret',
    interactionCardTemplateId: 'template-id',
  })
  assert.equal(checks.find((check) => check.id === 'credentials')?.status, 'warn')
  assert.equal(checks.find((check) => check.id === 'owner')?.status, 'fail')
  assert.equal(checks.find((check) => check.id === 'ai-card')?.status, 'warn')
  assert.equal(checks.find((check) => check.id === 'stream')?.status, 'warn')
})

test('doctor 不把过期的 connected 状态误报为当前在线', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-stale-runtime-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(stateDir, { recursive: true, force: true })))
  await writeFile(
    path.join(stateDir, 'runtime.json'),
    JSON.stringify({
      stream: { status: 'connected', observedAt: Date.now() - 60_000 },
    }),
  )
  const checks = await collectDiagnostics({
    stateDir,
    clientId: '',
    clientSecret: '',
    interactionCardTemplateId: '',
  })
  assert.equal(checks.find((check) => check.id === 'stream')?.status, 'warn')
  assert.match(checks.find((check) => check.id === 'stream')?.detail ?? '', /过期|离线/)
})
