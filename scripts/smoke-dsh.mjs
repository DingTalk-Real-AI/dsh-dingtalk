import { spawn } from 'node:child_process'

const port = process.env.DSH_SMOKE_PORT ?? '39877'
const child = spawn('dsh', ['web', '--port', port], {
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
