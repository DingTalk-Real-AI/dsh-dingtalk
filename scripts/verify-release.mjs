import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const registry = 'https://registry.npmjs.org'

async function runCommand(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  })
  return stdout.trim()
}

function requiredEnv(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`缺少发布校验环境变量：${name}`)
  return value
}

function parseJson(output, label) {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`${label} 返回了无效 JSON`)
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function readNonNegativeInteger(env, name, fallback, minimum) {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} 必须是不小于 ${minimum} 的整数`)
  return value
}

async function verifyPublicRelease(env = process.env) {
  const packageName = requiredEnv(env, 'PACKAGE_NAME')
  const repository = requiredEnv(env, 'GITHUB_REPOSITORY')
  const expectedSha = requiredEnv(env, 'GITHUB_SHA')
  const runnerTemp = requiredEnv(env, 'RUNNER_TEMP')
  const attempts = readNonNegativeInteger(env, 'RELEASE_READBACK_ATTEMPTS', 12, 1)
  const delayMs = readNonNegativeInteger(env, 'RELEASE_READBACK_DELAY_MS', 5_000, 0)
  const expectedRepositoryUrl = `git+https://github.com/${repository}.git`
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const cachePath = path.join(runnerTemp, `npm-release-readback-${attempt}`)
    const npmOptions = [`--registry=${registry}`, '--prefer-online', '--cache', cachePath]

    try {
      const releaseVersion = parseJson(
        await runCommand('npm', ['view', packageName, 'dist-tags.latest', '--json', ...npmOptions]),
        'NPM latest 查询',
      )
      if (typeof releaseVersion !== 'string' || !releaseVersion) throw new Error('NPM latest 版本为空')

      const metadata = parseJson(
        await runCommand('npm', [
          'view',
          `${packageName}@${releaseVersion}`,
          'version',
          'gitHead',
          'repository.url',
          'dist.attestations.url',
          '--json',
          ...npmOptions,
        ]),
        `NPM ${releaseVersion} 元数据查询`,
      )
      const attestationUrl = metadata['dist.attestations.url']
      if (metadata.version !== releaseVersion) {
        throw new Error(`NPM 精确版本尚未收敛：expected=${releaseVersion} actual=${metadata.version ?? ''}`)
      }
      if (metadata.gitHead !== expectedSha) {
        throw new Error(`NPM gitHead 尚未收敛：expected=${expectedSha} actual=${metadata.gitHead ?? ''}`)
      }
      if (metadata['repository.url'] !== expectedRepositoryUrl) {
        throw new Error(`NPM repository 不匹配：${metadata['repository.url'] ?? ''}`)
      }
      if (typeof attestationUrl !== 'string' || !attestationUrl.includes('/-/npm/v1/attestations/')) {
        throw new Error('NPM provenance 尚未收敛')
      }

      const publicCliVersion = await runCommand(
        'npx',
        [
          '--yes',
          `--registry=${registry}`,
          '--prefer-online',
          '--cache',
          cachePath,
          '--package',
          `${packageName}@${releaseVersion}`,
          'dsh-dingtalk',
          '--version',
        ],
        { cwd: runnerTemp },
      )
      if (publicCliVersion !== releaseVersion) {
        throw new Error(`公开 CLI 版本尚未收敛：expected=${releaseVersion} actual=${publicCliVersion}`)
      }

      await runCommand('gh', ['release', 'view', `v${releaseVersion}`])
      const tagSha = await runCommand('gh', [
        'api',
        `repos/${repository}/git/ref/tags/v${releaseVersion}`,
        '--jq',
        '.object.sha',
      ])
      if (tagSha !== expectedSha) {
        throw new Error(`GitHub tag 不匹配：expected=${expectedSha} actual=${tagSha}`)
      }

      console.log(`Verified ${packageName}@${releaseVersion}`)
      console.log(`latest=${releaseVersion} gitHead=${metadata.gitHead}`)
      console.log(`repository=${metadata['repository.url']}`)
      console.log(`provenance=${attestationUrl}`)
      console.log(`public-cli=${publicCliVersion}`)
      return
    } catch (error) {
      lastError = error
      console.log(`第 ${attempt}/${attempts} 次公开发布读回未收敛：${errorMessage(error)}`)
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw new Error(`NPM 公开发布在 ${attempts} 次尝试后仍未收敛：${errorMessage(lastError)}`)
}

verifyPublicRelease().catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
