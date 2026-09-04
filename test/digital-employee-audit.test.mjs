import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LocalDigitalEmployeeAuditLog } from '../lib/digital-employee-audit.js'

test('员工级本地审计使用私有 JSONL 且不保存消息正文', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-de-audit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const audit = new LocalDigitalEmployeeAuditLog(root, 'employee-1')

  await Promise.all([
    audit.audit({ eventId: 'event-1', operationType: 'access_check', status: 'accepted' }),
    audit.audit({ eventId: 'event-2', operationType: 'reply', status: 'delivered', replyMessageId: 'message-2' }),
  ])

  const directory = path.join(root, 'audit')
  const file = path.join(directory, 'employee-1.jsonl')
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  const content = await readFile(file, 'utf8')
  const entries = content.trim().split('\n').map(JSON.parse)
  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map((entry) => entry.eventId),
    ['event-1', 'event-2'],
  )
  assert.doesNotMatch(content, /text|content|正文/i)
})
