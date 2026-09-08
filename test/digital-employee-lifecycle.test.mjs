import test from 'node:test'
import assert from 'node:assert/strict'
import { EmployeeRuntimeRegistry } from '../lib/digital-employee-lifecycle.js'

const employee = (id) => ({ agentUuid: id, dwsProfile: `corp:${id}`, bindingRevision: 1 })
test('close waits for a delayed factory and never starts its late runtime', async () => {
  let finish,
    starts = 0,
    stops = 0
  const registry = new EmployeeRuntimeRegistry(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const a = employee('late')
  const starting = registry.start(a)
  const rejected = assert.rejects(starting, /runtime_start_interrupted/)
  await new Promise((resolve) => setImmediate(resolve))
  const closing = registry.close()
  assert.equal(registry.status(a).runtimeState, 'stopping')
  finish({
    start: async () => {
      starts++
    },
    status: () => ({ state: 'ready' }),
    stop: async () => {
      stops++
    },
  })
  await Promise.all([closing, rejected])
  assert.equal(starts, 0)
  assert.equal(stops, 1)
  assert.equal(registry.status(a).released, true)
})

test('unexpected transport or lease failure is blocked, never reported running', async () => {
  let state = 'ready'
  const registry = new EmployeeRuntimeRegistry(async () => ({ status: () => ({ state }), stop: async () => {} }))
  const a = employee('lost')
  await registry.start(a)
  state = 'failed'
  const status = registry.status(a)
  assert.equal(status.runtimeState, 'blocked')
  assert.equal(status.transportReady, false)
  assert.equal(status.executorReady, false)
  assert.equal(status.released, false)
  assert.equal((await registry.stop(a)).released, true)
})
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

test('a released old revision permits repair of a newer registration without reusing its instance identity', async () => {
  const registry = new EmployeeRuntimeRegistry(async () => ({
    status: () => ({ state: 'ready' }),
    stop: async () => {},
  }))
  const old = employee('round-trip')
  const next = { ...old, bindingRevision: 3 }
  await registry.start(old)
  await assert.rejects(registry.stop(next), /binding_mismatch/)
  const stopped = await registry.stop(old)
  assert.notEqual(stopped.runtimeInstanceId, '')
  const repair = await registry.stop(next)
  assert.equal(repair.released, true)
  assert.equal(repair.runtimeInstanceId, '')
  assert.equal((await registry.start(next)).runtimeState, 'running')
  await registry.close()
})
