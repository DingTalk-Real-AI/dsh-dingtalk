import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { serveEmployeeControl, requestEmployeeControl, parseEmployeeControl } from '../lib/digital-employee-control.js'

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
