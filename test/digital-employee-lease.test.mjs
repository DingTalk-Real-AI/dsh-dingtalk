import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EmployeeLease } from '../lib/digital-employee-lease.js'

const reasons = [
  'visibility_supervisor_missing',
  'visibility_supervisor_ambiguous',
  'visibility_supervisor_unavailable',
  'visibility_identity_mismatch',
  'visibility_migration_timeout',
  'visibility_binding_changed',
  'visibility_migration_persist_failed',
  'visibility_migration_unavailable',
]
const privateText = 'PRIVATE_UPSTREAM_TEXT 不得进入日志的原始错误'
const errorFor = (reason) => ({
  error: { code: 3, category: 'validation', reason, retryable: false, message: privateText, hint: privateText },
})
const unifiedErrorFor = (subtype) => ({
  ok: false,
  outcome: 'failure',
  error: { exit_code: 3, type: 'validation', subtype, message: privateText, hint: privateText },
})

async function fixture(t, { stderr = '', stdout = '', exitCode = 3, leased = false, signal = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'employee-lease-'))
  const bin = path.join(root, 'bin')
  await mkdir(bin)
  await writeFile(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  await writeFile(
    path.join(bin, 'dws'),
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)}, () => {
  if (${leased}) {
    process.stderr.write('[employee] leased\\n');
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  } else if (${signal}) {
    process.kill(process.pid, 'SIGTERM');
  } else process.exit(${exitCode});
});
`,
    { mode: 0o755 },
  )
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  let losses = 0
  const lease = new EmployeeLease(
    { agentUuid: 'lease-test', dwsProfile: 'fixture:employee', bindingRevision: 1 },
    'lease-runtime',
    () => losses++,
  )
  t.after(async () => {
    await lease.stop()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  })
  return { lease, losses: () => losses }
}

for (const reason of reasons) {
  test(`lease 启动识别统一 stdout 结果：${reason}`, { skip: process.platform === 'win32' }, async (t) => {
    const { lease, losses } = await fixture(t, { stdout: JSON.stringify(unifiedErrorFor(reason), null, 2) })
    await assert.rejects(lease.start(), (error) => {
      assert.ok(error.message.startsWith(`${reason}: `))
      assert.match(error.message, /原主管账号.*connect restart/)
      assert.doesNotMatch(error.message, /PRIVATE_UPSTREAM_TEXT/)
      return true
    })
    assert.equal(lease.lost, true)
    assert.equal(losses(), 1)
  })
  test(`lease 启动保留安全迁移分类：${reason}`, { skip: process.platform === 'win32' }, async (t) => {
    const { lease, losses } = await fixture(t, { stderr: JSON.stringify(errorFor(reason), null, 2) })
    await assert.rejects(lease.start(), (error) => {
      assert.ok(error.message.startsWith(`${reason}: `))
      assert.match(error.message, /原主管账号.*connect restart/)
      assert.doesNotMatch(error.message, /PRIVATE_UPSTREAM_TEXT/)
      return true
    })
    assert.equal(lease.lost, true)
    assert.equal(losses(), 1)
  })
}

const known = errorFor(reasons[0])
const unifiedKnown = unifiedErrorFor(reasons[0])
for (const [name, options] of [
  ['未知分类', { stderr: JSON.stringify(errorFor('untrusted_reason')) }],
  ['原型属性名', { stderr: JSON.stringify(errorFor('toString')) }],
  ['退出成功', { stderr: JSON.stringify(known), exitCode: 0 }],
  ['信号退出', { stderr: JSON.stringify(known), signal: true }],
  ['自由文本伪造 reason', { stderr: `${reasons[0]} ${privateText}` }],
  ['JSON 之前混杂日志', { stderr: `${privateText}\n${JSON.stringify(known)}` }],
  ['JSON 后面混杂日志', { stderr: `${JSON.stringify(known)}\n${privateText}` }],
  ['多个 JSON', { stderr: `${JSON.stringify(known)}\n${JSON.stringify(known)}` }],
  ['JSON 数组', { stderr: JSON.stringify([known]) }],
  ['错误对象数组', { stderr: JSON.stringify({ error: [known.error] }) }],
  ['外层成功响应', { stderr: JSON.stringify({ ok: true, ...known }) }],
  ['错误码类型不符', { stderr: JSON.stringify({ error: { ...known.error, code: '3' } }) }],
  ['错误码不符', { stderr: JSON.stringify({ error: { ...known.error, code: 2 } }) }],
  ['类别不符', { stderr: JSON.stringify({ error: { ...known.error, category: 'internal' } }) }],
  ['retryable 缺失', { stderr: JSON.stringify({ error: { ...known.error, retryable: undefined } }) }],
  ['retryable 字符串', { stderr: JSON.stringify({ error: { ...known.error, retryable: 'false' } }) }],
  ['retryable 为真', { stderr: JSON.stringify({ error: { ...known.error, retryable: true } }) }],
  ['仅 stdout 有分类', { stdout: JSON.stringify(known) }],
  ['输出超限', { stdout: 'x'.repeat(65_537), stderr: JSON.stringify(known) }],
  ['统一结果 ok 为真', { stdout: JSON.stringify({ ...unifiedKnown, ok: true }) }],
  ['统一结果缺少 ok', { stdout: JSON.stringify({ ...unifiedKnown, ok: undefined }) }],
  ['统一结果 outcome 不符', { stdout: JSON.stringify({ ...unifiedKnown, outcome: 'success' }) }],
  ['统一错误码不符', { stdout: JSON.stringify({ ...unifiedKnown, error: { ...unifiedKnown.error, exit_code: 2 } }) }],
  [
    '统一错误码类型不符',
    { stdout: JSON.stringify({ ...unifiedKnown, error: { ...unifiedKnown.error, exit_code: '3' } }) },
  ],
  [
    '统一错误类别不符',
    { stdout: JSON.stringify({ ...unifiedKnown, error: { ...unifiedKnown.error, type: 'internal' } }) },
  ],
  ['统一错误未知分类', { stdout: JSON.stringify(unifiedErrorFor('untrusted_reason')) }],
  [
    '统一错误可重试',
    { stdout: JSON.stringify({ ...unifiedKnown, error: { ...unifiedKnown.error, retryable: true } }) },
  ],
  [
    '统一错误 retryable 类型不符',
    { stdout: JSON.stringify({ ...unifiedKnown, error: { ...unifiedKnown.error, retryable: 'false' } }) },
  ],
  ['统一结果夹带成功数据', { stdout: JSON.stringify({ ...unifiedKnown, data: {} }) }],
  ['无效 stdout 不回退 stderr', { stdout: privateText, stderr: JSON.stringify(known) }],
  [
    '未知 stdout 分类不回退 stderr',
    { stdout: JSON.stringify(unifiedErrorFor('untrusted_reason')), stderr: JSON.stringify(known) },
  ],
]) {
  test(`lease 不信任非协议错误：${name}`, { skip: process.platform === 'win32' }, async (t) => {
    const { lease } = await fixture(t, options)
    await assert.rejects(lease.start(), { message: 'employee_lease_unavailable' })
  })
}

test('统一结果为唯一权威，兼容显式 retryable=false', { skip: process.platform === 'win32' }, async (t) => {
  const { lease } = await fixture(t, {
    stdout: JSON.stringify({ ...unifiedKnown, error: { ...unifiedKnown.error, retryable: false } }),
    stderr: JSON.stringify(errorFor(reasons[1])),
  })
  await assert.rejects(lease.start(), (error) => error.message.startsWith(`${reasons[0]}: `))
})

test(
  '本地联合验收：真实 DWS 启动错误保留安全分类且不发布 lease',
  {
    skip: process.platform === 'win32' || !process.env.DWS_JOINT_BINARY,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dws-lease-joint-'))
    const bin = path.join(root, 'bin')
    const config = path.join(root, 'config')
    await mkdir(bin)
    await mkdir(path.join(config, 'digital-employees'), { recursive: true })
    const binary = path.resolve(process.env.DWS_JOINT_BINARY)
    const quotedBinary = `'${binary.replaceAll("'", "'\\''")}'`
    await writeFile(path.join(bin, 'dws'), `#!/bin/sh\nexec ${quotedBinary} "$@"\n`, { mode: 0o755 })
    const employee = {
      agentUuid: 'joint-lease-employee',
      dwsProfile: 'fixture-corp:fixture-employee',
      bindingRevision: 1,
    }
    const digest = createHash('sha256').update(employee.dwsProfile).digest('hex')
    const bindingPath = path.join(config, 'digital-employees', `${digest}.json`)
    const binding = JSON.stringify({
      schemaVersion: 1,
      ...employee,
      operatorOpenDingTalkId: 'fixture-operator',
      runtimeBindingId: 'fixture-binding',
      channel: 'dsh',
      bindingState: 'bound',
      desiredState: 'running',
    })
    await writeFile(bindingPath, binding)
    await writeFile(
      path.join(config, 'profiles.json'),
      JSON.stringify({
        version: 2,
        currentProfile: employee.dwsProfile,
        profiles: [{ corpId: 'fixture-corp', userId: 'fixture-employee' }],
      }),
    )
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: root,
      USERPROFILE: root,
      DWS_CONFIG_DIR: config,
      DWS_KEYCHAIN_DIR: path.join(root, 'keychain'),
      DWS_DISABLE_KEYCHAIN: '1',
      DWS_NO_UPDATE_CHECK: '1',
      DO_NOT_TRACK: '1',
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '',
    }
    const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
    Object.assign(process.env, env)
    const lease = new EmployeeLease(employee, randomUUID(), () => {})
    t.after(async () => {
      await lease.stop()
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    })
    await assert.rejects(lease.start(), /^Error: visibility_supervisor_unavailable: .*原主管账号/)
    assert.equal(lease.lost, true)
    assert.equal(await readFile(bindingPath, 'utf8'), binding)
    await assert.rejects(readFile(path.join(config, 'digital-employees', `employee-${digest}`, 'lease-guard.json')), {
      code: 'ENOENT',
    })
  },
)

test(
  '已取得 lease 后的错误文本不重新分类启动，正常释放不报告丢失',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { lease, losses } = await fixture(t, { stderr: JSON.stringify(known) + '\n', leased: true })
    await lease.start()
    assert.equal(lease.lost, false)
    await lease.stop()
    assert.equal(losses(), 0)
  },
)
