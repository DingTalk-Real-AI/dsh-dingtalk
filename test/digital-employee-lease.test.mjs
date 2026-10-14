import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EmployeeLease } from '../lib/digital-employee-lease.js'

const privateText = 'PRIVATE_UPSTREAM_TEXT 不得进入日志的原始错误'
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

for (const [name, options] of [
  [
    'stdout 业务错误',
    {
      stdout: JSON.stringify({
        ok: false,
        outcome: 'failure',
        error: { type: 'validation', exit_code: 3, subtype: 'visibility_supervisor_missing', message: privateText },
      }),
    },
  ],
  [
    'stderr 业务错误',
    {
      stderr: JSON.stringify({
        error: {
          code: 3,
          category: 'validation',
          reason: 'visibility_supervisor_missing',
          retryable: false,
          message: privateText,
        },
      }),
    },
  ],
  ['自由文本', { stderr: privateText }],
  ['意外成功退出', { stdout: privateText, exitCode: 0 }],
  ['信号退出', { stderr: privateText, signal: true }],
  ['输出超限', { stdout: 'x'.repeat(65_537) }],
]) {
  test(
    `lease 未取得时只返回通用错误，不再依赖主管迁移分类：${name}`,
    { skip: process.platform === 'win32' },
    async (t) => {
      const { lease, losses } = await fixture(t, options)
      await assert.rejects(lease.start(), { message: 'employee_lease_unavailable' })
      assert.equal(lease.lost, true)
      assert.equal(losses(), 1)
    },
  )
}

test(
  '本地联合验收：缺少主管字段的旧受管绑定离线启动和释放 lease',
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
    await lease.start()
    assert.equal(lease.lost, false)
    const guard = path.join(config, 'digital-employees', `employee-${digest}`, 'lease-guard.json')
    assert.ok((await readFile(guard, 'utf8')).length > 0)
    await lease.stop()
    assert.equal(lease.lost, false)
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
    const { lease, losses } = await fixture(t, { stderr: privateText + '\n', leased: true })
    await lease.start()
    assert.equal(lease.lost, false)
    await lease.stop()
    assert.equal(losses(), 0)
  },
)
