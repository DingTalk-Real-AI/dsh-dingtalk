#!/usr/bin/env node
// 仅由隔离生命周期测试放入 PATH；模拟严格 released 协议，不访问远端或真实 Profile。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const profile = args[args.indexOf('--profile') + 1]
const dir = path.join(process.env.DSH_HOME, profile.split(':')[1])
fs.mkdirSync(dir, { recursive: true })
const file = (name) => path.join(dir, name)
const record = (operation) => fs.appendFileSync(file('operations'), `${operation}\n`)
const envelope = (data) => process.stdout.write(JSON.stringify({ ok: true, outcome: 'success', data, meta: {} }))
if (args.includes('--local-lease')) {
  fs.writeFileSync(file('guard'), String(process.pid), { flag: 'wx' })
  record('leased')
  process.stderr.write('[employee] leased\n')
  let input = ''
  process.stdin.on('data', (chunk) => (input += chunk))
  process.stdin.on('end', () => {
    assert.equal(input, 'released\n', 'EOF 不能代替释放确认')
    assert.equal(fs.existsSync(file('consumer-active')), false, 'Consumer 必须先退出')
    assert.equal(fs.existsSync(file('reply-active')), false, '下行调用必须先完成')
    fs.unlinkSync(file('guard'))
    record('released')
  })
} else if (args.includes('capabilities')) {
  envelope({
    schemaVersion: 1,
    protocolVersion: 1,
    auditMode: 'local_required',
    capabilities: { eventConsume: true, replyStdin: true, operatorPrivateStdin: true },
  })
} else if (args.includes('consume')) {
  fs.writeFileSync(file('consumer-active'), String(process.pid), { flag: 'wx' })
  record('consumer-ready')
  process.stderr.write('[event] ready event_count=0 bus_pid=123\n')
  process.stdout.write(
    JSON.stringify({
      type: 'user_im_message_receive_o2o_all',
      event_id: 'fixture-event',
      message_id: 'fixture-message',
      conversation_id: 'fixture-conversation',
      sender_open_dingtalk_id: 'fixture-operator',
      content: '/help',
      event_time: '1',
    }) + '\n',
  )
  process.stdin.resume()
  process.stdin.on('end', () => {
    fs.unlinkSync(file('consumer-active'))
    record('consumer-stopped')
  })
} else {
  let input = ''
  process.stdin.on('data', (chunk) => (input += chunk))
  process.stdin.on('end', () => {
    const value = JSON.parse(input)
    if (args.includes('binding')) {
      envelope({ ...value, dwsProfile: profile, channel: 'dsh', bindingState: 'bound', desiredState: 'running' })
    } else if (args.includes('reply')) {
      const firstReply = !fs.readFileSync(file('operations'), 'utf8').includes('reply-started')
      fs.writeFileSync(file('reply-text'), value.text)
      fs.writeFileSync(file('reply-active'), String(process.pid), { flag: 'wx' })
      record('reply-started')
      const finish = () => {
        fs.unlinkSync(file('reply-active'))
        record('reply-completed')
        envelope({
          openMessageId: 'fixture-outgoing',
          conversationId: value.conversationId,
          idempotencyKey: value.idempotencyKey,
          deliveryStatus: 'delivered',
        })
      }
      // 首次下行用显式屏障，避免双员工的 300ms 窗口不重叠导致误报超时。
      const release = () => {
        if (firstReply && !fs.existsSync(file('reply-release'))) return setTimeout(release, 10)
        setTimeout(finish, 300)
      }
      release()
    } else {
      throw new Error('unexpected_fixture_command')
    }
  })
}
