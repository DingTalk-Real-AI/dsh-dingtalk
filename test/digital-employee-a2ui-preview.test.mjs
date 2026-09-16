import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { employeeA2ui } from '../lib/digital-employee-a2ui.js'

const pause = () => new Promise((resolve) => setTimeout(resolve, 10))

test(
  '真实 CLI 边界：发送和更新携带摘要注解，等待态不重置表单，快速提交不会被等待态覆盖',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-a2ui-preview-'))
    const executable = path.join(root, 'dws')
    const logfile = path.join(root, 'calls.jsonl')
    await copyFile(new URL('./fixtures/a2ui-dws.cjs', import.meta.url), executable)
    await chmod(executable, 0o755)
    const old = {
      PATH: process.env.PATH,
      A2UI_FIXTURE_LOG: process.env.A2UI_FIXTURE_LOG,
      A2UI_FIXTURE_SLOW: process.env.A2UI_FIXTURE_SLOW,
    }
    Object.assign(process.env, {
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      A2UI_FIXTURE_LOG: logfile,
      A2UI_FIXTURE_SLOW: '1',
    })
    const logs = []
    const adapter = employeeA2ui(
      {
        agentUuid: 'fixture-agent',
        bindingRevision: 1,
        dwsProfile: 'fixture:employee',
        operatorOpenDingTalkId: 'fixture-operator',
      },
      10000,
      (line) => logs.push(line),
    )
    t.after(async () => {
      adapter.close()
      await adapter.drain()
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    })
    const listeners = new Map()
    const agent = { id: 'fixture-session' }
    adapter.bindSession(agent.id)
    adapter.install({
      agent,
      on(name, listener) {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    })
    const answer = listeners.get('user-questions/request')(
      { agent, questions: [{ id: 'note', question: '填写备注' }] },
      () => assert.fail('不应回退'),
    )
    void answer.catch(() => {})
    let calls = []
    for (let i = 0; i < 300 && calls.length < 2; i++) {
      await pause()
      calls = await readFile(logfile, 'utf8')
        .then((data) => data.trim().split('\n').map(JSON.parse))
        .catch(() => [])
    }
    assert.equal(calls.length, 2)
    const flag = (args, name) => args[args.indexOf(name) + 1]
    assert.ok(calls[0].includes('--summary'))
    assert.equal(flag(calls[0], '--summary'), '等待你填写回答')
    const messages = (args) => JSON.parse(flag(args, '--content')).map(JSON.parse)
    const components = messages(calls[0]).find((m) => m.updateComponents).updateComponents.components
    const interactionId = components.find((c) => c.id === 'submit').action.event.context.interactionId
    assert.equal(flag(calls[1], '--flow-status'), 'CONFIRMING')
    assert.equal(messages(calls[1])[0].updateComponents.components[0].content, '## 填写备注')
    assert.equal(
      messages(calls[1]).some((m) => m.updateDataModel),
      false,
    )
    adapter.handleEvent({
      type: 'user_card_action_triggered',
      payload: {
        body: {
          bizInfoDTO: { bizId: 'fixture-biz' },
          operatorDTO: { openDingTalkId: 'fixture-operator' },
          a2uiEvent: {
            action: {
              context: { interactionId, action: 'submit', answers: { q0: { selected: [], custom: '私有回答' } } },
            },
          },
        },
      },
    })
    assert.deepEqual(await answer, { answers: [{ id: 'note', selected: [], custom: '私有回答' }] })
    await adapter.drain()
    calls = (await readFile(logfile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.length, 3)
    assert.equal(flag(calls[2], '--flow-status'), 'FINISH')
    for (const args of calls) {
      assert.equal(flag(args, '--profile'), 'fixture:employee')
      const annotation = JSON.parse(flag(args, '--a2ui-annotations'))
      assert.equal(annotation.length, 1)
      assert.equal(annotation[0].type, 'artifact')
      assert.equal(annotation[0].componentId, 'title')
      const update = messages(args).find((m) => m.updateComponents).updateComponents
      assert.equal(annotation[0].surfaceId, update.surfaceId)
      assert.ok(update.components.some((c) => c.id === annotation[0].componentId))
    }
    const title = messages(calls[2])[0].updateComponents.components.find((c) => c.id === 'title')
    assert.equal(title.content, '## 已提交')
    assert.ok(logs.includes('a2ui callback accepted=true'))
    assert.ok(logs.includes('a2ui state update accepted: answered'))
  },
)
