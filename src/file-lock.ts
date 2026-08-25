import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

interface FileLockOwner {
  pid: number
  token: string
  ownerFile: string
}

export interface RecoverableFileLockOptions {
  label?: string
  timeoutMs?: number
}

function parseOwner(value: string, lockFile: string): FileLockOwner | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { pid, token, ownerFile } = parsed as Record<string, unknown>
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof token !== 'string' || !UUID_V4_RE.test(token)) {
    return undefined
  }
  const expectedOwnerFile = `${path.basename(lockFile)}.owner.${String(pid)}.${token}`
  if (ownerFile !== expectedOwnerFile) return undefined
  return { pid: pid as number, token, ownerFile: expectedOwnerFile }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function reclaimDeadOwner(lockFile: string): Promise<boolean> {
  let lockValue: string
  try {
    lockValue = await readFile(lockFile, 'utf8')
  } catch {
    return false
  }
  const owner = parseOwner(lockValue, lockFile)
  if (!owner || processIsAlive(owner.pid)) return false
  const ownerFile = path.join(path.dirname(lockFile), owner.ownerFile)
  try {
    if ((await readFile(ownerFile, 'utf8')) !== lockValue) return false
    await unlink(ownerFile)
  } catch {
    return false
  }

  // 唯一 owner hard link 是回收权令牌；canonical link 保持存在，直到回收者将它删除。
  try {
    if ((await readFile(lockFile, 'utf8')) !== lockValue) return false
    await unlink(lockFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  return true
}

/**
 * 用 canonical hard link 和唯一 owner link 串行化跨进程写入。
 *
 * 死进程回收时，只有成功删除唯一 owner link 的 waiter 才能删除 canonical link；
 * 因此多个 waiter 不会误删刚创建的新锁。若回收者恰好在两次 unlink 之间崩溃，
 * 后续调用会安全超时而不是破坏互斥。
 */
export async function withRecoverableFileLock<T>(
  lockFile: string,
  operation: () => Promise<T>,
  options: RecoverableFileLockOptions = {},
): Promise<T> {
  await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const ownerFile = path.join(path.dirname(lockFile), `${path.basename(lockFile)}.owner.${process.pid}.${token}`)
  const lockValue = `${JSON.stringify({ pid: process.pid, token, ownerFile: path.basename(ownerFile) })}\n`
  await writeFile(ownerFile, lockValue, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let delay = 20
  let acquired = false
  try {
    for (;;) {
      try {
        await link(ownerFile, lockFile)
        acquired = true
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM') throw error
        if (await reclaimDeadOwner(lockFile)) continue
      }
      if (Date.now() >= deadline) throw new Error(`等待${options.label ?? '文件'}执行锁超时`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 200)
    }
    return await operation()
  } finally {
    if (acquired) {
      try {
        if ((await readFile(lockFile, 'utf8')) === lockValue) await unlink(lockFile)
      } catch {
        // canonical lock 不存在或已不属于本 owner；不可删除其他 owner。
      }
    }
    await rm(ownerFile, { force: true })
  }
}
