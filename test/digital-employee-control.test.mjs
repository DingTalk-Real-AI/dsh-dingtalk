import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveEmployeeControl, requestEmployeeControl, parseEmployeeControl } from '../lib/digital-employee-control.js'
import { EmployeeRuntimeRegistry } from '../lib/digital-employee-lifecycle.js'

test(
  'real CLI stdin and private IPC stop only the target employee and preserve the other runtime',
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = await mkdtemp('/tmp/dsh-cli-control-')
    const registry = new EmployeeRuntimeRegistry(async () => ({
      status: () => ({ state: 'ready' }),
      stop: async () => {},
    }))
    const a = { agentUuid: 'a', dwsProfile: 'corp:a', bindingRevision: 1 }
    const b = { agentUuid: 'b', dwsProfile: 'corp:b', bindingRevision: 1 }
    await registry.start(a)
    await registry.start(b)
    const host = await serveEmployeeControl(
      async (input) => (input.action === 'stop' ? registry.stop(input) : registry.status(input)),
      dir,
    )
    t.after(async () => {
      await registry.close()
      await host.close()
      await rm(dir, { recursive: true, force: true })
    })
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../lib/bin.js', import.meta.url)), 'digital-employee', 'runtime', '--stdin', '--json'],
        { env: { ...process.env, DSH_DINGTALK_STATE_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.resume()
      child.once('error', reject)
      child.once('close', (code) => {
        if (code !== 0) reject(Error('CLI failed'))
        else {
          try {
            resolve(JSON.parse(output))
          } catch (error) {
            reject(error)
          }
        }
      })
      child.stdin.end(JSON.stringify({ ...a, protocolVersion: 1, action: 'stop' }))
    })
    assert.equal(result.kind, 'digital_employee_runtime')
    assert.equal(result.agentUuid, 'a')
    assert.equal(result.released, true)
    assert.equal(result.runtimeState, 'stopped')
    assert.equal(registry.status(b).runtimeState, 'running')
  },
)

test(
  'private IPC validates bounded identity and release acknowledgements, refuses a second host',
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = await mkdtemp('/tmp/dsh-control-')
    t.after(() => rm(dir, { recursive: true, force: true }))
    let action
    const host = await serveEmployeeControl(async (input) => {
      action = input.action
      return { ...input, released: true, runtimeState: 'stopped' }
    }, dir)
    t.after(() => host.close())
    const request = {
      protocolVersion: 1,
      action: 'stop',
      agentUuid: 'employee',
      dwsProfile: 'corp:employee',
      bindingRevision: 2,
    }
    assert.equal((await requestEmployeeControl(request, dir)).released, true)
    assert.equal(action, 'stop')
    assert.equal((await stat(dir)).mode & 0o077, 0)
    assert.equal((await stat(`${dir}/employee-control.sock`)).mode & 0o077, 0)
    await assert.rejects(serveEmployeeControl(async () => ({}), dir))
    assert.throws(() => parseEmployeeControl({ ...request, token: 'never-accepted' }), /unknown_control_field/)
    assert.throws(() => parseEmployeeControl({ ...request, bindingRevision: -1 }), /invalid_binding_revision/)
    await host.close()
    await host.close()
    await assert.rejects(requestEmployeeControl(request, dir), /unknown/)
  },
)
