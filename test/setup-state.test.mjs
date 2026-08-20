import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import {
  accountCredentialRefs,
  loadDingTalkAccountCredentials,
  loadDingTalkCredentials,
  loadWebProfileConfig,
  saveDingTalkAccountCredentials,
  saveDingTalkCredentials,
  upsertWebProfileAccount,
  updateWebProfileConfig,
} from '../lib/setup-state.js'

test('setup 将钉钉凭据写入 DSH 凭据存储并保留其他键', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(file, 'OPENAI_API_KEY: keep-me\n', { mode: 0o600 })

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' })

  assert.deepEqual(parse(await readFile(file, 'utf8')), {
    OPENAI_API_KEY: 'keep-me',
    DINGTALK_CLIENT_ID: 'ding-app',
    DINGTALK_CLIENT_SECRET: 'super-secret',
  })
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await loadDingTalkCredentials(dshHome), {
    clientId: 'ding-app',
    clientSecret: 'super-secret',
    source: 'credentials',
  })
})

test('setup 拒绝读取权限过宽的凭据文件', async (t) => {
  if (process.platform === 'win32') return
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-insecure-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(file, 'DINGTALK_CLIENT_SECRET: leaked\n')
  await chmod(file, 0o644)

  await assert.rejects(() => loadDingTalkCredentials(dshHome), /chmod 600/)
})

test('setup 只更新 web profile 中本插件拥有的配置', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-profile-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')

  await updateWebProfileConfig(dshHome, { dwsEnabled: true, imageMode: 'auto' })
  let parsed = parse(await readFile(file, 'utf8'))
  assert.deepEqual(parsed, [{ id: 'dingtalk-channel', config: { tools: { enabled: true }, imageMode: 'auto' } }])

  parsed.push({ id: 'unrelated-plugin', config: { enabled: true } })
  await writeFile(file, `${JSON.stringify(parsed)}\n`)
  await updateWebProfileConfig(dshHome, { dwsEnabled: false, imageMode: 'never' })

  assert.deepEqual(parse(await readFile(file, 'utf8')), [
    { id: 'dingtalk-channel', config: { tools: { enabled: false }, imageMode: 'never' } },
    { id: 'unrelated-plugin', config: { enabled: true } },
  ])
})

test('读取 web profile 时返回显式配置的管理员', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-profile-owner-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file), { recursive: true }))
  await writeFile(file, '- id: dingtalk-channel\n  config:\n    ownerStaffId: owner-from-profile\n')

  assert.equal((await loadWebProfileConfig(dshHome)).ownerStaffId, 'owner-from-profile')
})

test('多个钉钉账号使用独立凭据引用且不会覆盖默认账号', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-multi-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))

  await saveDingTalkAccountCredentials(dshHome, 'default', {
    clientId: 'default-app',
    clientSecret: 'default-secret',
  })
  await saveDingTalkAccountCredentials(dshHome, 'support-bot', {
    clientId: 'support-app',
    clientSecret: 'support-secret',
  })

  assert.deepEqual(accountCredentialRefs('default'), {
    clientIdRef: 'DINGTALK_CLIENT_ID',
    clientSecretRef: 'DINGTALK_CLIENT_SECRET',
  })
  assert.deepEqual(accountCredentialRefs('support-bot'), {
    clientIdRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID',
    clientSecretRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET',
  })
  assert.equal((await loadDingTalkAccountCredentials(dshHome, 'default'))?.clientId, 'default-app')
  assert.equal((await loadDingTalkAccountCredentials(dshHome, 'support-bot'))?.clientId, 'support-app')
  assert.deepEqual(parse(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'default-app',
    DINGTALK_CLIENT_SECRET: 'default-secret',
    DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID: 'support-app',
    DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET: 'support-secret',
  })
})

test('账号配置迁移会移除旧的 profile 明文凭据覆盖', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-account-profile-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file), { recursive: true }))
  await writeFile(
    file,
    '- id: dingtalk-channel\n  config:\n    clientId: old-app\n    clientSecret: old-secret\n    ownerStaffId: legacy-owner\n    groupAllowlist:\n      - legacy-group\n    tools:\n      enabled: true\n',
    { mode: 0o600 },
  )

  await upsertWebProfileAccount(dshHome, 'default')
  await upsertWebProfileAccount(dshHome, 'support-bot')

  const profile = await loadWebProfileConfig(dshHome)
  assert.deepEqual(profile.accounts, [
    {
      id: 'default',
      enabled: true,
      clientIdRef: 'DINGTALK_CLIENT_ID',
      clientSecretRef: 'DINGTALK_CLIENT_SECRET',
      ownerStaffId: 'legacy-owner',
      groupAllowlist: ['legacy-group'],
    },
    {
      id: 'support-bot',
      enabled: true,
      clientIdRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID',
      clientSecretRef: 'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET',
    },
  ])
  const raw = await readFile(file, 'utf8')
  assert.doesNotMatch(raw, /clientId: old-app|clientSecret: old-secret/)
})

test('读取访问策略并对旧配置保持收紧默认值', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-profile-access-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file), { recursive: true }))
  await writeFile(file, '- id: dingtalk-channel\n  config:\n    imageMode: auto\n')

  const legacy = await loadWebProfileConfig(dshHome)
  assert.equal(legacy.senderAccess, 'owner')
  assert.equal(legacy.groupAccess, 'none')
  assert.deepEqual(legacy.allowedSenders, [])
  assert.deepEqual(legacy.groupAllowlist, [])
})
