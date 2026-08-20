import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const listed = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
if (listed.status !== 0) {
  console.error(listed.stderr || '无法列出 Git 跟踪文件')
  process.exit(listed.status ?? 1)
}

const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{20,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['internal-address', /\b[A-Za-z0-9.-]+\.(?:alibaba-inc\.com|alipay\.net|antfin-inc\.com)\b/gi],
]

const findings = []
for (const file of listed.stdout.split('\0').filter(Boolean)) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (source.includes('\0')) continue
  for (const [name, pattern] of rules) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length
      findings.push(`${file}:${line} [${name}]`)
    }
  }
}

if (findings.length) {
  console.error(`敏感信息扫描失败（仅显示位置，不回显内容）：\n${findings.join('\n')}`)
  process.exit(1)
}
console.log('敏感信息扫描通过')
