import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { OwnerBinding, issueBindingChallenge } from '../lib/owner.js'

function inbound(overrides = {}) {
  return {
    conversationId: 'dm-1',
    conversationType: 'direct',
    senderStaffId: 'owner-1',
    text: 'hello',
    ...overrides,
  }
}

test('一次性挑战绑定唯一管理员且磁盘不保存明文验证码', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-owner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'owner.json')
  // Connector 已经运行时，setup 是另一个进程；绑定器必须观察到外部写入。
  const binding = new OwnerBinding({
    file,
    configuredOwner: '',
    legacyAllowedSenders: [],
    allowedGroups: ['group-1'],
  })
  const challenge = issueBindingChallenge(file, 60_000)
  const storedBefore = await readFile(file, 'utf8')
  assert.equal(storedBefore.includes(challenge.code), false)
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0)

  assert.deepEqual(binding.authorize(inbound({ text: `/bind ${challenge.code}` })), {
    kind: 'bound',
    ownerStaffId: 'owner-1',
  })
  assert.equal(binding.authorize(inbound()).kind, 'allowed')
  assert.equal(binding.authorize(inbound({ senderStaffId: 'other' })).kind, 'denied')
  assert.equal(
    binding.authorize(
      inbound({
        conversationId: 'group-1',
        conversationType: 'group',
      }),
    ).kind,
    'allowed',
  )
  assert.equal(
    binding.authorize(
      inbound({
        conversationId: 'group-2',
        conversationType: 'group',
      }),
    ).kind,
    'denied',
  )
})

test('未绑定、过期或群聊中的绑定请求均保持拒绝', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-owner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'owner.json')
  const challenge = issueBindingChallenge(file, 1, 100)
  const binding = new OwnerBinding({
    file,
    configuredOwner: '',
    legacyAllowedSenders: [],
    allowedGroups: [],
    now: () => 102,
  })

  assert.equal(binding.authorize(inbound({ text: `/bind ${challenge.code}` })).kind, 'denied')
  assert.equal(
    binding.authorize(
      inbound({
        conversationType: 'group',
        text: `/bind ${challenge.code}`,
      }),
    ).kind,
    'denied',
  )
  assert.equal(binding.authorize(inbound()).kind, 'denied')
})

test('全开放策略允许其他 sender 私聊和所有群聊', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-owner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const binding = new OwnerBinding({
    file: path.join(dir, 'owner.json'),
    configuredOwner: 'owner-1',
    legacyAllowedSenders: [],
    senderAccess: 'all',
    allowedSenders: [],
    groupAccess: 'all',
    allowedGroups: [],
  })

  assert.equal(binding.authorize(inbound({ senderStaffId: 'other' })).kind, 'allowed')
  assert.equal(
    binding.authorize(inbound({ conversationId: 'group-any', conversationType: 'group', senderStaffId: 'other' })).kind,
    'allowed',
  )
})

test('白名单策略同时限制 sender 和群聊', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-owner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const binding = new OwnerBinding({
    file: path.join(dir, 'owner.json'),
    configuredOwner: 'owner-1',
    legacyAllowedSenders: [],
    senderAccess: 'allowlist',
    allowedSenders: ['member-1'],
    groupAccess: 'allowlist',
    allowedGroups: ['group-1'],
  })

  assert.equal(binding.authorize(inbound({ senderStaffId: 'member-1' })).kind, 'allowed')
  assert.equal(binding.authorize(inbound({ senderStaffId: 'member-2' })).kind, 'denied')
  assert.equal(
    binding.authorize(inbound({ conversationId: 'group-1', conversationType: 'group', senderStaffId: 'member-1' }))
      .kind,
    'allowed',
  )
  assert.equal(
    binding.authorize(inbound({ conversationId: 'group-2', conversationType: 'group', senderStaffId: 'member-1' }))
      .kind,
    'denied',
  )
  assert.equal(
    binding.authorize(inbound({ conversationId: 'group-1', conversationType: 'group', senderStaffId: 'member-2' }))
      .kind,
    'denied',
  )
})

test('单成员白名单不会被旧配置迁移成管理员', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-owner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const binding = new OwnerBinding({
    file: path.join(dir, 'owner.json'),
    configuredOwner: '',
    legacyAllowedSenders: ['member-1'],
    senderAccess: 'allowlist',
    allowedSenders: ['member-1'],
    groupAccess: 'none',
    allowedGroups: [],
  })

  assert.equal(binding.status().bound, false)
  assert.equal(binding.authorize(inbound({ senderStaffId: 'member-1' })).kind, 'denied')
})
