import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME
if (!dshHome) throw new Error('DSH_HOME is required for the packed DSH smoke')
const stateDir = process.env.DSH_DINGTALK_STATE_DIR
if (!stateDir) throw new Error('DSH_DINGTALK_STATE_DIR is required for the packed DSH smoke')

function setupFailureMessage(result) {
  const reason = result.error?.code ? `error=${result.error.code}` : `exit=${result.status ?? 'unknown'}`
  const signal = result.signal ? ` signal=${result.signal}` : ''
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .replaceAll('smoke-client-secret', '<redacted-client-secret>')
    .replace(/\/bind\s+[A-Z0-9]{6,}/gu, '/bind <redacted>')
    .trim()
  const tail = output.length > 2_000 ? `…${output.slice(-2_000)}` : output
  return `Packed public setup failed before the DSH boot smoke (${reason}${signal})${tail ? `\n${tail}` : ''}`
}

const which = spawnSync('which', ['dsh'], { encoding: 'utf8', env: process.env })
const realDsh = which.status === 0 ? which.stdout.trim() : ''
if (!realDsh) throw new Error('Unable to resolve the installed DSH binary')
const wrapperRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-smoke-bin-'))
try {
  const wrapper = path.join(wrapperRoot, 'dsh')
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === 'plugin' && args.includes('add')) process.exit(0)
const result = spawnSync(${JSON.stringify(realDsh)}, args, { env: process.env, stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
    { mode: 0o755 },
  )
  await chmod(wrapper, 0o755)
  const packedBin = path.join(
    dshHome,
    'profiles',
    'web',
    'node_modules',
    '@dingtalk-real-ai',
    'dsh-dingtalk',
    'lib',
    'bin.js',
  )
  const setup = spawnSync(process.execPath, [packedBin, 'setup'], {
    encoding: 'utf8',
    input: ['2', 'smoke-client-id', 'smoke-client-secret', '', '', '', '', 'n'].join('\n'),
    timeout: 30_000,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_DINGTALK_STATE_DIR: stateDir,
      PATH: `${wrapperRoot}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  })
  if (setup.status !== 0) throw new Error(setupFailureMessage(setup))
} finally {
  await rm(wrapperRoot, { recursive: true, force: true })
}

const port = process.env.DSH_SMOKE_PORT ?? '39877'
const child = spawn(realDsh, ['web', '--port', port], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let settled = false

const finish = (error) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  if (!child.killed) child.kill('SIGTERM')
  if (error) {
    console.error(output)
    console.error(error.message)
    process.exitCode = 1
  } else {
    console.log('DSH web packed-plugin smoke passed')
  }
}

const inspect = (data) => {
  output += String(data)
  if (/dsh web:|https?:\/\/127\.0\.0\.1|channel up:/.test(output)) finish()
}

child.stdout.on('data', inspect)
child.stderr.on('data', inspect)
child.on('error', (error) => finish(error))
child.on('exit', (code) => {
  if (!settled && code !== 0) finish(new Error(`dsh web exited before readiness (code ${code})`))
})

const timer = setTimeout(() => finish(new Error('dsh web readiness timeout after 30 seconds')), 30_000)
