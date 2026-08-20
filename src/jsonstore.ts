/** Tiny persisted string-keyed map shared by bindings / model overrides. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2))
  }
}
