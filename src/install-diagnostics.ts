import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { CommandResult } from './setup.js'

export type InstallStage = 'dsh_install' | 'pnpm_install' | 'plugin_install'

export interface InstallDiagnostic {
  stage: InstallStage
  errorCode?: string
  primaryMessage: string
  packageSpec?: string
  registry?: string
  dependency?: string
  suggestedAction: string
  logPath?: string
}

interface DiagnoseCommandFailureOptions {
  stage: InstallStage
  command: string
  args: string[]
  result: CommandResult
  stateDir: string
}

const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu
const KNOWN_ERROR_CODES = [
  'ERR_PNPM_NO_MATCHING_VERSION',
  'ETARGET',
  'E401',
  'E403',
  'EACCES',
  'EPERM',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOSPC',
] as const

function cleanOutput(value: string): string {
  return value.replace(ANSI_ESCAPE, '').replaceAll('\r', '')
}

function combinedOutput(result: CommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).map(cleanOutput).join('\n').trim()
}

function extractErrorCode(output: string): string | undefined {
  const bracketed = output.match(/\[((?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+))\]/u)?.[1]
  if (bracketed) return bracketed
  const npmCode = output.match(/npm\s+(?:error|ERR!)\s+code\s+([A-Z][A-Z0-9_]*)/iu)?.[1]
  if (npmCode) return npmCode.toUpperCase()
  return KNOWN_ERROR_CODES.find((code) => new RegExp(`(?:^|\\s)${code}(?:\\s|:|$)`, 'mu').test(output))
}

function extractPackageSpec(output: string): string | undefined {
  const value = output.match(/No matching version found for\s+([^\s]+?)(?:[.。]?)(?:\n|$)/iu)?.[1]
  return value?.replace(/[.。]$/u, '')
}

function safeRegistry(value: string): string | undefined {
  try {
    const parsed = new URL(value.replace(/[>,.;。]+$/u, ''))
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return undefined
  }
}

function extractRegistry(output: string): string | undefined {
  const value = output.match(/while fetching it from\s+(https?:\/\/\S+)/iu)?.[1]
  return value ? safeRegistry(value) : undefined
}

function extractDependency(output: string): string | undefined {
  return output
    .match(/This error happened while installing the dependencies of\s+([^\s]+)/iu)?.[1]
    ?.replace(/[.。]$/u, '')
}

function redactSensitive(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gu, (candidate) => safeRegistry(candidate) ?? '[REDACTED_URL]')
    .replace(/((?:_authToken|authToken|token|password|secret)\s*[:=]\s*)[^\s]+/giu, '$1[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/giu, '$1[REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9_-]+\b/gu, '[REDACTED]')
}

function extractPrimaryMessage(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const primary =
    lines.find((line) => /No matching version found|permission denied|network|ENOSPC/iu.test(line)) ??
    lines.find((line) => /^\[ERR_[A-Z0-9_]+\]/u.test(line)) ??
    lines.find((line) => /^npm\s+(?:error|ERR!)/iu.test(line) && !/\s+code\s+/iu.test(line)) ??
    undefined
  if (!primary) return '子进程返回非零状态，未识别到 npm/pnpm 错误码'
  const cleaned = redactSensitive(
    primary.replace(/^\[[A-Z][A-Z0-9_]+\]\s*/u, '').replace(/^npm\s+(?:error|ERR!)\s*/iu, ''),
  )
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}…` : cleaned
}

function suggestedAction(errorCode: string | undefined): string {
  if (errorCode === 'ETARGET' || errorCode === 'ERR_PNPM_NO_MATCHING_VERSION') {
    return '当前 registry 可能缺少该版本。可用 npm_config_registry=<可用 registry> npx @dingtalk-real-ai/dsh-dingtalk@latest setup 重试；setup 会把该 registry 同步给 DSH 内部的 pnpm。也可在 ~/.dsh/profiles/web/.npmrc（自定义 DSH_HOME 时使用 $DSH_HOME/profiles/web/.npmrc）写入 registry=<可用 registry>。'
  }
  if (errorCode === 'E401' || errorCode === 'E403') {
    return '请检查 registry 登录状态和包访问权限后重试。'
  }
  if (errorCode === 'EACCES' || errorCode === 'EPERM') {
    return '请检查 npm 全局目录和目标目录权限后重试。'
  }
  if (['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(errorCode ?? '')) {
    return '请检查网络、代理、DNS 和 registry 可达性后重试。'
  }
  if (errorCode === 'ENOSPC') return '请清理磁盘空间后重试。'
  return '请根据首要错误检查安装环境；如仍失败，请查看完整日志后重试。'
}

async function writeCommandLog(options: DiagnoseCommandFailureOptions): Promise<string | undefined> {
  try {
    const logsDir = path.join(options.stateDir, 'logs')
    await mkdir(logsDir, { recursive: true, mode: 0o700 })
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const logPath = path.join(logsDir, `setup-${timestamp}-${options.stage}-${randomUUID().slice(0, 8)}.log`)
    const content = [
      `timestamp: ${new Date().toISOString()}`,
      `stage: ${options.stage}`,
      'redacted: true',
      `command: ${redactSensitive([options.command, ...options.args].join(' '))}`,
      `exitCode: ${options.result.code}`,
      '',
      '--- stdout ---',
      redactSensitive(options.result.stdout),
      '',
      '--- stderr ---',
      redactSensitive(options.result.stderr),
      '',
    ].join('\n')
    await writeFile(logPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return logPath
  } catch {
    return undefined
  }
}

export async function diagnoseCommandFailure(options: DiagnoseCommandFailureOptions): Promise<InstallDiagnostic> {
  const output = combinedOutput(options.result)
  const errorCode = extractErrorCode(output)
  return {
    stage: options.stage,
    errorCode,
    primaryMessage: extractPrimaryMessage(output),
    packageSpec: extractPackageSpec(output),
    registry: extractRegistry(output),
    dependency: extractDependency(output),
    suggestedAction: suggestedAction(errorCode),
    logPath: await writeCommandLog(options),
  }
}

export function formatInstallFailure(title: string, diagnostic: InstallDiagnostic): string {
  return [
    title,
    `阶段：${diagnostic.stage}`,
    diagnostic.errorCode ? `错误码：${diagnostic.errorCode}` : undefined,
    `原因：${diagnostic.primaryMessage}`,
    diagnostic.packageSpec ? `包：${diagnostic.packageSpec}` : undefined,
    diagnostic.registry ? `Registry：${diagnostic.registry}` : undefined,
    diagnostic.dependency ? `依赖：${diagnostic.dependency}` : undefined,
    `建议：${diagnostic.suggestedAction}`,
    diagnostic.logPath ? `完整日志：${diagnostic.logPath}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}
