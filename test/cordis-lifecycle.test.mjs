import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const execute = promisify(execFile)
async function runFixture(t, mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-cordis-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const result = await execute(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/cordis-lifecycle-host.mjs', import.meta.url)), dir, mode],
    {
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    },
  )
  assert.equal(result.stderr, '')
}

for (const [mode, title] of [
  ['root', '真实 Cordis 根卸载释放插件控制入口，允许同目录重新初始化'],
  ['reload', '真实 Cordis 重载等待双员工下行完成并释放租约，再启动无重叠'],
  ['SIGTERM', 'SIGTERM 退出等待双员工严格 released 确认'],
  ['SIGINT', 'SIGINT 退出等待双员工严格 released 确认'],
  ['owned-SIGTERM', 'SIGTERM 在宿主先销毁双员工 Agent 后仍完成严格租约释放'],
  ['owned-SIGINT', 'SIGINT 在宿主先销毁双员工 Agent 后仍完成严格租约释放'],
  ['slow-control', '控制入口尚在获取时卸载，不留下新的控制锁'],
  ['slow-robot', '机器人连接尚未完成时卸载，等待连接完成且仅清理一次'],
  ['preset-missing', '员工工具预设不存在时明确回复配置错误，不向模型注入消息'],
  ['preset-mount', '员工工具预设挂载失败时明确回复配置错误，不向模型注入消息'],
  ['session-conflict', '会话归属冲突向钉钉回复固定错误提示，不静默、不抢占和泄露内部异常'],
]) {
  test(title, { skip: process.platform === 'win32' }, (t) => runFixture(t, mode))
}
