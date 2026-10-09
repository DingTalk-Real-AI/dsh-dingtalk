import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FileTransfer } from '../lib/file-transfer.js'
import { downloadFileByCode, MAX_MEDIA_BYTES } from '../lib/media.js'
import { strictAgentContext } from './helpers/strict-agent-context.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-transfer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('卸载取消并排空进行中的文件回传，旧工具随后不可发送', async (t) => {
  const cwd = await fixture(t)
  await writeFile(path.join(cwd, 'file.pdf'), 'fixture')
  const tools = new Map()
  const scope = strictAgentContext((tool) => {
    tools.set(tool.name, tool)
    return () => tools.delete(tool.name)
  })
  t.after(scope.dispose)
  const agent = { id: 'session', ctx: scope.ctx }
  let started
  const sending = new Promise((resolve) => {
    started = resolve
  })
  const transfer = new FileTransfer({
    accountId: 'fixture',
    outbound: {
      sendMedia(_target, _media, signal) {
        started()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
      },
    },
    log() {},
  })
  transfer.install(scope.ctx, agent)
  transfer.bindSession(agent, { conversationType: 'direct', conversationId: 'chat', senderStaffId: 'user' }, cwd)
  const exec = { agent, signal: new AbortController().signal }
  const pending = tools.get('send_file').execute({ path: 'file.pdf' }, exec)
  const rejected = assert.rejects(pending, /cancelled/)
  await sending
  await transfer.close()
  await rejected
  await assert.rejects(tools.get('send_file').execute({ path: 'file.pdf' }, exec), /route_unavailable/)
})

test('文件下载按响应头与实际流双重限流，失败不泄露下载码或签名地址', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  for (const mode of ['success', 'header', 'stream', 'exchange', 'fetch']) {
    const logs = []
    let cancelled = false
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('messageFiles/download')) {
        assert.deepEqual(JSON.parse(init.body), { downloadCode: 'private-code', robotCode: 'robot' })
        if (mode === 'exchange') return Response.json({ code: 'error' }, { status: 403 })
        return Response.json({ downloadUrl: 'https://fixture.invalid/private-signed-url' })
      }
      assert.equal(init.headers, undefined, 'OSS 下载不能携带应用 Token 或 Content-Type')
      if (mode === 'fetch') throw new Error('private-signed-url')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(mode === 'stream' ? MAX_MEDIA_BYTES + 1 : 3))
            if (mode !== 'stream') controller.close()
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: mode === 'header' ? { 'content-length': String(MAX_MEDIA_BYTES + 1) } : {} },
      )
    }
    const data = await downloadFileByCode('private-token', 'robot', 'private-code', (line) => logs.push(line))
    if (mode === 'success') assert.equal(data.length, 3)
    else assert.equal(data, null)
    if (mode === 'stream' || mode === 'header') assert.equal(cancelled, true)
    assert.doesNotMatch(logs.join('\n'), /private-/)
  }
})

test('接收文件按账号/会话隔离，保留中文名称，同名不覆盖，危险文件名不越界', async (t) => {
  const dir = await fixture(t)
  const transfer = new FileTransfer({ accountId: 'one', outbound: {}, log() {} })
  const first = await transfer.storeInbound(dir, 'chat', '../../报告.pdf', new Uint8Array([1]))
  const second = await transfer.storeInbound(dir, 'chat', '../../报告.pdf', new Uint8Array([2]))
  const otherChat = await transfer.storeInbound(dir, 'other', '报告.pdf', new Uint8Array([3]))
  const otherAccount = await new FileTransfer({ accountId: 'two', outbound: {}, log() {} }).storeInbound(
    dir,
    'chat',
    '报告.pdf',
    new Uint8Array([4]),
  )
  for (const stored of [first, second, otherChat, otherAccount]) {
    assert.equal(path.basename(stored.path), '报告.pdf')
    assert.ok(stored.path.startsWith(dir + path.sep))
  }
  assert.notEqual(first.path, second.path)
  assert.notEqual(path.dirname(path.dirname(first.path)), path.dirname(path.dirname(otherChat.path)))
  assert.notEqual(path.dirname(path.dirname(first.path)), path.dirname(path.dirname(otherAccount.path)))
  assert.deepEqual([...(await readFile(first.path))], [1])
  assert.deepEqual([...(await readFile(second.path))], [2])
})

test('入站目录符号链接和超限内容被拒绝，不向工作区外落盘', async (t) => {
  const dir = await fixture(t)
  const outside = path.join(dir, 'outside'),
    cwd = path.join(dir, 'workspace')
  await mkdir(outside)
  await mkdir(cwd)
  await symlink(outside, path.join(cwd, '.dsh-dingtalk'), process.platform === 'win32' ? 'junction' : 'dir')
  const transfer = new FileTransfer({ accountId: 'one', outbound: {}, log() {} })
  await assert.rejects(transfer.storeInbound(cwd, 'chat', 'file.pdf', new Uint8Array([1])), /unsafe_inbox/)
  assert.deepEqual(await readdir(outside), [])
  await assert.rejects(transfer.storeInbound(cwd, 'chat', 'file.pdf', new Uint8Array(MAX_MEDIA_BYTES + 1)), /too_large/)
})

test('发送工具固定当前会话和工作区，拒绝跨 Agent、越界/符号链接路径及未支持格式', async (t) => {
  const dir = await fixture(t)
  const cwd = path.join(dir, 'workspace'),
    nextCwd = path.join(dir, 'next')
  await mkdir(cwd)
  await mkdir(nextCwd)
  await writeFile(path.join(cwd, '报告.pdf'), 'pdf')
  await writeFile(path.join(nextCwd, '报告.pdf'), 'next')
  await writeFile(path.join(cwd, 'code.ts'), 'fixture')
  await writeFile(path.join(dir, 'outside.pdf'), 'private')
  if (process.platform !== 'win32') await symlink(path.join(dir, 'outside.pdf'), path.join(cwd, 'escape.pdf'))
  const tools = new Map(),
    sent = []
  const scope = strictAgentContext((tool) => {
    assert.ok(!tools.has(tool.name))
    tools.set(tool.name, tool)
    return () => tools.delete(tool.name)
  })
  t.after(scope.dispose)
  const agent = { id: 'session', ctx: scope.ctx }
  const transfer = new FileTransfer({
    accountId: 'one',
    outbound: {
      async sendMedia(target, media) {
        sent.push({ target, media })
        return { status: 'accepted', processQueryKey: 'receipt' }
      },
    },
    log() {},
  })
  transfer.install(scope.ctx, agent)
  transfer.install(scope.ctx, agent)
  assert.deepEqual([...tools.keys()], ['send_file', 'send_image'])
  const exec = { agent, signal: new AbortController().signal }
  await assert.rejects(tools.get('send_file').execute({ path: '报告.pdf' }, exec), /route_unavailable/)
  const msg = { conversationType: 'direct', conversationId: 'one', senderStaffId: 'user' }
  transfer.bindSession(agent, msg, cwd)
  await tools.get('send_file').execute({ path: '报告.pdf' }, exec)
  assert.equal(sent[0].target.senderStaffId, 'user')
  assert.equal(Buffer.from(sent[0].media.data).toString(), 'pdf')
  await assert.rejects(
    tools.get('send_file').execute({ path: '报告.pdf' }, { ...exec, agent: { ...agent } }),
    /agent_mismatch/,
  )
  for (const file of ['../outside.pdf', ...(process.platform === 'win32' ? [] : ['escape.pdf']), 'code.ts']) {
    await assert.rejects(
      tools.get('send_file').execute({ path: file }, exec),
      /outside_workspace|unsupported_file_type/,
    )
  }
  await assert.rejects(tools.get('send_file').execute({ path: '报告.pdf', userId: 'other' }, exec), /invalid_arguments/)
  transfer.bindSession(agent, { ...msg, conversationType: 'group', conversationId: 'two' }, nextCwd)
  await tools.get('send_file').execute({ path: '报告.pdf' }, exec)
  assert.equal(sent[1].target.conversationId, 'two')
  assert.equal(Buffer.from(sent[1].media.data).toString(), 'next')
  const aborted = AbortSignal.abort()
  await assert.rejects(tools.get('send_file').execute({ path: '报告.pdf' }, { agent, signal: aborted }))
  assert.equal(sent.length, 2)
  transfer.close()
  await assert.rejects(tools.get('send_file').execute({ path: '报告.pdf' }, exec), /route_unavailable/)
})
