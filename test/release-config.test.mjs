import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import releaseConfig from '../release.config.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const issueConfig = readFileSync(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8')
const bugTemplate = readFileSync(new URL('../.github/ISSUE_TEMPLATE/bug.yml', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const readmeZh = readFileSync(new URL('../README.zh-CN.md', import.meta.url), 'utf8')

test('组织公开仓库从 0.5.0 开始通过 Trusted Publisher 发布正式版本', () => {
  assert.deepEqual(releaseConfig.branches, ['main'])
  assert.equal(packageJson.repository.url, 'git+https://github.com/DingTalk-Real-AI/dsh-dingtalk.git')
  assert.match(packageJson.devDependencies['semantic-release'], /^\^25\./)
  assert.match(
    lockfile,
    /semantic-release@25\.0\.9\(supports-color@7\.2\.0\)\(typescript@6\.0\.3\):[\s\S]*'@semantic-release\/npm': 13\.1\.5/,
  )
  assert.equal(packageJson.publishConfig.tag, 'latest')
  assert.equal(packageJson.publishConfig.provenance, true)
  assert.match(releaseWorkflow, /id-token: write/)
  assert.match(releaseWorkflow, /node-version: '24\.10\.0'/)
  assert.match(releaseWorkflow, /npm install --global npm@11\.19\.0/)
  assert.doesNotMatch(releaseWorkflow, /npm install --global npm@latest/)
  assert.match(ciWorkflow, /pnpm\/action-setup@v6/)
  assert.match(releaseWorkflow, /pnpm\/action-setup@v6/)
  assert.doesNotMatch(`${ciWorkflow}\n${releaseWorkflow}`, /pnpm\/action-setup@v4/)
  assert.match(releaseWorkflow, /environment: npm-production/)
  assert.match(releaseWorkflow, /BOOTSTRAP_VERSION: '0\.5\.0'/)
  assert.match(releaseWorkflow, /npm publish --access public --tag latest/)
  assert.match(releaseWorkflow, /node scripts\/verify-release\.mjs/)
  assert.match(releaseWorkflow, /already belongs to this commit/)
  assert.doesNotMatch(releaseWorkflow, /NODE_AUTH_TOKEN|NPM_BOOTSTRAP_TOKEN|NPM_CONFIG_PROVENANCE: 'false'/)
})

test('公开支持入口和审批说明不再引用个人仓库或旧首发版本', () => {
  assert.match(issueConfig, /DingTalk-Real-AI\/dsh-dingtalk\/security\/advisories\/new/)
  assert.doesNotMatch(issueConfig, /haofeng0705/)
  assert.doesNotMatch(bugTemplate, /placeholder: 0\.1\.0/)
  assert.match(bugTemplate, /placeholder: latest/)
  assert.match(readme, /owner-only text confirmation code/)
  assert.match(readmeZh, /管理员专用的文字确认码/)
})
