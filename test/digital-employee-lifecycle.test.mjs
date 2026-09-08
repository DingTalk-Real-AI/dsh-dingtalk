import test from 'node:test'
import assert from 'node:assert/strict'
import { EmployeeRuntimeRegistry } from '../lib/digital-employee-lifecycle.js'

const employee = (id) => ({ agentUuid: id, dwsProfile: `corp:${id}`, bindingRevision: 1 })
test('employee lifecycle serializes stop/start and never releases before the owned runtime', async () => {
  let finish
  let started = 0
  const registry = new EmployeeRuntimeRegistry(async () => {
    started++
    return {
      status: () => ({ state: 'ready' }),
      stop: () =>
        new Promise((r) => {
          finish = r
        }),
    }
  })
  const a = employee('a'),
    b = employee('b')
  await registry.start(a)
  await registry.start(b)
  const stopping = registry.stop(a)
  await new Promise((r) => setImmediate(r))
  assert.equal(registry.status(a).runtimeState, 'stopping')
  assert.equal(registry.status(b).runtimeState, 'running')
  await assert.rejects(registry.start(a), /runtime_not_released/)
  assert.equal(started, 2)
  finish()
  assert.equal((await stopping).released, true)
  assert.equal(registry.status(a).runtimeState, 'stopped')
})

test('identity mismatch and failed release never permit a replacement', async () => {
  const registry = new EmployeeRuntimeRegistry(async () => ({
    status: () => ({ state: 'ready' }),
    stop: async () => {
      throw Error('busy')
    },
  }))
  const a = employee('a')
  await registry.start(a)
  await assert.rejects(registry.stop({ ...a, bindingRevision: 2 }), /binding_mismatch/)
  await assert.rejects(registry.stop(a), /busy/)
  assert.equal(registry.status(a).runtimeState, 'blocked')
  await assert.rejects(registry.start(a), /runtime_not_released/)
})
