import { chmod, mkdir, open, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

export interface DigitalEmployeeAuditFields {
  eventId?: string
  sessionId?: string
  operationType: string
  toolName?: string
  status: string
  replyMessageId?: string
  traceId?: string
}

const LOCK_RETRY_MS = 10
const LOCK_ATTEMPTS = 100
const STALE_LOCK_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 员工级本地可靠审计。只记录元数据，不接受消息正文。 */
export class LocalDigitalEmployeeAuditLog {
  private chain = Promise.resolve()
  private readonly directory: string
  private readonly file: string
  private readonly lockFile: string

  constructor(stateDir: string, agentUuid: string) {
    this.directory = path.join(stateDir, 'audit')
    this.file = path.join(this.directory, `${agentUuid}.jsonl`)
    this.lockFile = path.join(this.directory, `${agentUuid}.lock`)
  }

  audit(fields: DigitalEmployeeAuditFields): Promise<void> {
    const operation = this.chain.then(
      () => this.append(fields),
      () => this.append(fields),
    )
    this.chain = operation
    return operation
  }

  private async append(fields: DigitalEmployeeAuditFields): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const lock = await this.acquireLock()
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        ...(fields.eventId ? { eventId: fields.eventId } : {}),
        ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
        operationType: fields.operationType,
        ...(fields.toolName ? { toolName: fields.toolName } : {}),
        status: fields.status,
        ...(fields.replyMessageId ? { replyMessageId: fields.replyMessageId } : {}),
        ...(fields.traceId ? { traceId: fields.traceId } : {}),
      }
      const output = await open(this.file, 'a', 0o600)
      try {
        await output.writeFile(`${JSON.stringify(entry)}\n`, { encoding: 'utf8' })
        await output.sync()
        await output.chmod(0o600)
      } finally {
        await output.close()
      }
    } finally {
      await lock.close()
      await unlink(this.lockFile).catch(() => undefined)
    }
  }

  private async acquireLock() {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        return await open(this.lockFile, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const info = await stat(this.lockFile)
          if (Date.now() - info.mtimeMs > STALE_LOCK_MS) await unlink(this.lockFile)
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
        }
        await delay(LOCK_RETRY_MS)
      }
    }
    throw new Error('digital_employee_audit_lock_timeout')
  }
}
