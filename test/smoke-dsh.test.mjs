import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const smokeTest = process.platform === 'win32' ? test.skip : test

async function smokeFixture(t, packedBinSource) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-packed-smoke-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const bin = path.join(root, 'bin')
  const dshHome = path.join(root, 'dsh-home')
  const stateDir = path.join(root, 'state')
  await mkdir(bin, { recursive: true })

  const commands = {
    dsh: `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 0.1.0-rc.7
  exit 0
fi
if [ "$1" = "web" ] && [ "$2" = "--port" ]; then
  echo "dsh web: smoke-ready"
  exit 0
fi
if [ "$1" = "web" ]; then
  echo "unexpected guided setup web start" >&2
  exit 42
fi
exit 0
`,
    pnpm: '#!/bin/sh\necho 11.7.0\n',
    ps: '#!/bin/sh\nexit 0\n',
    dws: '#!/bin/sh\nexit 1\n',
  }
  for (const [name, source] of Object.entries(commands)) {
    const file = path.join(bin, name)
    await writeFile(file, source, { mode: 0o755 })
    await chmod(file, 0o755)
  }

  const installedPackage = path.join(dshHome, 'profiles', 'web', 'node_modules', '@dingtalk-real-ai', 'dsh-dingtalk')
  if (packedBinSource === undefined) {
    await mkdir(path.dirname(installedPackage), { recursive: true })
    await symlink(path.resolve('.'), installedPackage, 'dir')
  } else {
    const packedBin = path.join(installedPackage, 'lib', 'bin.js')
    await mkdir(path.dirname(packedBin), { recursive: true })
    await writeFile(packedBin, packedBinSource)
  }

  return {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_DINGTALK_STATE_DIR: stateDir,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  }
}

smokeTest('packed smoke 的公开 setup 不会误启动常驻 dsh web', async (t) => {
  const env = await smokeFixture(t)

  const result = spawnSync(process.execPath, ['scripts/smoke-dsh.mjs'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 10_000,
    env,
  })

  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
  assert.match(result.stdout, /DSH web packed-plugin smoke passed/)
})

smokeTest('packed smoke 失败时报告子进程原因且不泄露凭据或绑定口令', async (t) => {
  const env = await smokeFixture(
    t,
    "console.log('last prompt /bind ABCD1234 smoke-client-secret')\nconsole.error('first-visible-cause')\nprocess.exit(42)\n",
  )

  const result = spawnSync(process.execPath, ['scripts/smoke-dsh.mjs'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 10_000,
    env,
  })

  assert.equal(result.status, 1, result.error?.message || result.stderr || result.stdout)
  assert.match(result.stderr, /exit=42/)
  assert.match(result.stderr, /first-visible-cause/)
  assert.doesNotMatch(result.stderr, /ABCD1234|smoke-client-secret/)
})
