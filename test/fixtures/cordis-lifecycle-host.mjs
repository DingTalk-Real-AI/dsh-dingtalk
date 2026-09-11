import assert from 'node:assert/strict'
import path from 'node:path'
import { copyFile, mkdir, chmod, readFile, readdir, writeFile, access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { EventEmitter } from 'node:events'
import { DWClient } from 'dingtalk-stream'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../../lib/index.js'
import { requestEmployeeControl, serveEmployeeControl } from '../../lib/digital-employee-control.js'

const [dir, mode = 'root'] = process.argv.slice(2)
process.env.DSH_HOME = path.join(dir, 'home')
process.env.DSH_DINGTALK_STATE_DIR = path.join(dir, 'state')
const root = new Context()
root.provide('agents', {})
root.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) })
root.provide('credentials', { resolve: async () => undefined })
root.provide('llm', {})
const config = {
  accounts: [{ id: 'disabled-fixture', enabled: false }],
  digitalEmployees: [],
  workspace: path.join(dir, 'workspace'),
  tools: { enabled: false },
}
const employeeIds = ['fixture-a', 'fixture-b']
async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return
    await delay(10)
  }
  assert.fail(`fixture ${mode} 等待超时`)
}
async function assertReleased(count) {
  for (const id of employeeIds) {
    const employeeDir = path.join(process.env.DSH_HOME, id)
    const operations = (await readFile(path.join(employeeDir, 'operations'), 'utf8')).trim().split('\n')
    assert.equal(operations.filter((operation) => operation === 'released').length, count)
    assert.equal(await exists(path.join(employeeDir, 'guard')), false)
    assert.equal(await exists(path.join(employeeDir, 'consumer-active')), false)
    assert.equal(await exists(path.join(employeeDir, 'reply-active')), false)
  }
}
const identity = {
  protocolVersion: 1,
  action: 'status',
  agentUuid: 'fixture',
  dwsProfile: 'corp:fixture',
  bindingRevision: 1,
}
let replacement
let unlockRobot
let robotEntered = false
let robotStops = 0
let code = 0
try {
  if (['reload', 'SIGTERM', 'SIGINT'].includes(mode)) {
    const bin = path.join(dir, 'bin')
    await mkdir(bin)
    await writeFile(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    await copyFile(new URL('./lifecycle-dws.cjs', import.meta.url), path.join(bin, 'dws'))
    await chmod(path.join(bin, 'dws'), 0o755)
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    config.digitalEmployees = employeeIds.map((id) => ({
      agentUuid: id,
      name: id,
      dwsProfile: `fixture-corp:${id}`,
      enabled: true,
      operatorOpenDingTalkId: 'fixture-operator',
      allowedDirectSenders: [],
      allowedGroups: [],
      sessionScope: 'chat-sender',
      bindingRevision: 1,
      protocolVersion: 1,
    }))
  }
  if (mode === 'slow-control') replacement = await serveEmployeeControl(async () => ({ fixture: true }))
  if (mode === 'slow-robot') {
    const connected = new Promise((resolve) => (unlockRobot = resolve))
    DWClient.prototype.connect = async function () {
      robotEntered = true
      await connected
      this.socket = new EventEmitter()
      this.socket.readyState = 1
      this.socket.ping = () => {}
    }
    DWClient.prototype.disconnect = function () {
      robotStops++
      this.socket.readyState = 3
    }
    config.accounts = [{ id: 'fixture-robot', clientId: 'fixture-client', clientSecret: 'fixture-secret' }]
  }
  const fiber = root.plugin(plugin, config)
  if (mode === 'slow-control' || mode === 'slow-robot') {
    await waitFor(async () =>
      mode === 'slow-robot'
        ? robotEntered
        : (await readdir(process.env.DSH_DINGTALK_STATE_DIR)).filter((name) => name.includes('.owner.')).length === 2,
    )
    let disposed = false
    const stopping = root.fiber.dispose().then(() => (disposed = true))
    await delay(30)
    assert.equal(disposed, false, '卸载必须等待仍在获取中的资源')
    if (mode === 'slow-control') {
      await replacement.close()
      replacement = undefined
    } else unlockRobot()
    await stopping
    if (mode === 'slow-robot') assert.equal(robotStops, 1)
  } else {
    await fiber.await()
    assert.equal((await requestEmployeeControl(identity)).runtimeState, 'stopped')
    if (config.digitalEmployees.length) {
      for (const employee of config.digitalEmployees) {
        assert.equal(
          (await requestEmployeeControl({ ...identity, ...employeeIdentity(employee) })).transportReady,
          true,
        )
      }
      await waitFor(async () =>
        (await Promise.all(employeeIds.map((id) => exists(path.join(process.env.DSH_HOME, id, 'reply-active'))))).every(
          Boolean,
        ),
      )
    }
    if (mode === 'reload') {
      await fiber.restart()
      for (const employee of config.digitalEmployees) {
        assert.equal(
          (await requestEmployeeControl({ ...identity, ...employeeIdentity(employee) })).transportReady,
          true,
        )
        const operations = await readFile(path.join(process.env.DSH_HOME, employee.agentUuid, 'operations'), 'utf8')
        assert.equal(operations.split('\n').filter((operation) => operation === 'leased').length, 2)
        assert.equal(operations.split('\n').filter((operation) => operation === 'released').length, 1)
      }
    }
    if (mode.startsWith('SIG')) {
      await new Promise((resolve, reject) => {
        process.once(mode, () => root.fiber.dispose().then(resolve, reject))
        process.kill(process.pid, mode)
      })
    } else await root.fiber.dispose()
    if (config.digitalEmployees.length) await assertReleased(mode === 'reload' ? 2 : 1)
  }
  await root.fiber.dispose()
  if (mode === 'slow-robot') assert.equal(robotStops, 1, '重复卸载不能重复断开连接')
  await assert.rejects(requestEmployeeControl(identity), '卸载后旧控制入口必须不可用')
  replacement = await serveEmployeeControl(async () => ({ released: true }))
  assert.equal((await requestEmployeeControl(identity)).released, true, '旧入口释放后应可重新初始化')
} catch (error) {
  code = 1
  console.error(error)
} finally {
  await replacement?.close()
  await root.fiber.dispose()
  // 旧版本可能泄漏 socket；隔离子进程退出，不能让红测试拖住整个 test runner。
  process.exit(code)
}

function employeeIdentity(employee) {
  return { agentUuid: employee.agentUuid, dwsProfile: employee.dwsProfile, bindingRevision: employee.bindingRevision }
}
