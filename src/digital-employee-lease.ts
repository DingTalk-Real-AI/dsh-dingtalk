import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EmployeeIdentity } from './digital-employee-lifecycle.js'
import { sanitizedDwsEnvironment } from './digital-employee-reply-sink.js'

const VISIBILITY_STARTUP_HINTS = {
  visibility_supervisor_missing: '旧绑定缺少主管身份。请使用原主管账号执行 connect restart 后重试。',
  visibility_supervisor_ambiguous: '无法唯一确认原主管身份。请使用原主管账号执行 connect restart 后重试。',
  visibility_supervisor_unavailable: '原主管账号暂不可用。请检查原主管账号的登录状态，再执行 connect restart。',
  visibility_identity_mismatch: '主管身份与原绑定不符。请使用原主管账号执行 connect restart，勿修改绑定身份字段。',
  visibility_migration_timeout: '旧绑定权限检查超时。请检查网络后使用原主管账号执行 connect restart。',
  visibility_binding_changed: '迁移期间绑定已变更。请核对当前绑定，再使用原主管账号执行 connect restart。',
  visibility_migration_persist_failed:
    '旧绑定迁移无法保存。请检查配置目录写权限，再使用原主管账号执行 connect restart。',
  visibility_migration_unavailable:
    '旧绑定权限检查暂不可用。请查看本地 DWS 日志，再使用原主管账号执行 connect restart。',
} as const

function startupError(stdout: string, stderr: string, exitCode: number | null): Error {
  // 只采信完整机器错误及已知分类；服务端自由文本、hint、cause 均不得进入宿主日志。
  if (exitCode !== null && exitCode !== 0) {
    try {
      // 统一结果的 stdout 是唯一权威；存在但无效时不得回退 stderr 选择另一结果。
      const unified = stdout.trim() !== ''
      const envelope: unknown = JSON.parse(unified ? stdout : stderr)
      if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
        const value = envelope as Record<string, unknown>
        const raw = value.error
        const fields = unified ? ['ok', 'outcome', 'error', 'identity', 'meta', '_notice'] : ['error', '_notice']
        if (
          Object.keys(value).every((key) => fields.includes(key)) &&
          raw &&
          typeof raw === 'object' &&
          !Array.isArray(raw)
        ) {
          const error = raw as Record<string, unknown>
          const reason = unified ? error.subtype : error.reason
          const classified = unified
            ? value.ok === false &&
              value.outcome === 'failure' &&
              error.type === 'validation' &&
              error.exit_code === 3 &&
              // 统一结果省略 false；不能把 true 或字符串布尔解释成不重试。
              (error.retryable === undefined || error.retryable === false)
            : error.code === 3 && error.category === 'validation' && error.retryable === false
          if (classified && typeof reason === 'string' && Object.hasOwn(VISIBILITY_STARTUP_HINTS, reason)) {
            return new Error(`${reason}: ${VISIBILITY_STARTUP_HINTS[reason as keyof typeof VISIBILITY_STARTUP_HINTS]}`)
          }
        }
      }
    } catch {
      // 非 JSON 或混杂日志不按字符串猜测分类。
    }
  }
  return new Error('employee_lease_unavailable')
}

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
        stdout = '',
        ready = false,
        bounded = true
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('employee_lease_timeout'))
      }, 12_000)
      const fail = (error = new Error('employee_lease_unavailable')) => {
        clearTimeout(timer)
        if (!ready) reject(error)
        if (!this.closing && !this.lost) {
          this.lost = true
          this.onLost()
        }
      }
      child.once('error', () => fail())
      child.once('close', (code) => {
        this.closed = true
        fail(!ready && bounded ? startupError(stdout, buffer, code) : undefined)
      })
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 65536) {
          bounded = false
          child.kill('SIGTERM')
          return
        }
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 65536) {
          bounded = false
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
