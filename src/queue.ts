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
  run(key: string, task: () => Promise<void>, onBusy?: (position: number) => void): void {
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
        if (entry.generation !== generation) return
        await Promise.race([
          task(),
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
  }
}
