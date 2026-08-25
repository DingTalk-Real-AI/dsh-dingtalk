import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { accountStateDir, configuredAccountSpecs, resolveRuntimeAccounts } from '../lib/accounts.js'

test('旧单账号配置保持默认凭据引用与原状态目录', () => {
  const [account] = configuredAccountSpecs({
    accounts: [],
    clientId: 'legacy-id',
    clientSecret: 'legacy-secret',
    ownerStaffId: 'owner',
    groupAllowlist: ['group'],
  })

  assert.deepEqual(account, {
    id: 'default',
    enabled: true,
    clientId: 'legacy-id',
    clientSecret: 'legacy-secret',
    clientIdRef: 'DINGTALK_CLIENT_ID',
    clientSecretRef: 'DINGTALK_CLIENT_SECRET',
    ownerStaffId: 'owner',
    senderAccess: 'owner',
    allowedSenders: [],
    groupAccess: 'allowlist',
    groupAllowlist: ['group'],
    sessionScope: 'chat',
  })
  assert.equal(accountStateDir('/tmp/dsh-state', 'default'), '/tmp/dsh-state')
})

test('多账号配置为每个机器人派生独立状态目录', () => {
  const accounts = configuredAccountSpecs({
    accounts: [
      { id: 'default', enabled: true, clientIdRef: 'DINGTALK_CLIENT_ID', clientSecretRef: 'DINGTALK_CLIENT_SECRET' },
      {
        id: 'support-bot',
        enabled: true,
        clientIdRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID',
        clientSecretRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET',
        senderAccess: 'all',
        allowedSenders: [],
        groupAccess: 'all',
        groupAllowlist: [],
        sessionScope: 'chat-sender',
      },
      { id: 'disabled-bot', enabled: false },
    ],
    clientId: '',
    clientSecret: '',
    ownerStaffId: '',
    groupAllowlist: [],
  })

  assert.deepEqual(
    accounts.map((account) => [account.id, account.senderAccess, account.groupAccess, account.sessionScope]),
    [
      ['default', 'owner', 'none', 'chat'],
      ['support-bot', 'all', 'all', 'chat-sender'],
    ],
  )
  assert.equal(accountStateDir('/tmp/dsh-state', 'support-bot'), path.join('/tmp/dsh-state', 'accounts', 'support-bot'))
})

test('非法或重复账号标识会在启动前被拒绝', () => {
  assert.throws(
    () =>
      configuredAccountSpecs({
        accounts: [{ id: '../escape', enabled: true }],
        clientId: '',
        clientSecret: '',
        ownerStaffId: '',
        groupAllowlist: [],
      }),
    /机器人标识/,
  )
  assert.throws(
    () =>
      configuredAccountSpecs({
        accounts: [
          { id: 'same', enabled: true },
          { id: 'same', enabled: true },
        ],
        clientId: '',
        clientSecret: '',
        ownerStaffId: '',
        groupAllowlist: [],
      }),
    /重复/,
  )
})

test('运行时归一化拒绝无效或复用的凭据引用', () => {
  const base = {
    clientId: '',
    clientSecret: '',
    ownerStaffId: '',
    groupAllowlist: [],
  }

  assert.throws(
    () =>
      configuredAccountSpecs({
        ...base,
        accounts: [{ id: 'same-ref', enabled: true, clientIdRef: 'SAME', clientSecretRef: 'SAME' }],
      }),
    /两个不同的有效凭据引用/,
  )
  assert.throws(
    () =>
      configuredAccountSpecs({
        ...base,
        accounts: [{ id: 'invalid-ref', enabled: true, clientIdRef: 'NOT-AN-ENV-REF' }],
      }),
    /两个不同的有效凭据引用/,
  )
  assert.deepEqual(
    configuredAccountSpecs({
      ...base,
      accounts: [{ id: 'disabled-invalid-ref', enabled: false, clientIdRef: 'SAME', clientSecretRef: 'SAME' }],
    }),
    [],
  )
})

test('运行时从各自凭据引用解析多个账号并跳过重复应用连接', async () => {
  const specs = configuredAccountSpecs({
    accounts: [
      { id: 'default', enabled: true },
      { id: 'support-bot', enabled: true },
      { id: 'duplicate-bot', enabled: true },
    ],
    clientId: '',
    clientSecret: '',
    ownerStaffId: '',
    groupAllowlist: [],
  })
  const values = new Map([
    ['DINGTALK_CLIENT_ID', 'app-default'],
    ['DINGTALK_CLIENT_SECRET', 'secret-default'],
    ['DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID', 'app-support'],
    ['DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET', 'secret-support'],
    ['DINGTALK_ACCOUNT_DUPLICATE_BOT_CLIENT_ID', 'app-support'],
    ['DINGTALK_ACCOUNT_DUPLICATE_BOT_CLIENT_SECRET', 'secret-duplicate'],
  ])

  const result = await resolveRuntimeAccounts(specs, async (ref) => values.get(ref) ?? '', {})

  assert.deepEqual(
    result.accounts.map((account) => [account.id, account.clientId]),
    [
      ['default', 'app-default'],
      ['support-bot', 'app-support'],
    ],
  )
  assert.deepEqual(result.duplicateAccountIds, ['duplicate-bot'])
  assert.deepEqual(result.missingCredentialAccountIds, [])
})

test('缺少任一凭据的账号不会阻止其他账号启动', async () => {
  const specs = configuredAccountSpecs({
    accounts: [
      { id: 'default', enabled: true, clientId: 'inline-id', clientSecret: 'inline-secret' },
      { id: 'missing-bot', enabled: true },
    ],
    clientId: '',
    clientSecret: '',
    ownerStaffId: '',
    groupAllowlist: [],
  })

  const result = await resolveRuntimeAccounts(specs, async () => '', {})

  assert.deepEqual(
    result.accounts.map((account) => account.id),
    ['default'],
  )
  assert.deepEqual(result.missingCredentialAccountIds, ['missing-bot'])
})
