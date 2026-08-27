import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

test('公开帮助只推荐正式 latest 安装渠道', () => {
  const result = spawnSync(process.execPath, ['lib/bin.js', '--help'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /@dingtalk-real-ai\/dsh-dingtalk@latest setup/)
  assert.doesNotMatch(result.stdout, /@beta/)
})

test('公开 setup CLI 在一个进程内完成插件安装和配置', async (t) => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-cli-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'calls.log')
  await import('node:fs/promises').then((fs) => fs.mkdir(bin, { recursive: true }))
  await writeFile(
    path.join(bin, 'dsh'),
    `#!/bin/sh\necho "dsh $*" >> "$DSH_TEST_CALL_LOG"\nif [ "$1" = "--version" ]; then echo 0.1.0; fi\nexit 0\n`,
  )
  await writeFile(
    path.join(bin, 'npm'),
    `#!/bin/sh\necho "npm $*" >> "$DSH_TEST_CALL_LOG"\nif [ "$1 $2 $3" = "config get registry" ]; then echo 'https://registry.npmjs.org/'; fi\nexit 0\n`,
  )
  await writeFile(path.join(bin, 'pnpm'), `#!/bin/sh\necho "pnpm $*" >> "$DSH_TEST_CALL_LOG"\necho 11.7.0\nexit 0\n`)
  await writeFile(path.join(bin, 'ps'), '#!/bin/sh\necho "4242 1 node /tmp/dsh/lib/bin.js web"\n')
  await chmod(path.join(bin, 'dsh'), 0o755)
  await chmod(path.join(bin, 'npm'), 0o755)
  await chmod(path.join(bin, 'pnpm'), 0o755)
  await chmod(path.join(bin, 'ps'), 0o755)

  const result = spawnSync(process.execPath, ['lib/bin.js', 'setup'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    input: ['2', 'ding-cli', 'secret-cli', '', '', '', '', '', 'n'].join('\n'),
    env: {
      ...process.env,
      HOME: root,
      DSH_HOME: path.join(root, '.dsh'),
      DSH_DINGTALK_STATE_DIR: path.join(root, '.dsh-dingtalk'),
      DSH_TEST_CALL_LOG: log,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    timeout: 10_000,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /⏳ 正在安装 DSH web profile 插件…/)
  assert.match(result.stdout, /✅ DSH web profile 插件安装完成/)
  assert.doesNotMatch(result.stdout, /✅ 正在/)
  assert.match(result.stdout, /插件已安装到 DSH web profile/)
  assert.match(result.stdout, /\/bind [A-Z0-9]+/)
  assert.doesNotMatch(result.stdout, /secret-cli/)
  assert.match(await readFile(log, 'utf8'), /dsh plugin --profile web add/)
  assert.match(await readFile(log, 'utf8'), /npm config get registry/)
  assert.equal(
    await readFile(path.join(root, '.dsh', 'profiles', 'web', '.npmrc'), 'utf8'),
    'registry=https://registry.npmjs.org/\n',
  )
  assert.match(result.stdout, /检测到 dsh web 正在运行/)
  assert.doesNotMatch(await readFile(log, 'utf8'), /dsh web/)
  assert.deepEqual(parse(await readFile(path.join(root, '.dsh', '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'ding-cli',
    DINGTALK_CLIENT_SECRET: 'secret-cli',
  })
})

test('公开 setup CLI 用失败图标和摘要展示插件安装根因', async (t) => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-cli-failure-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const bin = path.join(root, 'bin')
  await import('node:fs/promises').then((fs) => fs.mkdir(bin, { recursive: true }))
  await writeFile(
    path.join(bin, 'dsh'),
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo 0.1.1-rc.2; exit 0; fi',
      'pnpm "$4" "$5"',
      'status=$?',
      'echo "dsh: pnpm failed in profile directory $DSH_HOME/profiles/web" >&2',
      'exit $status',
      '',
    ].join('\n'),
  )
  await writeFile(
    path.join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo 11.7.0; exit 0; fi',
      'echo "Progress: resolved 20, reused 19, downloaded 0, added 0"',
      'echo "[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh-fs-local@^0.1.1-rc.2"',
      'echo "while fetching it from https://packages.example.test/"',
      'exit 1',
      '',
    ].join('\n'),
  )
  await chmod(path.join(bin, 'dsh'), 0o755)
  await chmod(path.join(bin, 'pnpm'), 0o755)

  const result = spawnSync(process.execPath, ['lib/bin.js', 'setup'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      DSH_HOME: path.join(root, '.dsh'),
      DSH_DINGTALK_STATE_DIR: path.join(root, '.dsh-dingtalk'),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    timeout: 10_000,
  })

  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.match(result.stdout, /⏳ 正在安装 DSH web profile 插件…/)
  assert.match(result.stdout, /❌ DSH web profile 插件安装失败/)
  assert.doesNotMatch(result.stdout, /✅ 正在安装 DSH web profile 插件/)
  assert.match(result.stderr, /错误码：ERR_PNPM_NO_MATCHING_VERSION/)
  assert.match(result.stderr, /包：@deepseek-ai\/dsh-fs-local@\^0\.1\.1-rc\.2/)
  assert.match(result.stderr, /Registry：https:\/\/packages\.example\.test\//)
  assert.doesNotMatch(result.stderr, /Progress: resolved/)
  const logPath = result.stderr.match(/完整日志：(.+)/)?.[1]
  assert.ok(logPath)
  assert.match(await readFile(logPath, 'utf8'), /Progress: resolved 20/)
})

test('doctor 识别 web profile 中显式配置的管理员', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-cli-doctor-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'web')
  await import('node:fs/promises').then((fs) => fs.mkdir(profile, { recursive: true }))
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    '- id: dingtalk-channel\n  config:\n    ownerStaffId: configured-owner\n',
  )

  const result = spawnSync(process.execPath, ['lib/bin.js', 'doctor', '--offline'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, HOME: root, DSH_HOME: dshHome },
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /✅ 唯一管理员：已完成绑定或显式配置/)
})

test('doctor 读取 DSH v1 凭据文件', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-cli-v1-doctor-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'web')
  await import('node:fs/promises').then((fs) => fs.mkdir(profile, { recursive: true }))
  await writeFile(
    path.join(dshHome, '.credentials.yaml'),
    ['version: 1', 'refs:', '  DINGTALK_CLIENT_ID: default-app', '  DINGTALK_CLIENT_SECRET: default-secret', ''].join(
      '\n',
    ),
    { mode: 0o600 },
  )
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    '- id: dingtalk-channel\n  config:\n    ownerStaffId: configured-owner\n',
  )

  const result = spawnSync(process.execPath, ['lib/bin.js', 'doctor', '--offline'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, HOME: root, DSH_HOME: dshHome },
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /⚠️ 应用凭据：已配置，但本次未执行联网验证/)
  assert.doesNotMatch(result.stderr, /无效条目 version/)
})

test('doctor 分账号展示多条 Stream 与凭据诊断', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-cli-multi-doctor-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'web')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await import('node:fs/promises').then((fs) =>
    fs.mkdir(path.join(stateDir, 'accounts', 'support-bot'), { recursive: true }),
  )
  await import('node:fs/promises').then((fs) => fs.mkdir(profile, { recursive: true }))
  await writeFile(
    path.join(dshHome, '.credentials.yaml'),
    [
      'DINGTALK_CLIENT_ID: default-app',
      'DINGTALK_CLIENT_SECRET: default-secret',
      'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_ID: support-app',
      'DINGTALK_ACCOUNT_SUPPORT_BOT_CLIENT_SECRET: support-secret',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
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
  await writeFile(path.join(stateDir, 'owner.json'), JSON.stringify({ ownerStaffId: 'owner-default' }))
  await writeFile(
    path.join(stateDir, 'accounts', 'support-bot', 'owner.json'),
    JSON.stringify({ ownerStaffId: 'owner-support' }),
  )

  const result = spawnSync(process.execPath, ['lib/bin.js', 'doctor', '--offline'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, HOME: root, DSH_HOME: dshHome, DSH_DINGTALK_STATE_DIR: stateDir },
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /\[default\]/)
  assert.match(result.stdout, /\[support-bot\]/)
  assert.equal((result.stdout.match(/应用凭据：已配置/g) ?? []).length, 2)
})

test('doctor 使用 profile 中为账号配置的自定义凭据引用', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-cli-custom-ref-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'web')
  await import('node:fs/promises').then((fs) => fs.mkdir(profile, { recursive: true }))
  await writeFile(path.join(dshHome, '.credentials.yaml'), 'CUSTOM_ID: custom-app\nCUSTOM_SECRET: custom-secret\n', {
    mode: 0o600,
  })
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    [
      '- id: dingtalk-channel',
      '  config:',
      '    accounts:',
      '      - id: custom-bot',
      '        enabled: true',
      '        clientIdRef: CUSTOM_ID',
      '        clientSecretRef: CUSTOM_SECRET',
      '',
    ].join('\n'),
  )

  const result = spawnSync(process.execPath, ['lib/bin.js', 'doctor', '--offline'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, HOME: root, DSH_HOME: dshHome },
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /应用凭据：已配置/)
})

test('doctor 不为全部禁用的账号虚构默认账号', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-cli-disabled-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const dshHome = path.join(root, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'web')
  await import('node:fs/promises').then((fs) => fs.mkdir(profile, { recursive: true }))
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    '- id: dingtalk-channel\n  config:\n    accounts:\n      - id: paused-bot\n        enabled: false\n',
  )

  const result = spawnSync(process.execPath, ['lib/bin.js', 'doctor', '--offline'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, HOME: root, DSH_HOME: dshHome },
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /没有启用的钉钉机器人/)
  assert.doesNotMatch(result.stdout, /应用凭据/)
})
