import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LEDGER_LIMIT = 10_000

interface LedgerData {
  seenEvents: Record<string, number>
  sentMessageIds: Record<string, number>
}

function isLedgerRecord(value: unknown): value is Record<string, number> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, timestamp]) =>
        key.length > 0 && key.length <= 512 && typeof timestamp === 'number' && Number.isFinite(timestamp),
    )
  )
}

function trimLedger(record: Record<string, number>): Record<string, number> {
  const entries = Object.entries(record)
  if (entries.length <= LEDGER_LIMIT) return record
  return Object.fromEntries(entries.sort((left, right) => right[1] - left[1]).slice(0, LEDGER_LIMIT))
}

export function atomicPrivateJsonWrite(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
  chmodSync(file, 0o600)
}

/** 每个数字员工独立持久化事件去重与已发送消息 ID。 */
export class DigitalEmployeeLedger {
  private data: LedgerData = { seenEvents: {}, sentMessageIds: {} }

  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerData>
        if (!isLedgerRecord(parsed.seenEvents) || !isLedgerRecord(parsed.sentMessageIds))
          throw new Error('invalid_ledger')
        this.data = { seenEvents: parsed.seenEvents, sentMessageIds: parsed.sentMessageIds }
      } catch {
        throw new Error('digital_employee_ledger_corrupt')
      }
    }
  }

  hasEvent(eventId: string): boolean {
    return this.data.seenEvents[eventId] !== undefined
  }

  hasSentMessage(messageId: string): boolean {
    return this.data.sentMessageIds[messageId] !== undefined
  }

  markEvent(eventId: string): void {
    this.data.seenEvents[eventId] = Date.now()
    this.save()
  }

  markSentMessage(messageId: string): void {
    this.data.sentMessageIds[messageId] = Date.now()
    this.save()
  }

  private save(): void {
    this.data.seenEvents = trimLedger(this.data.seenEvents)
    this.data.sentMessageIds = trimLedger(this.data.sentMessageIds)
    atomicPrivateJsonWrite(this.file, this.data)
  }
}
