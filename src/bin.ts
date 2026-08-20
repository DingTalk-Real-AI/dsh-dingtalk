#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

import { accountStateDir, DEFAULT_ACCOUNT_ID } from './accounts.js'
import { ConsoleSetupUi } from './console-ui.js'
import { collectDiagnostics, verifyDingTalkCredentials } from './diagnostics.js'
import { exactPackageSpec, packageName, packageVersion } from './package-info.js'
import { resolveStateDir } from './paths.js'
import { runningDshWeb, stopDshWeb } from './service.js'
import { runGuidedSetup } from './setup.js'
import { enabledWebProfileAccounts, loadDingTalkAccountCredentials, loadWebProfileConfig } from './setup-state.js'
import { SystemRunner } from './system-runner.js'

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function stateDir(): string {
  return resolveStateDir()
}

function installSpec(): string {
  if (packageVersion !== '0.0.0-development') return exactPackageSpec
  return fileURLToPath(new URL('..', import.meta.url))
}

function usage(): void {
  console.log(
    [
      `${packageName} ${packageVersion}`,
      '',
      '用法：',
      '  dsh-dingtalk setup                 安装插件并启动完整引导',
      '  dsh-dingtalk doctor [--offline]    执行只读诊断',
      '  dsh-dingtalk --version             显示版本',
      '',
      `首次安装推荐：npx ${packageName}@latest setup`,
    ].join('\n'),
  )
}

async function doctor(args: string[]): Promise<number> {
  const offline = args.includes('--offline')
  const profile = await loadWebProfileConfig(dshHome())
  const icons = { pass: '✅', warn: '⚠️', fail: '❌' } as const
  const accounts = enabledWebProfileAccounts(profile)
  if (!accounts.length) {
    console.log('⚠️ 钉钉机器人：profile 中没有启用的钉钉机器人')
    return 1
  }
  let failed = false
  for (const account of accounts) {
    const credentials = await loadDingTalkAccountCredentials(dshHome(), account.id, account)
    const checks = await collectDiagnostics({
      stateDir: accountStateDir(stateDir(), account.id),
      clientId: credentials?.clientId ?? '',
      clientSecret: credentials?.clientSecret ?? '',
      interactionCardTemplateId:
        profile.interactionCardTemplateId || process.env.DINGTALK_INTERACTION_CARD_TEMPLATE_ID || '',
      configuredOwner:
        account.ownerStaffId ||
        (account.id === DEFAULT_ACCOUNT_ID ? profile.ownerStaffId || process.env.DINGTALK_OWNER_STAFF_ID || '' : ''),
      verifyCredentials: offline ? undefined : verifyDingTalkCredentials,
    })
    if (accounts.length > 1) console.log(`\n[${account.id}]`)
    for (const check of checks) console.log(`${icons[check.status]} ${check.title}：${check.detail}`)
    if (checks.some((check) => check.status === 'fail')) failed = true
  }
  return failed ? 1 : 0
}

async function startWeb(ui: ConsoleSetupUi): Promise<number> {
  const existing = runningDshWeb()
  if (existing) {
    const restart = await ui.confirm(
      'restartWeb',
      `检测到 dsh web 正在运行（PID ${existing.pid}：${existing.command}）。是否优雅重启？`,
      true,
    )
    if (!restart) {
      ui.note('请稍后用原来的管理方式重启 dsh web，使首次安装或升级生效。')
      return 0
    }
    if (!(await stopDshWeb(existing))) {
      ui.warn('未能确认现有 dsh web 已退出；为避免双实例，未启动新进程。')
      return 1
    }
    const supervised = runningDshWeb()
    if (supervised) {
      ui.note(`现有监督程序已经重新启动 dsh web（PID ${supervised.pid}），不会创建第二个实例。`)
      return 0
    }
  }

  ui.note('即将在当前终端启动 dsh web；按 Ctrl+C 可安全停止。')
  ui.close()
  const child = spawnSync('dsh', ['web'], { stdio: 'inherit', env: process.env })
  return child.status ?? 1
}

async function setup(): Promise<number> {
  const ui = new ConsoleSetupUi()
  try {
    const result = await runGuidedSetup({
      ui,
      runner: new SystemRunner(),
      dshHome: dshHome(),
      stateDir: stateDir(),
      installSpec: installSpec(),
    })
    if (result.code !== 0 || !result.startWeb) return result.code
    return await startWeb(ui)
  } finally {
    ui.close()
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'setup') process.exitCode = await setup()
  else if (command === 'doctor') process.exitCode = await doctor(args)
  else if (command === '--version' || command === '-V') console.log(packageVersion)
  else {
    usage()
    process.exitCode = command && command !== '--help' && command !== '-h' ? 2 : 0
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
