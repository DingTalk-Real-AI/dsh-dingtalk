import { spawnSync } from 'node:child_process'

export interface RunningDshWeb {
  pid: number
  command: string
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
    const shellCommand = /(?:^|[\s/\\])dsh\s+(web|--profile\s+web)(\s|$)/.test(command)
    const nodeEntrypoint = /(?:^|\s)(?:node\s+)?\S*[/\\]dsh[/\\]lib[/\\]bin\.js\s+web(?:\s|$)/.test(command)
    if (shellCommand || nodeEntrypoint) {
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
