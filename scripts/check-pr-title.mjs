const title = process.env.PR_TITLE?.trim() ?? ''
const pattern = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?(!)?: .+/

if (!pattern.test(title)) {
  console.error(`PR 标题不符合 Conventional Commits：${JSON.stringify(title)}`)
  console.error('示例：feat(setup): add guided onboarding')
  process.exit(1)
}
