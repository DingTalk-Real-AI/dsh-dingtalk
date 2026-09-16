import type { HostAgent } from './host.js'

type Bindings = { entries(): Iterable<[string, string]> }
type Resolver = (sessionId: string) => Promise<HostAgent | undefined>

/** 宿主 Web resolver 的可选入口。仅按可信绑定路由，不借用或抢占未知 Agent。 */
export class EmployeeSessionRouter {
  private readonly owners = new Map<string, { bindings: Bindings; resolve?: Resolver }>()

  has(sessionId: string): boolean {
    return [...this.owners.values()].some(({ bindings }) => [...bindings.entries()].some(([, id]) => id === sessionId))
  }

  reserve(owner: string, bindings: Bindings): void {
    if (this.owners.has(owner)) throw new Error('employee_session_owner_exists')
    this.owners.set(owner, { bindings })
  }

  activate(owner: string, resolve: Resolver): () => void {
    const entry = this.owners.get(owner)
    if (!entry) throw new Error('employee_session_owner_missing')
    entry.resolve = resolve
    return () => {
      if (entry.resolve === resolve) entry.resolve = undefined
    }
  }

  async resolve(sessionId: string): Promise<HostAgent | undefined> {
    const owners = [...this.owners.values()].filter(({ bindings }) =>
      [...bindings.entries()].some(([, id]) => id === sessionId),
    )
    if (!owners.length) return undefined
    if (owners.length !== 1) throw new Error('employee_session_ambiguous')
    const owner = owners[0]
    if (!owner.resolve) throw new Error('employee_session_unavailable')
    const resolve = owner.resolve
    const agent = await resolve(sessionId)
    if (
      !agent ||
      agent.id !== sessionId ||
      owner.resolve !== resolve ||
      ![...owner.bindings.entries()].some(([, id]) => id === sessionId)
    )
      throw new Error('employee_session_unavailable')
    return agent
  }
}
