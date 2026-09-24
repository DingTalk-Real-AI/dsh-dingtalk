/**
 * Per-conversation serial queue: one turn at a time per DingTalk conversation,
 * later messages wait their turn and the sender gets an immediate busy notice.
 * Pattern from dingtalk-openclaw-connector `message-handler.ts` sessionQueues
 * (promise-chain tail + periodic cleanup of settled entries).
 */

interface Entry {
  tail: Promise<void>
  depth: number
  settledAt: number
  generation: number
}

const CLEANUP_AFTER_MS = 60_000
/** A wedged turn must not block the conversation forever. */
const TASK_TIMEOUT_MS = 15 * 60_000

export class Queue {
  private entries = new Map<string, Entry>()
  private closed = false
  private readonly active = new Set<Promise<void>>()

  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) entry.generation++
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.tail))
    // 不能把会话排队超时误当作 Agent 已退出。
    await Promise.allSettled([...this.active])
  }

  constructor(private readonly log: (line: string) => void) {}

  depth(key: string): number {
    return this.entries.get(key)?.depth ?? 0
  }

  /** Invalidate work that has not started yet; the active task is cancelled by its Agent owner. */
  clear(key: string): void {
    const entry = this.entries.get(key)
    if (entry) entry.generation++
  }

  /**
   * Enqueue a task for the conversation. `onBusy(position)` fires immediately
   * when earlier work is still pending.
   */
  run(key: string, task: () => Promise<void>, onBusy?: (position: number) => void): Promise<void> {
    if (this.closed) return Promise.resolve()
    const now = Date.now()
    for (const [k, e] of this.entries) {
      if (e.depth === 0 && now - e.settledAt > CLEANUP_AFTER_MS) this.entries.delete(k)
    }
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { tail: Promise.resolve(), depth: 0, settledAt: now, generation: 0 }
      this.entries.set(key, entry)
    }
    if (entry.depth > 0 && onBusy) {
      try {
        onBusy(entry.depth)
      } catch {
        // Busy notice is best-effort.
      }
    }
    entry.depth++
    const generation = entry.generation
    const guarded = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (this.closed || entry.generation !== generation) return
        const running = Promise.resolve().then(task)
        this.active.add(running)
        void running.finally(() => this.active.delete(running)).catch(() => undefined)
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              this.log(
                `queue task timed out after ${TASK_TIMEOUT_MS / 60000}min (${key.slice(0, 16)}…); releasing the lane`,
              )
              resolve()
            }, TASK_TIMEOUT_MS)
          }),
        ])
      } catch (err) {
        this.log(`queue task error: ${err instanceof Error ? err.message : err}`)
      } finally {
        if (timer) clearTimeout(timer)
        entry.depth--
        entry.settledAt = Date.now()
      }
    }
    entry.tail = entry.tail.then(guarded)
    return entry.tail
  }
}
