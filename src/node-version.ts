/** 与 package.json engines 的 `^22.19.0 || >=24.0.0` 保持一致。 */
export function isSupportedNodeVersion(version: string): boolean {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 19) || major >= 24
}
