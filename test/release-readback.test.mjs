import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const expected = {
  packageName: '@dingtalk-real-ai/dsh-dingtalk',
  repository: 'DingTalk-Real-AI/dsh-dingtalk',
  sha: '18f2f416090a02fa4c98df5d6f4bab447e298deb',
  version: '0.5.2',
}

const fakeNpm = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const scenario = process.env.READBACK_SCENARIO || ''
const state = path.join(process.env.READBACK_STATE_DIR, 'metadata-count')
if (args.includes('dist-tags.latest')) {
  console.log(JSON.stringify('${expected.version}'))
  process.exit(0)
}
if (args.includes('gitHead')) {
  const count = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) + 1 : 1
  fs.writeFileSync(state, String(count))
  if ((scenario === 'metadata-once' && count === 1) || scenario === 'metadata-always') {
    console.error('npm error code ETARGET')
    process.exit(1)
  }
  console.log(JSON.stringify({
    version: scenario === 'wrong-version' ? '0.5.1' : '${expected.version}',
    gitHead: scenario === 'wrong-sha' ? 'wrong-sha' : process.env.GITHUB_SHA,
    'repository.url': scenario === 'wrong-repository' ? 'git+https://github.com/example/wrong.git' : 'git+https://github.com/' + process.env.GITHUB_REPOSITORY + '.git',
    'dist.attestations.url': scenario === 'missing-provenance' ? '' : 'https://registry.npmjs.org/-/npm/v1/attestations/test',
  }))
  process.exit(0)
}
console.error('unexpected npm args: ' + args.join(' '))
process.exit(2)
`

const fakeNpx = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const scenario = process.env.READBACK_SCENARIO || ''
const state = path.join(process.env.READBACK_STATE_DIR, 'cli-count')
const count = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) + 1 : 1
fs.writeFileSync(state, String(count))
if (scenario === 'cli-once' && count === 1) {
  console.error('npm error code ETARGET')
  process.exit(1)
}
console.log(scenario === 'wrong-cli' ? '0.5.1' : '${expected.version}')
`

const fakeGh = `#!/usr/bin/env node
const args = process.argv.slice(2)
const scenario = process.env.READBACK_SCENARIO || ''
if (args[0] === 'release' && scenario === 'missing-release') {
  console.error('release not found')
  process.exit(1)
}
if (args[0] === 'release') process.exit(0)
if (args[0] === 'api') {
  console.log(scenario === 'wrong-tag' ? 'wrong-sha' : process.env.GITHUB_SHA)
  process.exit(0)
}
console.error('unexpected gh args: ' + args.join(' '))
process.exit(2)
`

async function runVerifier(t, scenario, attempts = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-release-readback-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const bin = path.join(root, 'bin')
  const state = path.join(root, 'state')
  await mkdir(bin)
  await mkdir(state)

  for (const [name, source] of [
    ['npm', fakeNpm],
    ['npx', fakeNpx],
    ['gh', fakeGh],
  ]) {
    const file = path.join(bin, name)
    await writeFile(file, source)
    await chmod(file, 0o755)
  }

  return spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PACKAGE_NAME: expected.packageName,
      GITHUB_REPOSITORY: expected.repository,
      GITHUB_SHA: expected.sha,
      RUNNER_TEMP: root,
      RELEASE_READBACK_ATTEMPTS: String(attempts),
      RELEASE_READBACK_DELAY_MS: '0',
      READBACK_SCENARIO: scenario,
      READBACK_STATE_DIR: state,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    timeout: 10_000,
  })
}

test('精确版本暂未同步时从发布读回入口重试并成功', async (t) => {
  const result = await runVerifier(t, 'metadata-once')

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /第 1\/2 次公开发布读回未收敛：[\s\S]*ETARGET/)
  assert.match(result.stdout, /Verified @dingtalk-real-ai\/dsh-dingtalk@0\.5\.2/)
})

test('公开 CLI 暂未同步时仍在同一重试边界内恢复', async (t) => {
  const result = await runVerifier(t, 'cli-once')

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /第 1\/2 次公开发布读回未收敛：[\s\S]*ETARGET/)
  assert.match(result.stdout, /public-cli=0\.5\.2/)
})

const failures = [
  ['metadata-always', /ETARGET/],
  ['wrong-version', /精确版本尚未收敛/],
  ['wrong-sha', /gitHead 尚未收敛/],
  ['wrong-repository', /repository 不匹配/],
  ['missing-provenance', /provenance 尚未收敛/],
  ['wrong-cli', /公开 CLI 版本尚未收敛/],
  ['missing-release', /release not found/],
  ['wrong-tag', /GitHub tag 不匹配/],
]

for (const [scenario, expectedError] of failures) {
  test(`公开发布校验对 ${scenario} 保持 fail-closed`, async (t) => {
    const result = await runVerifier(t, scenario, 1)
    const output = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 1, output)
    assert.match(output, expectedError)
    assert.match(output, /1 次尝试后仍未收敛/)
  })
}
