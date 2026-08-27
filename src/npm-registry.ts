import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { withRecoverableFileLock } from './file-lock.js'
import type { CommandRunner } from './setup.js'

const REGISTRY_LINE = /^\s*registry\s*=/iu

function normalizeRegistry(value: string): string {
  let registry: URL
  try {
    registry = new URL(value.trim())
  } catch {
    throw new Error('npm 返回了无效 registry；请先运行 npm config get registry 检查配置')
  }
  if (registry.protocol !== 'https:' && registry.protocol !== 'http:') {
    throw new Error('npm registry 必须使用 http 或 https URL')
  }

  // registry URL 不应承载凭据；认证继续由用户级 .npmrc 的 scoped 配置提供。
  registry.username = ''
  registry.password = ''
  return registry.toString()
}

function updateRegistryContent(source: string, registry: string): string {
  const lines = source.split(/\r?\n/u).filter((line) => !REGISTRY_LINE.test(line))
  while (lines.at(-1) === '') lines.pop()
  return `${lines.length ? `${lines.join('\n')}\n` : ''}registry=${registry}\n`
}

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function atomicPrivateWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
    await chmod(file, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function syncWebProfileNpmRegistry(dshHome: string, runner: CommandRunner): Promise<string> {
  let result
  try {
    result = runner.run('npm', ['config', 'get', 'registry'])
  } catch {
    throw new Error('无法读取当前 npm registry；请先运行 npm config get registry 检查配置')
  }
  if (result.code !== 0) {
    throw new Error('无法读取当前 npm registry；请先运行 npm config get registry 检查配置')
  }

  const registry = normalizeRegistry(result.stdout)
  const file = path.join(dshHome, 'profiles', 'web', '.npmrc')
  await withRecoverableFileLock(
    `${file}.lock`,
    async () => atomicPrivateWrite(file, updateRegistryContent(await readOptional(file), registry)),
    { label: 'web profile npm registry' },
  )
  return registry
}
