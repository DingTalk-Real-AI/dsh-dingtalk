import type { ImageMode } from './setup-state.js'

export interface ModelRoute {
  provider: string
  model: string
}

export interface ModelDirectory {
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

export async function modelAcceptsImages(
  mode: ImageMode,
  route: ModelRoute | undefined,
  directory: ModelDirectory | undefined,
): Promise<boolean> {
  if (mode === 'always') return true
  if (mode === 'never' || !route || !directory) return false
  try {
    const info = await directory.resolveModelInfo(route.provider, route.model)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}
