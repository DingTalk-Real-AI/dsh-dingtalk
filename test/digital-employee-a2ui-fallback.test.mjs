import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { employeeA2ui } from '../lib/digital-employee-a2ui.js'
import { DigitalEmployeeApprovalManager } from '../lib/digital-employee-renderer.js'
import { Config } from '../lib/config.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const event = { eventId: 'input', conversationType: 'group', conversationId: 'group-1', senderOpenDingTalkId: 'asker' }
const questions = [{ id: 'mode', question: '选择模式', options: [{ label: '安全' }, { label: '普通' }] }]
const flag = (args, name) => args[args.indexOf(name) + 1]

async function harness(t, mode, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a2ui-fallback-'))
  const command = path.join(root, 'dws')
  const logfile = path.join(root, 'calls.jsonl')
  await copyFile(new URL('./fixtures/a2ui-dws.cjs', import.meta.url), command)
  await chmod(command, 0o755)
  const keys = ['PATH', 'A2UI_FIXTURE_LOG', 'A2UI_FIXTURE_MODE']
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
    A2UI_FIXTURE_LOG: logfile,
    A2UI_FIXTURE_MODE: mode,
  })
  const employee = { agentUuid: 'fixture-agent', dwsProfile: 'fixture:employee', operatorOpenDingTalkId: 'operator' }
  const logs = [],
    texts = [],
    audits = []
  const sink = {
    async reply(...args) {
      texts.push(args)
      return { deliveryStatus: 'delivered' }
    },
    async operatorPrivate(...args) {
      texts.push(args)
      return { deliveryStatus: 'delivered' }
    },
    async audit(fields) {
      audits.push(fields)
    },
  }
  const ctx = new Context()
  let agent
  const scoped = ctx.extend({
    get agent() {
      return agent
    },
  })
  agent = { id: 'session', ctx: scoped }
  const fallback = new DigitalEmployeeApprovalManager(sink, 'operator', 2000, () => {})
  const adapter = employeeA2ui(employee, options.timeoutMs ?? 2000, (line) => logs.push(line), {
    audit: sink.audit,
    ...options,
  })
  let webCalls = 0
  ctx.on('approval/request', () => {
    webCalls++
    return 'allowed-once'
  })
  ctx.on('user-questions/request', () => {
    webCalls++
    return { answers: [] }
  })
  fallback.bindSession(agent.id, event)
  adapter.bindSession(agent.id, event)
  fallback.install(scoped)
  adapter.install(scoped)
  fallback.install(scoped)
  adapter.install(scoped)
  t.after(async () => {
    adapter.close()
    fallback.close()
    await adapter.drain()
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key]
      else process.env[key] = old[key]
    }
    await rm(root, { recursive: true, force: true })
  })
  const calls = async () =>
    (await readFile(logfile, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter((args) => !args.includes('--help'))
  const sent = async () => {
    for (let i = 0; i < 200; i++) {
      const records = await calls()
      if (records.some((args) => args.includes('update-a2ui-card'))) {
        const args = records.find((args) => args.includes('send-a2ui-card'))
        const components = JSON.parse(flag(args, '--content'))
          .map(JSON.parse)
          .find((m) => m.updateComponents).updateComponents.components
        const interactionId = components.find((c) => c.action?.event?.context)?.action.event.context.interactionId
        return { args, interactionId }
      }
      await tick()
    }
    assert.fail('卡片未就绪')
  }
  const click = (card, action, operator = 'operator') =>
    adapter.handleEvent({
      type: 'user_card_action_triggered',
      payload: {
        body: {
          bizInfoDTO: { bizId: 'fixture-biz' },
          operatorDTO: { openDingTalkId: operator },
          a2uiEvent: {
            action: {
              context: {
                interactionId: card.interactionId,
                action,
                answers: { q0: { selected: ['option_0'], custom: '' } },
              },
            },
          },
        },
      },
    })
  const approve = (signal) =>
    ctx.waterfall(agent, 'approval/request', { agent, toolName: 'fixture_tool', signal }, async () => 'unavailable')
  const ask = (signal) =>
    ctx.waterfall(agent, 'user-questions/request', { agent, questions, signal }, async () => ({ answers: [] }))
  return {
    adapter,
    fallback,
    employee,
    texts,
    audits,
    logs,
    calls,
    sent,
    click,
    approve,
    ask,
    webCalls: () => webCalls,
  }
}

test('默认配置优先 A2UI；text 是显式回滚值', () => {
  assert.equal(Config({}).interactionMode, 'auto')
  assert.equal(Config({ interactionMode: 'text' }).interactionMode, 'text')
})

test(
  '能力缺失在发卡前降级，真实 Cordis 链中审批和 ask 均不落入 Web',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const mode of ['no-commands', 'no-summary', 'no-events'])
      await t.test(mode, async (t) => {
        const h = await harness(t, mode)
        assert.equal(await h.adapter.prepare(), false)
        const approval = h.approve()
        while (!h.texts.length) await tick()
        const code = h.texts[0][0].match(/确认 ([A-F0-9]{6})/)[1]
        assert.equal(
          await h.fallback.handleInbound({
            event: { ...event, conversationType: 'direct', senderOpenDingTalkId: 'stranger', text: `确认 ${code}` },
          }),
          false,
        )
        assert.equal(
          await h.fallback.handleInbound({
            event: { ...event, conversationType: 'direct', senderOpenDingTalkId: 'operator', text: `确认 ${code}` },
          }),
          true,
        )
        assert.equal(await approval, 'allowed-once')
        const answer = h.ask()
        while (h.texts.length < 2) await tick()
        assert.equal(await h.fallback.handleInbound({ event: { ...event, text: '2' } }), true)
        assert.deepEqual(await answer, { answers: [{ id: 'mode', selected: ['普通'] }] })
        assert.equal(h.webCalls(), 0)
        assert.deepEqual(await h.calls(), [])
      })
  },
)

test(
  '能力可用时默认卡片：ask 发原群、仅原提问人回答，approve 发 operator 私聊',
  { skip: process.platform === 'win32' },
  async (t) => {
    const h = await harness(t, '')
    assert.equal(await h.adapter.prepare(), true)
    h.adapter.setConnected(true)
    const answer = h.ask()
    void answer.catch(() => {})
    const card = await h.sent()
    assert.equal(flag(card.args, '--conversation-id'), 'group-1')
    h.click(card, 'submit', 'operator')
    assert.ok(h.logs.includes('a2ui callback accepted=false'))
    h.click(card, 'submit', 'asker')
    assert.deepEqual(await answer, { answers: [{ id: 'mode', selected: ['安全'] }] })
    h.click(card, 'submit', 'asker')
    assert.equal(h.logs.at(-1), 'a2ui callback accepted=false')
    const approval = h.approve()
    let second
    for (let i = 0; i < 200; i++) {
      const sends = (await h.calls()).filter((args) => args.includes('send-a2ui-card'))
      if (sends.length === 2) {
        second = sends[1]
        break
      }
      await tick()
    }
    assert.ok(second)
    assert.equal(flag(second, '--open-dingtalk-id'), 'operator')
    await tick()
    await tick()
    const components = JSON.parse(flag(second, '--content'))
      .map(JSON.parse)
      .find((m) => m.updateComponents).updateComponents.components
    const interactionId = components.find((c) => c.action?.event?.context)?.action.event.context.interactionId
    h.click({ interactionId }, 'approve_once')
    assert.equal(await approval, 'allowed-once')
    assert.equal(h.texts.length, 0)
    assert.equal(h.webCalls(), 0)
    assert.ok(h.audits.some((a) => a.operationType === 'approval_response' && a.status === 'allowed-once'))
  },
)

test('发卡超时/未知结果不重发，不降级到文字或 Web', { skip: process.platform === 'win32' }, async (t) => {
  const h = await harness(t, 'unknown-send')
  assert.equal(await h.adapter.prepare(), true)
  h.adapter.setConnected(true)
  assert.equal(await h.approve(), 'unavailable')
  await assert.rejects(h.ask(), /a2ui_question_unavailable/)
  assert.equal((await h.calls()).filter((args) => args.includes('send-a2ui-card')).length, 2)
  assert.equal(h.texts.length, 0)
  assert.equal(h.webCalls(), 0)
})

test('卡片取消、失效、离线和权限改变都不能触发文字审批', { skip: process.platform === 'win32' }, async (t) => {
  const h = await harness(t, '')
  await h.adapter.prepare()
  assert.equal(await h.approve(), 'unavailable')
  h.adapter.setConnected(true)
  const abort = new AbortController()
  const pending = h.approve(abort.signal)
  const card = await h.sent()
  abort.abort()
  assert.equal(await pending, 'cancelled')
  h.click(card, 'approve_once')
  assert.equal(h.logs.at(-1), 'a2ui callback accepted=false')
  h.employee.operatorOpenDingTalkId = 'new-operator'
  assert.equal(await h.approve(), 'unavailable')
  assert.equal(h.texts.length, 0)
  assert.equal(h.webCalls(), 0)
})

test('审批审计失败即拒绝，不发送卡片、不回退', { skip: process.platform === 'win32' }, async (t) => {
  const h = await harness(t, '', {
    audit: async () => {
      throw new Error('unwritable')
    },
  })
  await h.adapter.prepare()
  h.adapter.setConnected(true)
  assert.equal(await h.approve(), 'unavailable')
  assert.deepEqual(await h.calls(), [])
  assert.equal(h.texts.length, 0)
  assert.equal(h.webCalls(), 0)
})
