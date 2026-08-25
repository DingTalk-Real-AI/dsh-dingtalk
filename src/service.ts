import { spawnSync } from 'node:child_process'

export interface RunningDshWeb {
  pid: number
  command: string
}

export type DshWebProcessStatus = 'running' | 'stopped' | 'unknown'

function classifyDshWebCommand(command: string): {
  definite: boolean
  possible: boolean
  nodeEntrypoint: boolean
} {
  const directCommand = /^(?:\S*[/\\])?dsh\s+(?:web|--profile\s+web)(?:\s|$)/u.test(command)
  const packageRunner = /^(?:\S*[/\\])?(?:npm|npx|pnpm)\s+(?:exec\s+)?(?:--\s+)?dsh\s+web(?:\s|$)/u.test(command)
  const nodeEntrypoint = /^(?:\S*[/\\])?node\s+\S*[/\\]dsh[/\\]lib[/\\]bin\.js\s+web(?:\s|$)/u.test(command)
  const directEntrypoint = /^\S*[/\\]dsh[/\\]lib[/\\]bin\.js\s+web(?:\s|$)/u.test(command)
  const definite = directCommand || packageRunner || nodeEntrypoint || directEntrypoint
  const possible = definite || /(?:^|[\s/\\])dsh\s+(?:web|--profile\s+web)(?:\s|$)/u.test(command)
  return { definite, possible, nodeEntrypoint: nodeEntrypoint || directEntrypoint }
}

/** 对无法唯一归属的多实例也返回 true，供机器 setup 采取保守的 restart 策略。 */
export function dshWebMayBeRunningFromOutput(output: string): boolean {
  return output.split('\n').some((line) => {
    const match = line.trim().match(/^\d+\s+\d+\s+(.+)$/)
    return Boolean(match && classifyDshWebCommand(match[1]).possible)
  })
}

export function dshWebStatusFromProbe(status: number | null, output: string): DshWebProcessStatus {
  if (status !== 0) return 'unknown'
  let possible = false
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^\d+\s+\d+\s+(.+)$/)
    if (!match) continue
    const classification = classifyDshWebCommand(match[1])
    if (classification.definite) return 'running'
    if (classification.possible) possible = true
  }
  return possible ? 'unknown' : 'stopped'
}

/** 从 `ps` 输出中找出唯一的 dsh web 进程，兼容 shell 包装和 Node 直接执行入口。 */
export function findRunningDshWeb(output: string): RunningDshWeb | undefined {
  const processes = new Map<number, { ppid: number; command: string }>()
  const matches: Array<RunningDshWeb & { ppid: number; nodeEntrypoint: boolean }> = []
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const [, pid, ppid, command] = match
    const processId = Number(pid)
    const parentProcessId = Number(ppid)
    processes.set(processId, { ppid: parentProcessId, command })
    const { definite: isDshWeb, nodeEntrypoint } = classifyDshWebCommand(command)
    if (isDshWeb) {
      matches.push({ pid: processId, ppid: parentProcessId, command, nodeEntrypoint })
    }
  }
  const nodeEntrypoints = matches.filter((match) => match.nodeEntrypoint)
  if (nodeEntrypoints.length === 1) {
    const target = nodeEntrypoints[0]
    const ancestors = new Set<number>()
    let parent = target.ppid
    while (parent > 0 && !ancestors.has(parent)) {
      ancestors.add(parent)
      parent = processes.get(parent)?.ppid ?? 0
    }
    if (matches.every((match) => match.pid === target.pid || ancestors.has(match.pid))) {
      return { pid: target.pid, command: target.command }
    }
  }
  if (matches.length !== 1) return undefined
  const { pid, command } = matches[0]
  return { pid, command }
}

/** Locate one unambiguous local `dsh web` process without mutating it. */
export function runningDshWeb(): RunningDshWeb | undefined {
  if (process.platform === 'win32') return undefined
  const ps = spawnSync('ps', ['ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (ps.status !== 0) return undefined
  return findRunningDshWeb(ps.stdout)
}

/** 只要可能存在 dsh web 就返回 true；ps 失败时也保守视为可能运行。 */
export function dshWebMayBeRunning(): boolean {
  return dshWebStatus() !== 'stopped'
}

/** 仅把强证据标为 running；探测失败或可疑包装命令一律返回 unknown。 */
export function dshWebStatus(): DshWebProcessStatus {
  if (process.platform === 'win32') return 'unknown'
  const ps = spawnSync('ps', ['ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return dshWebStatusFromProbe(ps.status, ps.stdout)
}

export async function stopDshWeb(processInfo: RunningDshWeb, timeoutMs = 5_000): Promise<boolean> {
  try {
    process.kill(processInfo.pid, 'SIGTERM')
  } catch {
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(processInfo.pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}
