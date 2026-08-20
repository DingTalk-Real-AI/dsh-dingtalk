/**
 * The optional dws tools module (plan §5.3: dws + skill, zero native tools).
 * Enabling it does three things:
 *  1. verify the local dws CLI and its login state (guidance, never blocking),
 *  2. export the channel env vars dws reads for attribution/credential reuse
 *     (`DWS_CHANNEL` / `DWS_CLIENT_ID` / `DWS_CLIENT_SECRET`, same names the
 *     OpenClaw connector injects),
 *  3. install the bundled dws-cli skill into the channel workspace's
 *     `.dsh/skills/` root, where DSH's filesystem skill provider discovers it
 *     for DingTalk sessions only (other workspaces stay untouched).
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DingTalkAppCredentials } from './credentials.js'

export interface ToolsStatus {
  enabled: boolean
  dwsFound: boolean
  dwsVersion?: string
  authed: boolean
  skillInstalled: boolean
}

export interface ToolsOptions extends DingTalkAppCredentials {
  workspace: string
  exposeCredentials?: boolean
  log(line: string): void
}

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
  })
}

/** The packaged skill directory, resolved relative to the built module. */
function bundledSkillDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'skills', 'dws-cli')
}

export class DwsTools {
  status: ToolsStatus = { enabled: false, dwsFound: false, authed: false, skillInstalled: false }

  constructor(private readonly opts: ToolsOptions) {}

  async enable(): Promise<ToolsStatus> {
    const { log } = this.opts
    this.status.enabled = true

    const version = await run('dws', ['--version'])
    this.status.dwsFound = version.code === 0
    if (this.status.dwsFound) {
      this.status.dwsVersion = version.stdout.trim().split('\n')[0]
    } else {
      log('tools: dws CLI 未安装 — 钉钉能力不可用；安装 dws 后重启即可（channel 对话不受影响）')
      return this.status
    }

    const auth = await run('dws', ['auth', 'status', '--format', 'json'])
    this.status.authed = auth.code === 0
    if (!this.status.authed) {
      log('tools: dws 未登录 — 在本机执行 `dws auth login` 完成个人授权后重启；工具将以登录用户本人身份执行')
    }

    // Channel attribution + credential reuse, read by dws itself (connector
    // injects the same names). Process-level: DSH's bash tool inherits them.
    process.env.DWS_CHANNEL = 'dsh-dingtalk'
    if (this.opts.exposeCredentials === false) {
      delete process.env.DWS_CLIENT_ID
      delete process.env.DWS_CLIENT_SECRET
      log('tools: multi-account mode does not export process-global app credentials; dws continues with personal auth')
    } else {
      process.env.DWS_CLIENT_ID = this.opts.clientId
      process.env.DWS_CLIENT_SECRET = this.opts.clientSecret
    }

    try {
      const source = bundledSkillDir()
      if (!existsSync(source)) throw new Error(`bundled skill missing at ${source}`)
      const dest = path.join(this.opts.workspace, '.dsh', 'skills', 'dws-cli')
      mkdirSync(path.dirname(dest), { recursive: true })
      cpSync(source, dest, { recursive: true })
      this.status.skillInstalled = true
      log(`tools: dws-cli skill installed → ${dest}`)
    } catch (err) {
      log(`tools: skill install failed (${err instanceof Error ? err.message : err})`)
    }

    log(`tools: enabled (dws=${this.status.dwsVersion ?? '?'} authed=${this.status.authed})`)
    return this.status
  }

  statusLine(): string {
    if (!this.status.enabled) return '关闭（配置 `tools.enabled: true` 开启钉钉能力）'
    if (!this.status.dwsFound) return '开启但 dws 未安装'
    return `开启（${this.status.dwsVersion ?? 'dws'}｜${this.status.authed ? '已登录' : '未登录，需 dws auth login'}｜skill ${this.status.skillInstalled ? '已挂载' : '挂载失败'}）`
  }
}
