import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectDoctorReport } from '../lib/doctor-report.js'

async function createProfile(root, source) {
  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), source)
  return dshHome
}

test('离线机器报告提供稳定 schema、状态码和汇总，且不暴露配置值', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-doctor-report-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = await createProfile(
    root,
    [
      '- id: dingtalk-channel',
      '  config:',
      '    ownerStaffId: owner-private-value',
      '    interactionCardTemplateId: interaction-template-private-value',
      '',
    ].join('\n'),
  )
  await writeFile(
    path.join(dshHome, '.credentials.yaml'),
    [
      'version: 1',
      'refs:',
      '  DINGTALK_CLIENT_ID: client-private-value',
      '  DINGTALK_CLIENT_SECRET: secret-private-value',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )

  const report = await collectDoctorReport({
    mode: 'offline',
    dshHome,
    stateDir: path.join(root, '.dsh-dingtalk'),
    env: {},
  })

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'doctor-report')
  assert.equal(report.mode, 'offline')
  assert.equal(report.result, 'unverified')
  assert.deepEqual(report.checks, [])
  assert.equal(report.accounts.length, 1)
  assert.equal(report.accounts[0].id, 'default')
  assert.equal(report.accounts[0].result, 'unverified')
  assert.deepEqual(
    report.accounts[0].checks.map(({ id, status, code }) => ({ id, status, code })),
    [
      { id: 'node', status: 'pass', code: 'node.supported' },
      { id: 'stream', status: 'unverified', code: 'stream.unobserved' },
      { id: 'credentials', status: 'unverified', code: 'credentials.unverified' },
      { id: 'owner', status: 'pass', code: 'owner.configured' },
      { id: 'interaction-card', status: 'unverified', code: 'interaction-card.configured' },
      { id: 'ai-card', status: 'unverified', code: 'ai-card.unverified' },
    ],
  )
  assert.deepEqual(report.summary, { total: 6, pass: 2, warning: 0, fail: 0, unverified: 4, error: 0 })
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(
    serialized,
    /owner-private-value|interaction-template-private-value|client-private-value|secret-private-value/,
  )
})

test('没有启用账号时返回稳定失败码而不是虚构默认账号', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-doctor-disabled-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = await createProfile(
    root,
    [
      '- id: dingtalk-channel',
      '  config:',
      '    accounts:',
      '      - id: paused-bot',
      '        enabled: false',
      '',
    ].join('\n'),
  )

  const report = await collectDoctorReport({
    mode: 'offline',
    dshHome,
    stateDir: path.join(root, '.dsh-dingtalk'),
  })

  assert.equal(report.result, 'fail')
  assert.deepEqual(report.accounts, [])
  assert.deepEqual(report.checks, [
    {
      id: 'profile',
      status: 'fail',
      code: 'profile.no-enabled-accounts',
      message: 'web profile 中没有启用的钉钉机器人',
    },
  ])
  assert.deepEqual(report.summary, { total: 1, pass: 0, warning: 0, fail: 1, unverified: 0, error: 0 })
})

test('凭据读取异常只返回稳定错误码和脱敏消息', async (t) => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-doctor-credential-error-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = await createProfile(root, '- id: dingtalk-channel\n  config: {}\n')
  const credentialFile = path.join(dshHome, '.credentials.yaml')
  await writeFile(
    credentialFile,
    'version: 1\nrefs:\n  DINGTALK_CLIENT_ID: client-private-value\n  DINGTALK_CLIENT_SECRET: secret-private-value\n',
    { mode: 0o644 },
  )

  const report = await collectDoctorReport({
    mode: 'offline',
    dshHome,
    stateDir: path.join(root, '.dsh-dingtalk'),
  })

  assert.equal(report.result, 'error')
  assert.deepEqual(report.accounts[0].checks, [
    {
      id: 'credentials',
      status: 'error',
      code: 'credentials.read-error',
      message: '读取应用凭据失败',
    },
  ])
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /client-private-value|secret-private-value/)
  assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('联网诊断异常和远端能力原因不会进入机器报告', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-doctor-redaction-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = await createProfile(
    root,
    '- id: dingtalk-channel\n  config:\n    ownerStaffId: owner-private-value\n',
  )
  await writeFile(
    path.join(dshHome, '.credentials.yaml'),
    'version: 1\nrefs:\n  DINGTALK_CLIENT_ID: client-private-value\n  DINGTALK_CLIENT_SECRET: secret-private-value\n',
    { mode: 0o600 },
  )
  const stateDir = path.join(root, '.dsh-dingtalk')
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    path.join(stateDir, 'capabilities.json'),
    JSON.stringify({ aiCard: { available: false, reason: 'remote-secret-value from /private/internal/path' } }),
  )

  const report = await collectDoctorReport({
    mode: 'online',
    dshHome,
    stateDir,
    verifyCredentials: async () => {
      throw new Error('verification-secret-value from /private/credential/path')
    },
  })

  assert.equal(report.mode, 'online')
  assert.equal(report.result, 'error')
  assert.deepEqual(
    report.accounts[0].checks
      .filter((check) => check.id === 'credentials' || check.id === 'ai-card')
      .map(({ id, status, code, message }) => ({ id, status, code, message })),
    [
      {
        id: 'credentials',
        status: 'error',
        code: 'credentials.verification-error',
        message: '应用凭据联网验证发生错误',
      },
      {
        id: 'ai-card',
        status: 'fail',
        code: 'ai-card.unavailable',
        message: '运行期已确认 AI Card 流式能力不可用',
      },
    ],
  )
  assert.doesNotMatch(
    JSON.stringify(report),
    /owner-private-value|client-private-value|secret-private-value|remote-secret-value|verification-secret-value|private\/internal|private\/credential/,
  )
})

test('多账号报告逐账号汇总，单个告警决定整体 warning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-doctor-multi-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = await createProfile(
    root,
    [
      '- id: dingtalk-channel',
      '  config:',
      '    accounts:',
      '      - id: default',
      '        enabled: true',
      '      - id: support-bot',
      '        enabled: true',
      '',
    ].join('\n'),
  )
  await writeFile(
    path.join(dshHome, '.credentials.yaml'),
    [
      'version: 1',
      'refs:',
      '  DINGTALK_CLIENT_ID: default-client-private-value',
      '  DINGTALK_CLIENT_SECRET: default-secret-private-value',
      '  DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID: support-client-private-value',
      '  DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET: support-secret-private-value',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  const stateDir = path.join(root, '.dsh-dingtalk')
  await mkdir(path.join(stateDir, 'accounts', 'support-bot'), { recursive: true })
  await writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({ ownerStaffId: 'default-owner-private-value' }))
  await writeFile(
    path.join(stateDir, 'accounts', 'support-bot', 'owner.json'),
    JSON.stringify({ ownerStaffId: 'support-owner-private-value' }),
  )

  const report = await collectDoctorReport({ mode: 'offline', dshHome, stateDir, env: {} })

  assert.equal(report.result, 'warning')
  assert.deepEqual(
    report.accounts.map(({ id, result }) => ({ id, result })),
    [
      { id: 'default', result: 'warning' },
      { id: 'support-bot', result: 'warning' },
    ],
  )
  assert.deepEqual(report.summary, { total: 12, pass: 4, warning: 2, fail: 0, unverified: 6, error: 0 })
  assert.doesNotMatch(JSON.stringify(report), /private-value/)
})

test('profile 解析异常返回稳定错误码且不回显路径或原文', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-doctor-profile-error-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = await createProfile(root, 'profile-secret-value: [unterminated')

  const report = await collectDoctorReport({
    mode: 'offline',
    dshHome,
    stateDir: path.join(root, '.dsh-dingtalk'),
  })

  assert.equal(report.result, 'error')
  assert.deepEqual(report.checks, [
    {
      id: 'profile',
      status: 'error',
      code: 'profile.read-error',
      message: '读取 web profile 配置失败',
    },
  ])
  assert.deepEqual(report.accounts, [])
  assert.doesNotMatch(JSON.stringify(report), /profile-secret-value|dsh-dingtalk-doctor-profile-error/)
})
