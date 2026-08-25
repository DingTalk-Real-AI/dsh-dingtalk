import assert from 'node:assert/strict'
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createSetupCheckpoint,
  loadSetupCheckpoint,
  updateSetupCheckpoint,
  withSetupCheckpointLock,
} from '../lib/setup-checkpoint.js'

function safeInput() {
  return {
    planId: 'plan-001',
    installSpecFingerprint: 'a'.repeat(64),
    serviceWasRunning: false,
    status: 'awaiting_private_credentials',
    completedStepIds: ['install-dsh'],
    answers: {
      accountId: 'support-bot',
      approvals: {
        installDsh: false,
        installPnpm: true,
        installPlugin: true,
        writeProfile: false,
      },
      features: {
        dwsEnabled: true,
        imageMode: 'auto',
        senderAccess: 'allowlist',
        allowedSenders: ['staff-1'],
        groupAccess: 'allowlist',
        groupAllowlist: ['cid-group-1'],
      },
    },
  }
}

test('创建 checkpoint 后可通过不可预测 ID 加载安全答案', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const created = await createSetupCheckpoint(stateDir, safeInput())
  assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(created.schemaVersion, 1)
  assert.deepEqual(await loadSetupCheckpoint(stateDir, created.id), created)

  const file = path.join(stateDir, 'setup', 'checkpoints', `${created.id}.json`)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), created)
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(file))).mode & 0o077, 0)
  }
})

test('更新 checkpoint 保留 ID、创建时间和未修改字段', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-update-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const created = await createSetupCheckpoint(stateDir, safeInput())
  await new Promise((resolve) => setTimeout(resolve, 5))

  const updated = await updateSetupCheckpoint(stateDir, created.id, {
    status: 'applying',
    completedStepIds: ['install-dsh', 'install-plugin'],
  })

  assert.equal(updated.id, created.id)
  assert.equal(updated.createdAt, created.createdAt)
  assert.equal(updated.planId, created.planId)
  assert.equal(updated.installSpecFingerprint, created.installSpecFingerprint)
  assert.equal(updated.serviceWasRunning, false)
  assert.deepEqual(updated.answers, created.answers)
  assert.equal(updated.status, 'applying')
  assert.deepEqual(updated.completedStepIds, ['install-dsh', 'install-plugin'])
  assert.ok(updated.updatedAt > created.updatedAt)
  assert.deepEqual(await loadSetupCheckpoint(stateDir, created.id), updated)
})

test('创建 checkpoint 拒绝未知字段和任意层级的敏感字段且不落盘明文', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-secret-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  await assert.rejects(
    () => createSetupCheckpoint(stateDir, { ...safeInput(), unexpected: true }),
    /未知字段.*unexpected/,
  )
  await assert.rejects(
    () =>
      createSetupCheckpoint(stateDir, {
        ...safeInput(),
        answers: {
          ...safeInput().answers,
          features: { ...safeInput().answers.features, replyMode: 'markdown' },
        },
      }),
    /未知字段.*replyMode/,
  )

  const sensitiveCases = [
    ['clientSecret', (input, marker) => Object.assign(input, { clientSecret: marker })],
    ['clientId', (input, marker) => Object.assign(input.answers, { clientId: marker })],
    ['deviceCode', (input, marker) => Object.assign(input.answers.approvals, { deviceCode: marker })],
    ['verificationUri', (input, marker) => Object.assign(input.answers.features, { verificationUri: marker })],
    ['bindCode', (input, marker) => Object.assign(input.answers, { bindCode: marker })],
    ['ownerStaffId', (input, marker) => Object.assign(input.answers.features, { ownerStaffId: marker })],
  ]
  const markers = []
  for (const [field, inject] of sensitiveCases) {
    const input = safeInput()
    const marker = `must-never-persist-${field}`
    markers.push(marker)
    inject(input, marker)
    await assert.rejects(() => createSetupCheckpoint(stateDir, input), new RegExp(`敏感字段.*${field}`))
  }

  const directory = path.join(stateDir, 'setup', 'checkpoints')
  const entries = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    const content = await readFile(path.join(directory, entry), 'utf8')
    for (const marker of markers) assert.doesNotMatch(content, new RegExp(marker))
  }
})

test('无效更新保持原 checkpoint 可恢复且不残留临时文件', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-atomic-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const created = await createSetupCheckpoint(stateDir, safeInput())
  const directory = path.join(stateDir, 'setup', 'checkpoints')
  const file = path.join(directory, `${created.id}.json`)
  const original = await readFile(file, 'utf8')
  const forbidden = 'must-never-persist-update-secret'

  await assert.rejects(
    () =>
      updateSetupCheckpoint(stateDir, created.id, {
        answers: { ...safeInput().answers, clientSecret: forbidden },
      }),
    /敏感字段.*clientSecret/,
  )
  await assert.rejects(() => updateSetupCheckpoint(stateDir, created.id, { unexpected: true }), /未知字段.*unexpected/)

  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(await loadSetupCheckpoint(stateDir, created.id), created)
  assert.deepEqual(await readdir(directory), [`${created.id}.json`])
  assert.doesNotMatch(original, new RegExp(forbidden))
})

test('加载和更新在文件访问前拒绝非 UUID 与路径穿越 ID', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-id-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  for (const id of ['not-a-uuid', '../outside', '..%2Foutside', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(() => loadSetupCheckpoint(stateDir, id), /checkpoint id.*UUID/i)
    await assert.rejects(() => updateSetupCheckpoint(stateDir, id, { status: 'applying' }), /checkpoint id.*UUID/i)
  }
})

test('加载 checkpoint 严格校验 schema、存储 ID、时间戳和白名单字段', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-schema-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const created = await createSetupCheckpoint(stateDir, safeInput())
  const file = path.join(stateDir, 'setup', 'checkpoints', `${created.id}.json`)
  const writeTampered = (value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

  await writeTampered({ ...created, schemaVersion: 2 })
  await assert.rejects(() => loadSetupCheckpoint(stateDir, created.id), /schemaVersion.*1/)

  await writeTampered({ ...created, id: '11111111-1111-4111-8111-111111111111' })
  await assert.rejects(() => loadSetupCheckpoint(stateDir, created.id), /checkpoint id.*不匹配/i)

  await writeTampered({ ...created, createdAt: 'yesterday' })
  await assert.rejects(() => loadSetupCheckpoint(stateDir, created.id), /createdAt.*ISO/i)

  await writeTampered({ ...created, debug: true })
  await assert.rejects(() => loadSetupCheckpoint(stateDir, created.id), /未知字段.*debug/)

  await writeTampered({
    ...created,
    answers: { ...created.answers, clientId: 'must-never-load-client-id' },
  })
  await assert.rejects(() => loadSetupCheckpoint(stateDir, created.id), /敏感字段.*clientId/)
})

test('checkpoint 只接受执行器约定的状态与稳定 step id', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-enum-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const statuses = [
    'applying',
    'blocked',
    'failed',
    'awaiting_private_credentials',
    'awaiting_private_binding',
    'awaiting_bind',
    'start_required',
    'restart_required',
    'completed',
  ]
  const completedStepIds = [
    'install-dsh',
    'install-pnpm',
    'install-plugin',
    'write-profile',
    'private-credentials',
    'private-binding',
  ]

  for (const status of statuses) {
    const created = await createSetupCheckpoint(stateDir, { ...safeInput(), status, completedStepIds })
    assert.equal(created.status, status)
    assert.deepEqual(created.completedStepIds, completedStepIds)
  }
  await assert.rejects(
    () => createSetupCheckpoint(stateDir, { ...safeInput(), status: 'awaiting-user' }),
    /status.*不支持/,
  )
  await assert.rejects(
    () => createSetupCheckpoint(stateDir, { ...safeInput(), completedStepIds: ['inspect-environment'] }),
    /completedStepIds.*不支持/,
  )
})

test('加载和更新拒绝权限过宽的 checkpoint 文件或目录', async (t) => {
  if (process.platform === 'win32') return
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-mode-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const created = await createSetupCheckpoint(stateDir, safeInput())
  const directory = path.join(stateDir, 'setup', 'checkpoints')
  const file = path.join(directory, `${created.id}.json`)

  await chmod(file, 0o644)
  await assert.rejects(() => loadSetupCheckpoint(stateDir, created.id), /checkpoint 文件权限.*0600/)
  await assert.rejects(
    () => updateSetupCheckpoint(stateDir, created.id, { status: 'applying' }),
    /checkpoint 文件权限.*0600/,
  )

  await chmod(file, 0o600)
  await chmod(directory, 0o755)
  await assert.rejects(() => loadSetupCheckpoint(stateDir, created.id), /checkpoint 目录权限.*私有/)
})

test('同一 checkpoint 的执行锁会串行化并发 resume', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-lock-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const checkpoint = await createSetupCheckpoint(stateDir, safeInput())
  const events = []

  const first = withSetupCheckpointLock(stateDir, checkpoint.id, async () => {
    events.push('first:start')
    await new Promise((resolve) => setTimeout(resolve, 50))
    events.push('first:end')
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = withSetupCheckpointLock(stateDir, checkpoint.id, async () => {
    events.push('second:start')
    events.push('second:end')
  })

  await Promise.all([first, second])
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])
})

test('多个 waiter 回收死进程锁时仍保持单一临界区', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-checkpoint-dead-lock-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const checkpoint = await createSetupCheckpoint(stateDir, safeInput())
  const directory = path.join(stateDir, 'setup', 'checkpoints')
  const deadPid = 2_147_483_647
  const token = '11111111-1111-4111-8111-111111111111'
  const lockFile = path.join(directory, `.${checkpoint.id}.lock`)
  const ownerName = `${path.basename(lockFile)}.owner.${deadPid}.${token}`
  const ownerFile = path.join(directory, ownerName)
  const lockValue = `${JSON.stringify({ pid: deadPid, token, ownerFile: ownerName })}\n`
  await writeFile(ownerFile, lockValue, { mode: 0o600 })
  await link(ownerFile, lockFile)
  let active = 0
  let maximumActive = 0

  await Promise.all(
    Array.from({ length: 4 }, () =>
      withSetupCheckpointLock(stateDir, checkpoint.id, async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
      }),
    ),
  )

  assert.equal(maximumActive, 1)
  assert.deepEqual(await readdir(directory), [`${checkpoint.id}.json`])
})
