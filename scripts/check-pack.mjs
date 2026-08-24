import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-dingtalk-pack-'))
try {
  const stagedPackage = path.join(stagingRoot, 'package')
  for (const file of files) {
    const destination = path.join(stagedPackage, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.resolve(file), destination)
  }
  await symlink(
    path.resolve('node_modules'),
    path.join(stagedPackage, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  const dshHome = path.join(stagingRoot, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  const credentialsFile = path.join(dshHome, '.credentials.yaml')
  await writeFile(
    credentialsFile,
    'version: 1\nrefs:\n  DINGTALK_CLIENT_ID: packed-app\n  DINGTALK_CLIENT_SECRET: packed-secret\n',
    { mode: 0o600 },
  )
  if (process.platform !== 'win32') await chmod(credentialsFile, 0o600)
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    '- id: dingtalk-channel\n  config:\n    ownerStaffId: packed-owner\n',
  )
  const doctor = spawnSync(process.execPath, [path.join(stagedPackage, 'lib', 'bin.js'), 'doctor', '--offline'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: stagingRoot, DSH_HOME: dshHome },
  })
  if (doctor.status !== 0 || !/应用凭据：已配置/.test(doctor.stdout)) {
    throw new Error(
      doctor.stderr || doctor.stdout || doctor.error?.message || 'NPM tarball 中的 doctor 无法读取 DSH v1 凭据',
    )
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true })
}

console.log(`NPM tarball 校验通过：${files.length} files, ${report.unpackedSize} bytes unpacked`)
