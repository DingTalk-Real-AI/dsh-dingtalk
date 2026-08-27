import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

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

const IS_WINDOWS = process.platform === 'win32'

function fixtureCommandPath(bin, command) {
  return path.join(bin, IS_WINDOWS ? `${command}.cmd` : command)
}

async function writeFixtureCommand(bin, command, scripts) {
  const file = fixtureCommandPath(bin, command)
  await writeFile(file, IS_WINDOWS ? scripts.windows : scripts.posix)
  if (!IS_WINDOWS) await chmod(file, 0o755)
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-ai-native-cli-'))
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'calls.log')
  const dshHome = path.join(root, '.dsh')
  const stateDir = path.join(root, '.dsh-dingtalk')
  await import('node:fs/promises').then((fs) => fs.mkdir(bin, { recursive: true }))
  await writeFixtureCommand(bin, 'dsh', {
    posix: `#!/bin/sh\necho "dsh $*" >> "$DSH_TEST_CALL_LOG"\nif [ "$1" = "--version" ]; then echo 0.1.0; fi\nexit 0\n`,
    windows:
      '@echo off\r\necho dsh %~1 %~2 %~3 %~4>>"%DSH_TEST_CALL_LOG%"\r\nif "%~1"=="--version" echo 0.1.0\r\nexit /b 0\r\n',
  })
  await writeFixtureCommand(bin, 'pnpm', {
    posix: `#!/bin/sh\necho "pnpm $*" >> "$DSH_TEST_CALL_LOG"\necho 11.7.0\nexit 0\n`,
    windows: '@echo off\r\necho pnpm %*>>"%DSH_TEST_CALL_LOG%"\r\necho 11.7.0\r\nexit /b 0\r\n',
  })
  await writeFixtureCommand(bin, 'npm', {
    posix: `#!/bin/sh\necho "npm $*" >> "$DSH_TEST_CALL_LOG"\nif [ "$1 $2 $3" = "config get registry" ]; then echo 'https://registry.npmjs.org/'; fi\nexit 0\n`,
    windows:
      '@echo off\r\necho npm %*>>"%DSH_TEST_CALL_LOG%"\r\nif "%~1 %~2 %~3"=="config get registry" echo https://registry.npmjs.org/\r\nexit /b 0\r\n',
  })
  await writeFixtureCommand(bin, 'ps', {
    posix: '#!/bin/sh\nexit 0\n',
    windows: '@echo off\r\nexit /b 0\r\n',
  })
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
  assert.deepEqual(plan.snapshot.dsh, { installed: true, version: '0.1.0' })
  assert.deepEqual(plan.snapshot.pnpm, { installed: true, version: '11.7.0', supported: true })
  assert.deepEqual(
    plan.actions.map((action) => action.id),
    [
      'install-plugin',
      'private-credentials',
      'write-profile',
      'private-binding',
      IS_WINDOWS ? 'restart-web' : 'start-web',
    ],
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
  assert.equal(parseOnlyJson(readyToStart).status, IS_WINDOWS ? 'restart_required' : 'start_required')
  assert.deepEqual(parse(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'private-app',
    DINGTALK_CLIENT_SECRET: 'private-secret',
  })

  if (IS_WINDOWS) {
    assert.doesNotMatch(readyToStart.stdout, /private-app|private-secret|private-owner/)
    return
  }

  await writeFixtureCommand(bin, 'ps', {
    posix: '#!/bin/sh\necho "4242 1 node /tmp/dsh/lib/bin.js web"\n',
    windows: '@echo off\r\necho 4242 1 node C:\\tmp\\dsh\\lib\\bin.js web\r\nexit /b 0\r\n',
  })
  const completed = run(['setup', '--resume', outcome.checkpointId, '--json'])
  assert.equal(parseOnlyJson(completed).status, 'completed')
  assert.doesNotMatch(completed.stdout, /private-app|private-secret|private-owner/)
})

test('旧 DSH 的机器 setup 只在批准后将已有 v1 凭据转换为可读格式', async (t) => {
  const { root, dshHome, stateDir, run } = await fixture(t)
  await import('node:fs/promises').then((fs) =>
    Promise.all([fs.mkdir(dshHome, { recursive: true }), fs.mkdir(stateDir, { recursive: true })]),
  )
  const credentialsFile = path.join(dshHome, '.credentials.yaml')
  const originalCredentials =
    'version: 1\nrefs:\n  DINGTALK_CLIENT_ID: existing-app\n  DINGTALK_CLIENT_SECRET: existing-secret\n'
  await writeFile(credentialsFile, originalCredentials, { mode: 0o600 })
  await writeFile(path.join(stateDir, 'owner.json'), '{"ownerStaffId":"bound-owner"}\n', { mode: 0o600 })

  const plan = parseOnlyJson(run(['setup', '--plan', '--json', '--account', 'default']))
  assert.equal(await readFile(credentialsFile, 'utf8'), originalCredentials)
  assert.equal(
    plan.actions.some((action) => action.id === 'private-credentials'),
    false,
  )

  const unapprovedAnswers = path.join(root, 'unapproved-answers.json')
  const unapproved = setupAnswers(plan.planId)
  unapproved.approvals.writeProfile = false
  await writeFile(unapprovedAnswers, JSON.stringify(unapproved))
  const blocked = run(['setup', '--apply', '--json', '--answers', unapprovedAnswers])
  assert.equal(parseOnlyJson(blocked).status, 'blocked')
  assert.equal(await readFile(credentialsFile, 'utf8'), originalCredentials)

  const approvedAnswers = path.join(root, 'approved-answers.json')
  await writeFile(approvedAnswers, JSON.stringify(setupAnswers(plan.planId)))
  const applied = run(['setup', '--apply', '--json', '--answers', approvedAnswers])

  assert.equal(applied.status, 0, applied.stderr || applied.stdout)
  assert.equal(parseOnlyJson(applied).status, IS_WINDOWS ? 'restart_required' : 'start_required')
  assert.deepEqual(parse(await readFile(credentialsFile, 'utf8')), {
    DINGTALK_CLIENT_ID: 'existing-app',
    DINGTALK_CLIENT_SECRET: 'existing-secret',
  })
})

test('旧 DSH 的机器 setup 对既有 records 返回安全可操作的升级错误', async (t) => {
  const { root, dshHome, stateDir, run } = await fixture(t)
  await import('node:fs/promises').then((fs) =>
    Promise.all([fs.mkdir(dshHome, { recursive: true }), fs.mkdir(stateDir, { recursive: true })]),
  )
  const credentialsFile = path.join(dshHome, '.credentials.yaml')
  const originalCredentials = [
    'version: 1',
    'refs:',
    '  DINGTALK_CLIENT_ID: existing-app',
    '  DINGTALK_CLIENT_SECRET: do-not-leak',
    'records:',
    '  private/route:',
    '    kind: api-key',
    '    key: DINGTALK_CLIENT_SECRET',
    '',
  ].join('\n')
  await writeFile(credentialsFile, originalCredentials, { mode: 0o600 })
  await writeFile(path.join(stateDir, 'owner.json'), '{"ownerStaffId":"bound-owner"}\n', { mode: 0o600 })

  const plan = parseOnlyJson(run(['setup', '--plan', '--json', '--account', 'default']))
  const answersFile = path.join(root, 'answers.json')
  await writeFile(answersFile, JSON.stringify(setupAnswers(plan.planId)))

  const applied = run(['setup', '--apply', '--json', '--answers', answersFile])

  assert.equal(applied.status, 1)
  const result = parseOnlyJson(applied)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.error, { code: 'dsh_upgrade_required', stepId: 'write-profile' })
  assert.doesNotMatch(applied.stdout + applied.stderr, /do-not-leak|private\/route/)
  assert.doesNotMatch(applied.stdout + applied.stderr, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(await readFile(credentialsFile, 'utf8'), originalCredentials)
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
  assert.deepEqual(parse(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')), {
    DINGTALK_CLIENT_ID: 'private-app',
    DINGTALK_CLIENT_SECRET: 'private-secret',
  })
})

test('旧 DSH 无法展平 records 时，PTY 私密 resume 提示先升级且不泄露细节', async (t) => {
  if (process.platform === 'win32') return
  const { root, dshHome, run, runPty } = await fixture(t)
  const plan = parseOnlyJson(run(['setup', '--plan', '--json', '--account', 'default']))
  const answersFile = path.join(root, 'answers.json')
  await writeFile(answersFile, JSON.stringify(setupAnswers(plan.planId)))
  const outcome = parseOnlyJson(run(['setup', '--apply', '--json', '--answers', answersFile]))
  const credentialsFile = path.join(dshHome, '.credentials.yaml')
  const originalCredentials = [
    'version: 1',
    'refs:',
    '  DINGTALK_CLIENT_ID: private-app',
    '  DINGTALK_CLIENT_SECRET: must-not-appear',
    'records:',
    '  private/route:',
    '    kind: api-key',
    '    key: DINGTALK_CLIENT_SECRET',
    '',
  ].join('\n')
  await writeFile(credentialsFile, originalCredentials, { mode: 0o600 })

  const privateResume = runPty(['setup', '--resume', outcome.checkpointId])

  assert.equal(privateResume.status, 1)
  const terminalOutput = privateResume.stdout + privateResume.stderr
  assert.match(terminalOutput, /请先升级 DSH/)
  assert.doesNotMatch(terminalOutput, /无法恢复该 setup checkpoint|must-not-appear|private\/route/)
  assert.doesNotMatch(terminalOutput, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(await readFile(credentialsFile, 'utf8'), originalCredentials)
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
