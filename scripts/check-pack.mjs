import { spawnSync } from 'node:child_process'
import { extractPackReport } from './pack-report.mjs'
import packageJson from '../package.json' with { type: 'json' }

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packed = spawnSync(npmCommand, ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', '.npm-cache'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  shell: process.platform === 'win32',
})

if (packed.status !== 0) {
  console.error(packed.stderr || packed.stdout || packed.error?.message || 'npm pack 执行失败')
  process.exit(packed.status ?? 1)
}

const report = extractPackReport(JSON.parse(packed.stdout), packageJson.name)
const files = report.files.map((entry) => entry.path)
const allowed = [
  /^package\.json$/,
  /^README\.md$/,
  /^README\.zh-CN\.md$/,
  /^LICENSE$/,
  /^THIRD_PARTY_NOTICES\.md$/,
  /^CHANGELOG\.md$/,
  /^cordis\.patch\.yml$/,
  /^lib\//,
  /^assets\//,
]
const unexpected = files.filter((file) => !allowed.some((pattern) => pattern.test(file)))
if (unexpected.length) throw new Error(`NPM tarball 包含未授权文件：${unexpected.join(', ')}`)

const required = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/bin.js',
]
const missing = required.filter((file) => !files.includes(file))
if (missing.length) throw new Error(`NPM tarball 缺少必需文件：${missing.join(', ')}`)
if (files.some((file) => /(^|\/)(sdk|src|test)(\/|$)/.test(file))) {
  throw new Error('NPM tarball 不得包含 SDK workspace、源码或测试目录')
}
if (report.unpackedSize > 10 * 1024 * 1024) throw new Error(`NPM tarball 解包体积过大：${report.unpackedSize}`)

console.log(`NPM tarball 校验通过：${files.length} files, ${report.unpackedSize} bytes unpacked`)
