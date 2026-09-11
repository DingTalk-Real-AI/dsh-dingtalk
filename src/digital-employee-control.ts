import net from 'node:net'
import path from 'node:path'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { withRecoverableFileLock } from './file-lock.js'
import { resolveStateDir } from './paths.js'
import type { EmployeeIdentity } from './digital-employee-lifecycle.js'

export interface EmployeeControlRequest extends EmployeeIdentity {
  protocolVersion: 1
  action: 'prepare' | 'start' | 'status' | 'stop' | 'release'
}
const LIMIT = 64 * 1024

export function parseEmployeeControl(value: unknown): EmployeeControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_control')
  const raw = value as Record<string, unknown>
  if (
    Object.keys(raw).some(
      (key) => !['protocolVersion', 'action', 'agentUuid', 'dwsProfile', 'bindingRevision'].includes(key),
    )
  )
    throw new Error('unknown_control_field')
  if (raw.protocolVersion !== 1 || !['prepare', 'start', 'status', 'stop', 'release'].includes(String(raw.action)))
    throw new Error('unsupported_control')
  if (typeof raw.agentUuid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.agentUuid))
    throw new Error('invalid_agent_uuid')
  if (typeof raw.dwsProfile !== 'string' || raw.dwsProfile.length > 256 || !/^[^\s:]+:[^\s:]+$/.test(raw.dwsProfile))
    throw new Error('invalid_dws_profile')
  if (!Number.isSafeInteger(raw.bindingRevision) || Number(raw.bindingRevision) < 0)
    throw new Error('invalid_binding_revision')
  return raw as unknown as EmployeeControlRequest
}

function socketPath(dir: string): string {
  return path.join(dir, 'employee-control.sock')
}

async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
    throw new Error('unsafe_control_directory')
  await chmod(dir, 0o700)
}

/** 私有 Unix socket 是宿主释放确认边界；已有 socket 不删除、不猜测进程归属。 */
export async function serveEmployeeControl(
  handler: (input: EmployeeControlRequest) => Promise<unknown>,
  dir = resolveStateDir(),
) {
  if (process.platform === 'win32') throw new Error('employee_control_unsupported_platform')
  await privateDirectory(dir)
  let accept!: (value: { close(): Promise<void> }) => void
  let reject!: (error: unknown) => void
  const ready = new Promise<{ close(): Promise<void> }>((resolve, fail) => {
    accept = resolve
    reject = fail
  })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const lifetime = withRecoverableFileLock(
    path.join(dir, 'employee-control.lock'),
    async () => {
      await removeStaleSocket(dir)
      const control = await openEmployeeControl(handler, dir)
      let closing: Promise<void> | undefined
      accept({
        close: () =>
          (closing ??= (async () => {
            await control.close()
            finish()
            await lifetime
          })()),
      })
      await finished
    },
    { timeoutMs: 1500, label: '员工宿主' },
  )
  void lifetime.catch(reject)
  return ready
}

async function removeStaleSocket(dir: string): Promise<void> {
  try {
    if (!(await lstat(socketPath(dir))).isSocket()) throw new Error('unsafe_control_socket')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const stale = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath(dir))
    probe.setTimeout(1000, () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', (error) => {
      probe.destroy()
      resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
    })
  })
  if (!stale) throw new Error('control_socket_in_use')
  await unlink(socketPath(dir))
}

async function openEmployeeControl(handler: (input: EmployeeControlRequest) => Promise<unknown>, dir: string) {
  const pending = new Map<string, Promise<unknown>>()
  // 锁住完整控制事务，包含 start 的配置读取和 release 的配置删除。
  // 仅按员工串行化，另一个员工的状态与启停不等待本员工。
  const execute = (request: EmployeeControlRequest): Promise<unknown> => {
    const previous = pending.get(request.agentUuid) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() => handler(request))
    pending.set(request.agentUuid, task)
    void task
      .finally(() => {
        if (pending.get(request.agentUuid) === task) pending.delete(request.agentUuid)
      })
      .catch(() => undefined)
    return task
  }
  const server = net.createServer((socket) => {
    let body = ''
    let handled = false
    socket.setTimeout(35_000, () => socket.destroy())
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => {
      if (handled) return
      body += chunk.toString('utf8')
      if (Buffer.byteLength(body) > LIMIT) {
        socket.destroy()
        return
      }
      if (!body.includes('\n')) return
      handled = true
      void (async () => {
        try {
          const request = parseEmployeeControl(JSON.parse(body))
          const data = await execute(request)
          socket.end(JSON.stringify({ ok: true, data }) + '\n')
        } catch {
          socket.end(JSON.stringify({ ok: false, error: 'employee_control_failed' }) + '\n')
        }
      })()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath(dir), () => resolve())
  })
  await chmod(socketPath(dir), 0o600)
  let closing: Promise<void> | undefined
  return {
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )),
  }
}

export async function requestEmployeeControl(input: unknown, dir = resolveStateDir()): Promise<unknown> {
  const request = parseEmployeeControl(input)
  const info = await lstat(dir)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('unsafe_control_directory')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(dir))
    let body = ''
    const fail = () => {
      socket.destroy()
      reject(new Error('dsh_runtime_unknown'))
    }
    socket.setTimeout(30_000, fail)
    socket.once('error', fail)
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk) => {
      body += chunk.toString('utf8')
      if (Buffer.byteLength(body) > LIMIT) fail()
    })
    socket.once('end', () => {
      socket.destroy()
      try {
        const response = JSON.parse(body)
        if (response.ok !== true) throw new Error('dsh_control_failed')
        resolve(response.data)
      } catch {
        reject(new Error('dsh_control_failed'))
      }
    })
  })
}
