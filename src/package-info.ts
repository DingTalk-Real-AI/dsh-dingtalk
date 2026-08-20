import { readFileSync } from 'node:fs'

interface PackageManifest {
  name: string
  version: string
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest

export const packageName = manifest.name
export const packageVersion = manifest.version
export const exactPackageSpec = `${packageName}@${packageVersion}`
