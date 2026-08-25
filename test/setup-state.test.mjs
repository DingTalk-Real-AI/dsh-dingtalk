import assert from 'node:assert/strict'
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

test('setup 更新旧 DSH 的扁平凭据时保持其可启动格式', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(file, 'OPENAI_API_KEY: keep-me\n', { mode: 0o600 })

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'flat' })

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

test('setup 首次创建凭据文件时使用旧 DSH 可直接读取的扁平格式', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-new-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'flat' })

  assert.deepEqual(parse(await readFile(file, 'utf8')), {
    DINGTALK_CLIENT_ID: 'ding-app',
    DINGTALK_CLIENT_SECRET: 'super-secret',
  })
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('setup 读写 DSH v1 凭据并保留其他引用、记录与注释', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-v1-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(
    file,
    [
      'version: 1',
      'refs:',
      '  OPENAI_API_KEY: keep-me # 保留无关引用',
      'records:',
      '  llm-pi-ai/test-route:',
      '    kind: api-key',
      '    env:',
      '      AWS_PROFILE: test-profile # 保留无关记录',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'v1' })

  const saved = await readFile(file, 'utf8')
  assert.deepEqual(parse(saved), {
    version: 1,
    refs: {
      OPENAI_API_KEY: 'keep-me',
      DINGTALK_CLIENT_ID: 'ding-app',
      DINGTALK_CLIENT_SECRET: 'super-secret',
    },
    records: {
      'llm-pi-ai/test-route': {
        kind: 'api-key',
        env: { AWS_PROFILE: 'test-profile' },
      },
    },
  })
  assert.match(saved, /# 保留无关引用/)
  assert.match(saved, /# 保留无关记录/)
  assert.deepEqual(await loadDingTalkCredentials(dshHome), {
    clientId: 'ding-app',
    clientSecret: 'super-secret',
    source: 'credentials',
  })
})

test('setup 为 v1 DSH 主动将扁平凭据迁移为版本化文档', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-versioned-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(file, 'OPENAI_API_KEY: keep-me # 保留引用\n', { mode: 0o600 })

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'v1' })

  const saved = await readFile(file, 'utf8')
  assert.deepEqual(parse(saved), {
    version: 1,
    refs: {
      OPENAI_API_KEY: 'keep-me',
      DINGTALK_CLIENT_ID: 'ding-app',
      DINGTALK_CLIENT_SECRET: 'super-secret',
    },
  })
  assert.match(saved, /# 保留引用/)
})

test('旧 DSH 遇到含 records 的 v1 凭据时拒绝有损展平', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-recorded-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  const original = [
    'version: 1',
    'refs:',
    '  OPENAI_API_KEY: keep-me',
    'records:',
    '  llm-pi-ai/test-route:',
    '    kind: api-key',
    '    key: OPENAI_API_KEY',
    '',
  ].join('\n')
  await writeFile(file, original, { mode: 0o600 })

  await assert.rejects(
    () => saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'flat' }),
    /包含 records.*无法安全转换为旧版 DSH/,
  )
  assert.equal(await readFile(file, 'utf8'), original)
})

test('setup 将不含 records 的 DSH v1 凭据安全展平并保留引用', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-flat-v1-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(file, 'version: 1\nrefs:\n  OPENAI_API_KEY: keep-me\n', { mode: 0o600 })

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'flat' })

  assert.deepEqual(parse(await readFile(file, 'utf8')), {
    OPENAI_API_KEY: 'keep-me',
    DINGTALK_CLIENT_ID: 'ding-app',
    DINGTALK_CLIENT_SECRET: 'super-secret',
  })
})

test('setup 将 DSH v1 的空 records 安全展平并保留 refs 注释', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-null-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(file, 'version: 1\nrefs: # 用户说明\nrecords:\n', { mode: 0o600 })

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'flat' })

  const saved = await readFile(file, 'utf8')
  assert.deepEqual(parse(saved), {
    DINGTALK_CLIENT_ID: 'ding-app',
    DINGTALK_CLIENT_SECRET: 'super-secret',
  })
  assert.match(saved, /# 用户说明/)
})

test('setup 从仅含注释的凭据文件初始化时保留文档注释', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-comment-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  await writeFile(file, '# 由用户管理的凭据\n', { mode: 0o600 })

  await saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'flat' })

  assert.match(await readFile(file, 'utf8'), /^# 由用户管理的凭据\n/)
})

test('setup 遇到 DSH 无法读取的 record 时安全退出且不改写文件', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-invalid-record-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  const original = [
    'version: 1',
    'refs:',
    '  OPENAI_API_KEY: keep-me',
    'records:',
    '  llm-pi-ai/test-route:',
    '    kind: api-key',
    '    typo: must-not-be-dropped',
    '',
  ].join('\n')
  await writeFile(file, original, { mode: 0o600 })

  await assert.rejects(
    () => saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'v1' }),
    /record llm-pi-ai\/test-route 包含未知字段 typo/,
  )

  assert.equal(await readFile(file, 'utf8'), original)
  await assert.rejects(() => stat(`${file}.lock`), { code: 'ENOENT' })
})

test('setup 与 DSH 并发写入时等待共享锁并合并最新引用', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-locked-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  const lock = `${file}.lock`
  await writeFile(file, 'version: 1\nrefs:\n  OPENAI_API_KEY: before\n', { mode: 0o600 })
  await writeFile(lock, 'test-writer\n', { mode: 0o600 })

  const saving = saveDingTalkCredentials(
    dshHome,
    { clientId: 'ding-app', clientSecret: 'super-secret' },
    { layout: 'flat' },
  )
  const finishedBeforeUnlock = await Promise.race([
    saving.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ])
  assert.equal(finishedBeforeUnlock, false)

  await writeFile(file, 'version: 1\nrefs:\n  OPENAI_API_KEY: after\n  CONCURRENT_KEY: keep-me\n', { mode: 0o600 })
  await rm(lock)
  await saving

  assert.deepEqual(parse(await readFile(file, 'utf8')), {
    OPENAI_API_KEY: 'after',
    CONCURRENT_KEY: 'keep-me',
    DINGTALK_CLIENT_ID: 'ding-app',
    DINGTALK_CLIENT_SECRET: 'super-secret',
  })
})

test('setup 遇到未知 DSH 凭据版本时安全退出且不改写文件', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-future-credentials-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const file = path.join(dshHome, '.credentials.yaml')
  const original = 'version: 2\nrefs:\n  OPENAI_API_KEY: keep-me\n'
  await writeFile(file, original, { mode: 0o600 })

  await assert.rejects(
    () => saveDingTalkCredentials(dshHome, { clientId: 'ding-app', clientSecret: 'super-secret' }, { layout: 'flat' }),
    /使用不受支持的版本 2/,
  )

  assert.equal(await readFile(file, 'utf8'), original)
  await assert.rejects(() => stat(`${file}.lock`), { code: 'ENOENT' })
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

  await saveDingTalkAccountCredentials(
    dshHome,
    'default',
    { clientId: 'default-app', clientSecret: 'default-secret' },
    { layout: 'flat' },
  )
  await saveDingTalkAccountCredentials(
    dshHome,
    'support-bot',
    { clientId: 'support-app', clientSecret: 'support-secret' },
    { layout: 'flat' },
  )

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

test('Client ID 与 Client Secret 使用同一凭据引用时 fail-closed', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-duplicate-refs-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const duplicateRefs = { clientIdRef: 'DINGTALK_SAME_REF', clientSecretRef: 'DINGTALK_SAME_REF' }

  await assert.rejects(
    () =>
      saveDingTalkAccountCredentials(
        dshHome,
        'default',
        { clientId: 'private-app', clientSecret: 'private-secret' },
        { layout: 'flat', credentialRefs: duplicateRefs },
      ),
    /两个不同的有效凭据引用/,
  )
  await assert.rejects(() => stat(path.join(dshHome, '.credentials.yaml')), { code: 'ENOENT' })

  const profileFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(profileFile), { recursive: true }))
  await writeFile(
    profileFile,
    '- id: dingtalk-channel\n  config:\n    accounts:\n      - id: default\n        clientIdRef: DINGTALK_SAME_REF\n        clientSecretRef: DINGTALK_SAME_REF\n',
  )
  await assert.rejects(() => loadWebProfileConfig(dshHome), /两个不同的有效凭据引用/)
})

test('并发写入多个 web profile 账号不会发生丢失更新', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-concurrent-profile-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const accountIds = Array.from({ length: 12 }, (_, index) => `robot-${index}`)

  await Promise.all(accountIds.map((accountId) => upsertWebProfileAccount(dshHome, accountId)))

  const profile = await loadWebProfileConfig(dshHome)
  assert.deepEqual(new Set(profile.accounts.map((account) => account.id)), new Set(accountIds))
})

test('web profile 写入可安全回收死进程遗留锁', async (t) => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-stale-profile-lock-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dshHome, { recursive: true, force: true })))
  const profileFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(profileFile), { recursive: true }))
  const lockFile = `${profileFile}.lock`
  const deadPid = 2_147_483_647
  const token = '22222222-2222-4222-8222-222222222222'
  const ownerName = `${path.basename(lockFile)}.owner.${deadPid}.${token}`
  const ownerFile = path.join(path.dirname(lockFile), ownerName)
  const lockValue = `${JSON.stringify({ pid: deadPid, token, ownerFile: ownerName })}\n`
  await writeFile(ownerFile, lockValue, { mode: 0o600 })
  await link(ownerFile, lockFile)

  await upsertWebProfileAccount(dshHome, 'default')

  assert.deepEqual(
    (await loadWebProfileConfig(dshHome)).accounts.map((account) => account.id),
    ['default'],
  )
  assert.deepEqual(
    (await readdir(path.dirname(profileFile))).filter((entry) => entry.includes('.lock')),
    [],
  )
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
