import { spawnSync } from 'node:child_process'

import type { CommandResult, CommandRunner } from './setup.js'

export class SystemRunner implements CommandRunner {
  run(command: string, args: string[]): CommandResult {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    })
    return {
      code: result.status ?? (result.error ? 127 : 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr || result.error?.message || '',
    }
  }
}
