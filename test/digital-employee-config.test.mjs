import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parse } from 'yaml'

import {
  loadWebProfileConfig,
  registerDigitalEmployee,
  unregisterDigitalEmployee,
  updateDigitalEmployeeAccess,
} from '../lib/setup-state.js'

const registration = {
  schemaVersion: 1,
  agentUuid: 'employee-11111111-2222-4333-8444-555555555555',
  name: '值班助手',
  dwsProfile: 'corp-example:user-example',
  operatorOpenDingTalkId: 'operator-open-id',
  protocolVersion: 1,
}

test('register 幂等写入非敏感数字员工配置并保留白名单', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-config-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))

  assert.deepEqual(await registerDigitalEmployee(dshHome, registration), {
    status: 'created',
    restartRequired: true,
    agentUuid: registration.agentUuid,
  })
  await updateDigitalEmployeeAccess(dshHome, registration.agentUuid, {
    allowedDirectSenders: ['direct-open-id'],
    allowedGroups: ['group-conversation-id'],
    sessionScope: 'chat-sender',
  })
  assert.deepEqual(await registerDigitalEmployee(dshHome, registration), {
    status: 'unchanged',
    restartRequired: false,
    agentUuid: registration.agentUuid,
  })

  const profile = await loadWebProfileConfig(dshHome)
  assert.deepEqual(profile.digitalEmployees, [
    {
      agentUuid: registration.agentUuid,
      name: '值班助手',
      enabled: true,
      dwsProfile: 'corp-example:user-example',
      operatorOpenDingTalkId: 'operator-open-id',
      allowedDirectSenders: ['direct-open-id'],
      allowedGroups: ['group-conversation-id'],
      sessionScope: 'chat-sender',
      protocolVersion: 1,
    },
  ])

  const source = await readFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(source, /token|authCode|secret/i)
})

test('register 拒绝敏感字段、重复 profile 和不安全标识且不改写已有配置', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-invalid-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  await registerDigitalEmployee(dshHome, registration)

  await assert.rejects(
    () => registerDigitalEmployee(dshHome, { ...registration, agentUuid: 'employee-other', accessToken: 'forbidden' }),
    /sensitive_field/,
  )
  await assert.rejects(
    () => registerDigitalEmployee(dshHome, { ...registration, agentUuid: 'employee-other' }),
    /duplicate_dws_profile/,
  )
  await assert.rejects(
    () => registerDigitalEmployee(dshHome, { ...registration, agentUuid: '../../escape', dwsProfile: 'corp:user-2' }),
    /invalid_agent_uuid/,
  )
  await assert.rejects(
    () =>
      registerDigitalEmployee(dshHome, {
        ...registration,
        agentUuid: 'employee-other',
        dwsProfile: 'corp:user-2',
        executablePath: '/tmp/untrusted-dws',
      }),
    /unknown_field/,
  )

  assert.equal((await loadWebProfileConfig(dshHome)).digitalEmployees.length, 1)
})

test('register 对缺字段、空 operator 和未知 schema/protocol 版本 fail-closed', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-required-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const withoutProfile = { ...registration }
  delete withoutProfile.dwsProfile
  await assert.rejects(() => registerDigitalEmployee(dshHome, withoutProfile), /invalid_dws_profile/)
  await assert.rejects(
    () => registerDigitalEmployee(dshHome, { ...registration, operatorOpenDingTalkId: '' }),
    /invalid_operator/,
  )
  await assert.rejects(
    () => registerDigitalEmployee(dshHome, { ...registration, schemaVersion: 2 }),
    /unsupported_schema_version/,
  )
  await assert.rejects(
    () => registerDigitalEmployee(dshHome, { ...registration, protocolVersion: 2 }),
    /unsupported_protocol_version/,
  )
  assert.deepEqual((await loadWebProfileConfig(dshHome)).digitalEmployees, [])
})

test('兼容读取对手工写入的敏感字段 fail-closed', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-manual-secret-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(
    file,
    [
      '- id: dingtalk-channel',
      '  config:',
      '    digitalEmployees:',
      `      - agentUuid: ${registration.agentUuid}`,
      `        dwsProfile: ${registration.dwsProfile}`,
      `        operatorOpenDingTalkId: ${registration.operatorOpenDingTalkId}`,
      '        protocolVersion: 1',
      '        accessToken: forbidden',
      '',
    ].join('\n'),
  )
  await assert.rejects(() => loadWebProfileConfig(dshHome), /sensitive_field/)
})

test('unregister 只移除目标数字员工并保持其他插件配置', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-remove-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  await registerDigitalEmployee(dshHome, registration)
  await registerDigitalEmployee(dshHome, {
    ...registration,
    agentUuid: 'employee-second',
    dwsProfile: 'corp-example:user-second',
  })

  assert.deepEqual(await unregisterDigitalEmployee(dshHome, registration.agentUuid), {
    status: 'removed',
    restartRequired: true,
    agentUuid: registration.agentUuid,
  })
  assert.deepEqual(
    (await loadWebProfileConfig(dshHome)).digitalEmployees.map((item) => item.agentUuid),
    ['employee-second'],
  )
})

test('CLI 通过 stdin 注册并用显式 yes 注销数字员工', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-de-cli-'))
  const dshHome = path.join(root, '.dsh')
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { ...process.env, HOME: root, DSH_HOME: dshHome }

  const registered = spawnSync(process.execPath, ['lib/bin.js', 'digital-employee', 'register', '--stdin', '--json'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env,
    input: JSON.stringify(registration),
  })
  assert.equal(registered.status, 0, registered.stderr)
  assert.deepEqual(JSON.parse(registered.stdout), {
    schemaVersion: 1,
    kind: 'digital_employee_registration',
    status: 'created',
    restartRequired: true,
    agentUuid: registration.agentUuid,
  })

  const denied = spawnSync(
    process.execPath,
    ['lib/bin.js', 'digital-employee', 'unregister', '--agent-uuid', registration.agentUuid, '--json'],
    { cwd: path.resolve('.'), encoding: 'utf8', env },
  )
  assert.equal(denied.status, 2)
  assert.equal(JSON.parse(denied.stdout).error.code, 'confirmation_required')

  const removed = spawnSync(
    process.execPath,
    ['lib/bin.js', 'digital-employee', 'unregister', '--agent-uuid', registration.agentUuid, '--json', '--yes'],
    { cwd: path.resolve('.'), encoding: 'utf8', env },
  )
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(JSON.parse(removed.stdout).status, 'removed')

  const profile = parse(await readFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(profile[0].config.digitalEmployees, [])
})
