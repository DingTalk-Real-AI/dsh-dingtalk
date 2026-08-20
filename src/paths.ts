import os from 'node:os'
import path from 'node:path'

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_DINGTALK_STATE_DIR || path.join(os.homedir(), '.dsh-dingtalk')
}
