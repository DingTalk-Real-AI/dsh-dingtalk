import { randomUUID } from 'node:crypto'
import type { DigitalEmployeeConfig } from './setup-state.js'

export interface EmployeeIdentity {
  agentUuid: string
  dwsProfile: string
  bindingRevision?: number
}

export interface EmployeeRuntime {
  start?(): Promise<void>
  status(): { state: string }
  /** 只有所属 Consumer、回合及待发送操作全部释放后才 resolve。 */
  stop(): Promise<void>
}

type RuntimeState = 'starting' | 'running' | 'stopping' | 'stopped' | 'blocked'
interface Entry {
  identity: EmployeeIdentity
  runtimeInstanceId: string
  state: RuntimeState
  runtime?: EmployeeRuntime
  creating?: Promise<EmployeeRuntime>
  stopping?: Promise<void>
}

/** 仅管理本宿主创建的员工实例，不处理机器人或 Web UI 自有 Agent。 */
export class EmployeeRuntimeRegistry {
  private readonly entries = new Map<string, Entry>()
  private closing = false
  constructor(
    private readonly create: (employee: DigitalEmployeeConfig, runtimeInstanceId: string) => Promise<EmployeeRuntime>,
  ) {}

  status(identity: EmployeeIdentity) {
    const entry = this.match(identity)
    const observed = entry?.runtime?.status().state
    const runtimeState =
      entry?.state === 'running' && (observed === 'failed' || observed === 'stopped')
        ? 'blocked'
        : (entry?.state ?? 'stopped')
    const transportReady = runtimeState === 'running' && observed === 'ready'
    return {
      protocolVersion: 1,
      ...identity,
      bindingRevision: identity.bindingRevision ?? 0,
      runtimeInstanceId: entry?.runtimeInstanceId ?? '',
      runtimeState,
      transportReady: Boolean(transportReady),
      executorReady: runtimeState === 'running',
      released: !entry || entry.state === 'stopped',
      observedAt: new Date().toISOString(),
    }
  }

  async start(employee: DigitalEmployeeConfig) {
    if (this.closing) throw new Error('host_stopping')
    const old = this.entries.get(employee.agentUuid)
    if (old && old.state !== 'stopped') {
      this.match(employee)
      if (old.state === 'running') return this.status(employee)
      throw new Error('runtime_not_released')
    }
    for (const other of this.entries.values()) {
      if (other.identity.dwsProfile === employee.dwsProfile && other.state !== 'stopped') {
        throw new Error('profile_runtime_not_released')
      }
    }
    const entry: Entry = { identity: employee, runtimeInstanceId: randomUUID(), state: 'starting' }
    this.entries.set(employee.agentUuid, entry)
    entry.creating = Promise.resolve().then(() => this.create(employee, entry.runtimeInstanceId))
    try {
      entry.runtime = await entry.creating
      if (this.closing || entry.state !== 'starting') throw new Error('runtime_start_interrupted')
      await entry.runtime.start?.()
      if (entry.state !== 'starting') throw new Error('runtime_start_interrupted')
      entry.state = 'running'
      return this.status(employee)
    } catch (error) {
      // 工厂必须自行清理失败启动；无法证明释放时保留阻塞，不能覆盖实例。
      try {
        if (entry.stopping) await entry.stopping
        else await entry.runtime?.stop()
        entry.state = entry.runtime ? 'stopped' : 'blocked'
      } catch {
        entry.state = 'blocked'
      }
      throw error
    }
  }

  async stop(identity: EmployeeIdentity) {
    const entry = this.match(identity)
    if (!entry || entry.state === 'stopped') return this.status(identity)
    if (!entry.stopping) {
      entry.state = 'stopping'
      entry.stopping = Promise.resolve()
        .then(async () => {
          const runtime = entry.runtime ?? (await entry.creating)
          if (!runtime) throw new Error('runtime_not_released')
          entry.runtime = runtime
          await runtime.stop()
        })
        .then(
          () => {
            entry.state = 'stopped'
          },
          (error) => {
            entry.state = 'blocked'
            throw error
          },
        )
        .finally(() => {
          entry.stopping = undefined
        })
    }
    await entry.stopping
    return this.status(identity)
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.entries.values()].map((entry) => this.stop(entry.identity)))
  }

  private match(identity: EmployeeIdentity): Entry | undefined {
    const entry = this.entries.get(identity.agentUuid)
    if (
      entry &&
      (entry.identity.dwsProfile !== identity.dwsProfile ||
        (entry.identity.bindingRevision ?? 0) !== (identity.bindingRevision ?? 0))
    ) {
      // 旧版本已确认释放，不得阻塞新版本补注册；不能把旧实例 ID 当作新版本释放证明。
      if (entry.state === 'stopped') return undefined
      throw new Error('binding_mismatch')
    }
    return entry
  }
}
