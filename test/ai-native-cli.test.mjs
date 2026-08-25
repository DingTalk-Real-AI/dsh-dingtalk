import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const PTY_RUNNER = String.raw`
import os
import pty
import sys

pid, descriptor = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

chunks = []
while True:
    try:
        chunk = os.read(descriptor, 4096)
    except OSError:
        break
    if not chunk:
        break
    chunks.append(chunk)

_, status = os.waitpid(pid, 0)
os.write(1, b''.join(chunks))
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(1)
`

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-ai-native-cli-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'calls.log')
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await import('node:fs/promises').then((fs) => fs.mkdir(bin, { recursive: true }))
  await writeFile(
    path.join(bin, 'dsh'),
    `#!/bin/sh\necho "dsh $*" >> "$DSH_TEST_CALL_LOG"\nif [ "$1" = "--version" ]; then echo 0.1.0; fi\nexit 0\n`,
  )
  await writeFile(path.join(bin, 'pnpm'), `#!/bin/sh\necho "pnpm $*" >> "$DSH_TEST_CALL_LOG"\necho 11.7.0\nexit 0\n`)
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> "$DSH_TEST_CALL_LOG"\nexit 0\n`)
  await writeFile(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n')
  for (const command of ['dsh', 'pnpm', 'npm', 'ps']) await chmod(path.join(bin, command), 0o755)
  const env = {
    ...process.env,
    HOME: root,
    DSH_HOME: dshHome,
    DSH_DINGTALK_STATE_DIR: stateDir,
    DSH_TEST_CALL_LOG: log,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  }
  const run = (args, input) =>
    spawnSync(process.execPath, ['lib/bin.js', ...args], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env,
      input,
      timeout: 10_000,
    })
  const runPty = (args) => {
    const childArgs = [process.execPath, 'lib/bin.js', ...args]
    return spawnSync('python3', ['-c', PTY_RUNNER, ...childArgs], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env,
      timeout: 10_000,
    })
  }
  return { root, bin, log, dshHome, stateDir, run, runPty }
}

function parseOnlyJson(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout)
  return JSON.parse(result.stdout)
}

function setupAnswers(planId) {
  return {
    schemaVersion: 1,
    planId,
    accountId: 'default',
    approvals: {
      installDsh: false,
      installPnpm: false,
      installPlugin: true,
      writeProfile: true,
    },
    features: {
      dwsEnabled: false,
      imageMode: 'auto',
      senderAccess: 'all',
      allowedSenders: [],
      groupAccess: 'all',
      groupAllowlist: [],
    },
  }
}

test('setup plan 是严格只读且 stdout 只有脱敏 JSON', async (t) => {
  const { root, dshHome, stateDir, run } = await fixture(t)

  const result = run(['setup', '--plan', '--json', '--account', 'default'])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  const plan = parseOnlyJson(result)
  assert.equal(plan.kind, 'setup-plan')
  assert.equal(plan.status, 'needs_input')
  assert.match(plan.planId, /^setup-plan-[0-9a-f]{16}$/)
  assert.deepEqual(
    plan.actions.map((action) => action.id),
    ['install-plugin', 'private-credentials', 'write-profile', 'private-binding', 'start-web'],
  )
  assert.doesNotMatch(result.stdout, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await assert.rejects(() => stat(dshHome), { code: 'ENOENT' })
  await assert.rejects(() => stat(stateDir), { code: 'ENOENT' })
})

test('setup apply 和 resume 使用单文档 JSON 与安全 checkpoint', async (t) => {
  const { root, bin, log, dshHome, stateDir, run } = await fixture(t)
  const planResult = run(['setup', '--plan', '--json', '--account', 'default'])
  const plan = parseOnlyJson(planResult)
  const answersFile = path.join(root, 'answers.json')
  await writeFile(answersFile, JSON.stringify(setupAnswers(plan.planId)))

  const applied = run(['setup', '--apply', '--json', '--answers', answersFile])

  assert.equal(applied.status, 0, applied.stderr || applied.stdout)
  assert.equal(applied.stderr, '')
  const outcome = parseOnlyJson(applied)
  assert.equal(outcome.kind, 'setup-outcome')
  assert.equal(outcome.status, 'awaiting_private_credentials')
  assert.equal(outcome.next.kind, 'private_command')
  assert.doesNotMatch(applied.stdout, /⏳|✅|Client Secret|private-secret/)
  const checkpoint = await readFile(path.join(stateDir, 'setup', 'checkpoints', `${outcome.checkpointId}.json`), 'utf8')
  assert.doesNotMatch(checkpoint, /clientSecret|clientId|deviceCode|verificationUri|bindCode|ownerStaffId/i)
  assert.equal((await readFile(log, 'utf8')).match(/dsh plugin --profile web add/g)?.length, 1)

  const resumed = run(['setup', '--resume', outcome.checkpointId, '--json'])

  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout)
  assert.equal(parseOnlyJson(resumed).status, 'awaiting_private_credentials')
  assert.equal((await readFile(log, 'utf8')).match(/dsh plugin --profile web add/g)?.length, 1)

  await writeFile(
    path.join(dshHome, '.credentials.yaml'),
    'version: 1\nrefs:\n  DINGTALK_CLIENT_ID: private-app\n  DINGTALK_CLIENT_SECRET: private-secret\n',
    { mode: 0o600 },
  )
  await writeFile(path.join(stateDir, 'owner.json'), '{"ownerStaffId":"private-owner"}\n', { mode: 0o600 })
  const readyToStart = run(['setup', '--resume', outcome.checkpointId, '--json'])
  assert.equal(parseOnlyJson(readyToStart).status, 'start_required')

  await writeFile(path.join(bin, 'ps'), '#!/bin/sh\necho "4242 1 node /tmp/dsh/lib/bin.js web"\n')
  await chmod(path.join(bin, 'ps'), 0o755)
  const completed = run(['setup', '--resume', outcome.checkpointId, '--json'])
  assert.equal(parseOnlyJson(completed).status, 'completed')
  assert.doesNotMatch(completed.stdout, /private-app|private-secret|private-owner/)
})

test('公开 CLI 拒绝非 TTY，并在 PTY 私密 resume 中保持口令不落 checkpoint', async (t) => {
  if (process.platform === 'win32') return
  const { root, dshHome, stateDir, run, runPty } = await fixture(t)
  const plan = parseOnlyJson(run(['setup', '--plan', '--json', '--account', 'default']))
  const answersFile = path.join(root, 'answers.json')
  await writeFile(answersFile, JSON.stringify(setupAnswers(plan.planId)))
  const outcome = parseOnlyJson(run(['setup', '--apply', '--json', '--answers', answersFile]))
  await writeFile(
    path.join(dshHome, '.credentials.yaml'),
    'version: 1\nrefs:\n  DINGTALK_CLIENT_ID: private-app\n  DINGTALK_CLIENT_SECRET: private-secret\n',
    { mode: 0o600 },
  )

  const rejected = run(['setup', '--resume', outcome.checkpointId])
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /交互式终端/)

  const privateResume = runPty(['setup', '--resume', outcome.checkpointId])
  assert.equal(privateResume.status, 0, privateResume.stderr || privateResume.stdout)
  const terminalOutput = privateResume.stdout + privateResume.stderr
  const code = terminalOutput.match(/\/bind ([A-Z0-9]+)/)?.[1]
  assert.ok(code, terminalOutput)

  const checkpoint = await readFile(path.join(stateDir, 'setup', 'checkpoints', `${outcome.checkpointId}.json`), 'utf8')
  const ownerState = await readFile(path.join(stateDir, 'owner.json'), 'utf8')
  assert.doesNotMatch(checkpoint, new RegExp(code))
  assert.doesNotMatch(ownerState, new RegExp(code))
  assert.doesNotMatch(checkpoint + ownerState, /private-app|private-secret/)
})

test('机器入口拒绝秘密和非法参数，并始终返回脱敏 JSON 错误', async (t) => {
  const { root, run } = await fixture(t)
  const plan = parseOnlyJson(run(['setup', '--plan', '--json', '--account', 'default']))
  const answersFile = path.join(root, 'unsafe-answers.json')
  await writeFile(answersFile, JSON.stringify({ ...setupAnswers(plan.planId), clientSecret: 'must-not-appear' }))

  const unsafe = run(['setup', '--apply', '--json', '--answers', answersFile])
  const invalidDoctor = run(['doctor', '--json', '--unknown'])

  assert.equal(unsafe.status, 2)
  assert.deepEqual(parseOnlyJson(unsafe), {
    schemaVersion: 1,
    kind: 'error',
    error: { code: 'invalid_answers' },
  })
  assert.doesNotMatch(unsafe.stdout + unsafe.stderr, /must-not-appear|unsafe-answers/)
  assert.equal(invalidDoctor.status, 2)
  assert.deepEqual(parseOnlyJson(invalidDoctor), {
    schemaVersion: 1,
    kind: 'error',
    error: { code: 'invalid_arguments' },
  })
})

test('doctor --json 返回稳定报告，失败时也只有一份合法 JSON', async (t) => {
  const { run } = await fixture(t)
  const result = run(['doctor', '--offline', '--json'])

  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  const report = parseOnlyJson(result)
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'doctor-report')
  assert.equal(report.mode, 'offline')
  assert.equal(report.result, 'fail')
  assert.equal(report.accounts[0].checks.find((check) => check.id === 'credentials').code, 'credentials.missing')
  assert.doesNotMatch(result.stdout, /\.credentials|\.dsh|ownerStaffId|clientSecret/)
})
