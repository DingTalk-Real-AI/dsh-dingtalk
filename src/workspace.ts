/** Keep DingTalk sessions explicitly accounted by their DSH Web workspace. */
import { realpath } from 'node:fs/promises'
import type { SessionId } from './host.js'

export interface HostWorkspace {
  readonly path: string
  readonly sessionIds: readonly SessionId[]
  attachSession(sessionId: SessionId): Promise<void>
}

export interface HostWorkspaceRegistry {
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  create(path: string): Promise<HostWorkspace>
}

export interface HostSessionHeader {
  readonly id: SessionId
  readonly cwd?: string
  readonly origin?: 'subagent'
}

export interface HostSessionPersistence {
  list(): Promise<HostSessionHeader[]>
}

export interface WorkspaceLinkerOptions {
  cwd: string
  resolveRegistry(): HostWorkspaceRegistry | undefined
  resolvePersistence(): HostSessionPersistence | undefined
  log(line: string): void
  attempts?: number
  retryIntervalMs?: number
}

export class WorkspaceLinker {
  private ready: Promise<HostWorkspace | undefined> | undefined

  constructor(private readonly opts: WorkspaceLinkerOptions) {}

  /** Resolve/create the workspace once and migrate matching persisted sessions. */
  start(): Promise<HostWorkspace | undefined> {
    this.ready ??= this.initialize()
    return this.ready
  }

  /** Explicit membership is required; matching cwd alone does not group a session. */
  async attach(sessionId: SessionId): Promise<void> {
    const workspace = await this.start()
    if (!workspace) return
    const existed = workspace.sessionIds.includes(sessionId)
    try {
      await workspace.attachSession(sessionId)
      if (!existed) this.opts.log(`session ${sessionId} attached to workspace ${workspace.path}`)
    } catch (err) {
      this.opts.log(`workspace session attach failed (${err instanceof Error ? err.message : err})`)
    }
  }

  private async initialize(): Promise<HostWorkspace | undefined> {
    const attempts = this.opts.attempts ?? 15
    const retryIntervalMs = this.opts.retryIntervalMs ?? 2_000
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const registry = this.opts.resolveRegistry()
        if (registry) {
          const existing = await registry.resolveByPath(this.opts.cwd)
          const workspace = existing ?? (await registry.create(this.opts.cwd))
          if (!existing) this.opts.log(`workspace registered in web UI: ${workspace.path}`)
          await this.migrate(workspace)
          return workspace
        }
      } catch (err) {
        this.opts.log(`workspace registration failed (${err instanceof Error ? err.message : err})`)
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs))
    }
    this.opts.log(
      `workspaceRegistry service not available after ${Math.round((attempts * retryIntervalMs) / 1_000)}s; add the workspace manually in web UI`,
    )
    return undefined
  }

  private async migrate(workspace: HostWorkspace): Promise<void> {
    const persistence = this.opts.resolvePersistence()
    if (!persistence) return
    let headers: HostSessionHeader[]
    try {
      headers = await persistence.list()
    } catch (err) {
      this.opts.log(`workspace session migration skipped (${err instanceof Error ? err.message : err})`)
      return
    }

    let attached = 0
    for (const header of headers) {
      if (!header.cwd || header.origin === 'subagent' || workspace.sessionIds.includes(header.id)) continue
      try {
        if ((await realpath(header.cwd)) !== workspace.path) continue
        await workspace.attachSession(header.id)
        attached++
      } catch (err) {
        // A session whose cwd no longer exists is simply not ours to migrate
        // (deleted scratch dirs from other tools); only real failures warrant
        // a log line, and this scan repeats every boot.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this.opts.log(
            `workspace session migration failed for ${header.id} (${err instanceof Error ? err.message : err})`,
          )
        }
      }
    }
    if (attached) this.opts.log(`workspace migrated ${attached} existing DingTalk session(s)`)
  }
}
