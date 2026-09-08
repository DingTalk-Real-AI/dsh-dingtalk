import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EmployeeIdentity } from './digital-employee-lifecycle.js'
import { sanitizedDwsEnvironment } from './digital-employee-reply-sink.js'

/** DWS 持有跨 Adapter 的 Profile 锁；宿主必须最后释放此进程。 */
export class EmployeeLease {
  private child?: ChildProcessWithoutNullStreams
  private closing = false
  private closed = false
  lost = false
  constructor(
    private readonly employee: EmployeeIdentity,
    private readonly runtimeInstanceId: string,
    private readonly onLost: () => void,
  ) {}

  async start(): Promise<void> {
    const child = spawn(
      'dws',
      [
        '--profile',
        this.employee.dwsProfile,
        'dingtalk-tag',
        'connect',
        '--agent-uuid',
        this.employee.agentUuid,
        '--channel',
        'dsh',
        '--local-lease',
        '--binding-revision',
        String(this.employee.bindingRevision ?? 0),
        '--runtime-instance-id',
        this.runtimeInstanceId,
        '--yes',
        '--format',
        'json',
      ],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: sanitizedDwsEnvironment(process.env) },
    )
    this.child = child
    await new Promise<void>((resolve, reject) => {
      let bytes = 0,
        buffer = '',
        ready = false
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('employee_lease_timeout'))
      }, 12_000)
      const fail = () => {
        clearTimeout(timer)
        if (!ready) reject(new Error('employee_lease_unavailable'))
        if (!this.closing) {
          this.lost = true
          this.onLost()
        }
      }
      child.once('error', fail)
      child.once('close', () => {
        this.closed = true
        fail()
      })
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 65536) child.kill('SIGTERM')
      })
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 65536) {
          child.kill('SIGTERM')
          return
        }
        buffer += chunk.toString('utf8')
        if (/^\[employee\] leased\r?$/m.test(buffer)) {
          ready = true
          clearTimeout(timer)
          resolve()
        }
      })
      child.stdin.on('error', () => undefined)
    })
  }

  async stop(): Promise<void> {
    this.closing = true
    const child = this.child
    if (!child || this.closed || child.exitCode !== null || child.signalCode !== null) return
    const done = new Promise<void>((resolve) => child.once('close', () => resolve()))
    // 只有宿主已完成全部释放才发送确认；EOF 或进程崩溃本身不是释放证明。
    child.stdin.end('released\n')
    await done
  }
}
