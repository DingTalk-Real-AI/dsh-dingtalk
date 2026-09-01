/** Tiny persisted string-keyed map shared by bindings / model overrides. */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class JsonStore<T> {
  private map = new Map<string, T>()

  constructor(
    private readonly file: string,
    log: (line: string) => void,
  ) {
    if (existsSync(file)) {
      try {
        this.map = new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))))
      } catch (err) {
        log(`${file} unreadable, starting empty: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  get(key: string): T | undefined {
    return this.map.get(key)
  }

  set(key: string, value: T): void {
    this.map.set(key, value)
    this.save()
  }

  delete(key: string): void {
    this.map.delete(key)
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp.${process.pid}.${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.map), null, 2), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.file)
    chmodSync(this.file, 0o600)
  }
}
