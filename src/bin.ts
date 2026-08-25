#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { stdin, stdout } from 'node:process'

import { accountStateDir, DEFAULT_ACCOUNT_ID } from './accounts.js'
import { ConsoleSetupUi } from './console-ui.js'
import { collectDiagnostics, verifyDingTalkCredentials } from './diagnostics.js'
import { collectDoctorReport } from './doctor-report.js'
import { exactPackageSpec, packageName, packageVersion } from './package-info.js'
import { resolveStateDir } from './paths.js'
import { dshWebStatus, runningDshWeb, stopDshWeb } from './service.js'
import {
  applyMachineSetup,
  MachineSetupInputError,
  parseMachineSetupAnswers,
  planMachineSetup,
  resumeMachineSetup,
  resumePrivateSetup,
  type MachineSetupOptions,
  type MachineSetupOutcome,
} from './setup-machine.js'
import { runGuidedSetup } from './setup.js'
import {
  CredentialDshUpgradeRequiredError,
  enabledWebProfileAccounts,
  loadDingTalkAccountCredentials,
  loadWebProfileConfig,
} from './setup-state.js'
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
      '  dsh-dingtalk setup --plan --json [--account <id>]',
      '                                      生成严格只读的机器安装计划',
      '  dsh-dingtalk setup --apply --json --answers <file>',
      '                                      按显式批准执行并创建检查点',
      '  dsh-dingtalk setup --resume <id> [--json]',
      '                                      人工处理私密步骤，或机器续跑',
      '  dsh-dingtalk doctor [--offline] [--json]',
      '                                      执行只读诊断',
      '  dsh-dingtalk --version             显示版本',
      '',
      `首次安装推荐：npx ${packageName}@latest setup`,
    ].join('\n'),
  )
}

class CliArgumentError extends Error {}

function takeFlag(args: string[], flag: string): boolean {
  const indexes = args.flatMap((value, index) => (value === flag ? [index] : []))
  if (indexes.length > 1) throw new CliArgumentError('invalid_arguments')
  if (!indexes.length) return false
  args.splice(indexes[0], 1)
  return true
}

function takeValue(args: string[], flag: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === flag ? [index] : []))
  if (indexes.length > 1) throw new CliArgumentError('invalid_arguments')
  if (!indexes.length) return undefined
  const index = indexes[0]
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new CliArgumentError('invalid_arguments')
  args.splice(index, 2)
  return value
}

function writeJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`)
}

function writeJsonError(code: string): void {
  writeJson({ schemaVersion: 1, kind: 'error', error: { code } })
}

function machineOptions(): MachineSetupOptions {
  return {
    runner: new SystemRunner(),
    dshHome: dshHome(),
    stateDir: stateDir(),
    installSpec: installSpec(),
    serviceStatus: dshWebStatus(),
  }
}

function outcomeExitCode(result: MachineSetupOutcome): number {
  return result.status === 'blocked' || result.status === 'failed' ? 1 : 0
}

async function doctor(args: string[]): Promise<number> {
  const remaining = [...args]
  let offline: boolean
  let json: boolean
  try {
    offline = takeFlag(remaining, '--offline')
    json = takeFlag(remaining, '--json')
    if (remaining.length) throw new CliArgumentError('invalid_arguments')
  } catch {
    if (args.includes('--json')) writeJsonError('invalid_arguments')
    else console.error('doctor 参数无效；请运行 dsh-dingtalk --help 查看用法。')
    return 2
  }

  if (json) {
    try {
      const report = await collectDoctorReport({
        mode: offline ? 'offline' : 'online',
        dshHome: dshHome(),
        stateDir: stateDir(),
      })
      writeJson(report)
      return report.result === 'fail' || report.result === 'error' ? 1 : 0
    } catch {
      writeJsonError('doctor_failed')
      return 1
    }
  }

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

async function guidedSetup(): Promise<number> {
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

async function privateResume(checkpointId: string): Promise<number> {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error('私密 resume 只能在交互式终端运行，不能通过管道或 AI 输入凭据。')
    return 2
  }
  const ui = new ConsoleSetupUi()
  try {
    const result = await resumePrivateSetup({
      ...machineOptions(),
      checkpointId,
      ui,
    })
    if (result.status === 'awaiting_bind') {
      ui.success('私密步骤已完成；请按上方提示完成绑定，再让 AI 使用同一 checkpoint 续跑。')
      return 0
    }
    ui.success('私密步骤已经满足，可让 AI 使用同一 checkpoint 续跑。')
    return outcomeExitCode(result)
  } catch (error) {
    console.error(
      error instanceof CredentialDshUpgradeRequiredError
        ? error.message
        : '无法恢复该 setup checkpoint；它可能不存在、已损坏或当前状态不允许私密续跑。',
    )
    return 1
  } finally {
    ui.close()
  }
}

async function machineSetup(args: string[]): Promise<number> {
  const remaining = [...args]
  let json = false
  try {
    const plan = takeFlag(remaining, '--plan')
    const apply = takeFlag(remaining, '--apply')
    json = takeFlag(remaining, '--json')
    const accountId = takeValue(remaining, '--account')
    const answersFile = takeValue(remaining, '--answers')
    const checkpointId = takeValue(remaining, '--resume')
    if (remaining.length) throw new CliArgumentError('invalid_arguments')

    const modeCount = Number(plan) + Number(apply) + Number(Boolean(checkpointId))
    if (modeCount !== 1) throw new CliArgumentError('invalid_arguments')
    if (plan) {
      if (!json || answersFile || checkpointId) throw new CliArgumentError('invalid_arguments')
      const result = await planMachineSetup(machineOptions(), accountId ? { accountId } : {})
      writeJson(result)
      return 0
    }
    if (apply) {
      if (!json || !answersFile || accountId || checkpointId) throw new CliArgumentError('invalid_arguments')
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(answersFile, 'utf8'))
      } catch {
        writeJsonError('answers_read_failed')
        return 2
      }
      const result = await applyMachineSetup(machineOptions(), parseMachineSetupAnswers(raw))
      writeJson(result)
      return outcomeExitCode(result)
    }
    if (!checkpointId || answersFile || accountId) throw new CliArgumentError('invalid_arguments')
    if (!json) return privateResume(checkpointId)
    const result = await resumeMachineSetup(machineOptions(), checkpointId)
    writeJson(result)
    return outcomeExitCode(result)
  } catch (error) {
    if (json || args.includes('--json')) {
      writeJsonError(
        error instanceof MachineSetupInputError || error instanceof CliArgumentError ? error.message : 'setup_failed',
      )
    } else {
      console.error('setup 参数或 checkpoint 无效；请运行 dsh-dingtalk --help 查看用法。')
    }
    return error instanceof MachineSetupInputError || error instanceof CliArgumentError ? 2 : 1
  }
}

async function setup(args: string[]): Promise<number> {
  if (!args.length) return guidedSetup()
  return machineSetup(args)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'setup') process.exitCode = await setup(args)
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
