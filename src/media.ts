/**
 * Inbound media: exchange a robot message downloadCode for its OSS URL and
 * fetch the bytes (connector's downloadMediaByCode port). The binary GET must
 * not send a Content-Type header or the OSS signature check fails.
 */

const DINGTALK_API = 'https://api.dingtalk.com'

/** 普通文件和图片回发的官方上传上限；入站也使用相同的资源预算。 */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024
export const FILE_TYPES = new Set(['xlsx', 'pdf', 'zip', 'rar', 'doc', 'docx'])
export const IMAGE_TYPES = new Set(['jpg', 'jpeg', 'gif', 'png', 'bmp'])

/** 通用文件下载，不把未知二进制误标为 JPEG；下载链接和下载码不进入日志。 */
export async function downloadFileByCode(
  token: string,
  robotCode: string,
  downloadCode: string,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  try {
    const resp = await fetch(`${DINGTALK_API}/v1.0/robot/messageFiles/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ downloadCode, robotCode }),
      signal: bounded,
    })
    if (!resp.ok) throw new Error('exchange_failed')
    const { downloadUrl } = (await resp.json()) as { downloadUrl?: unknown }
    if (typeof downloadUrl !== 'string' || new URL(downloadUrl).protocol !== 'https:')
      throw new Error('invalid_download_url')
    // OSS 签名 GET 不携带应用 Token 或额外 Content-Type。
    const binary = await fetch(downloadUrl, { signal: bounded })
    if (!binary.ok) throw new Error('fetch_failed')
    if (Number(binary.headers.get('content-length')) > MAX_MEDIA_BYTES) {
      await binary.body?.cancel()
      throw new Error('too_large')
    }
    if (!binary.body) throw new Error('empty_body')
    const reader = binary.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_MEDIA_BYTES) {
          await reader.cancel()
          throw new Error('too_large')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return new Uint8Array(Buffer.concat(chunks, size))
  } catch {
    log('inbound file download failed (permission, expiry, size or transport)')
    return null
  }
}

export interface InboundImage {
  data: Uint8Array
  mediaType: string
}

function sniffMediaType(bytes: Uint8Array, headerType: string | null): string {
  if (headerType && headerType.startsWith('image/')) return headerType.split(';')[0]
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  return 'image/jpeg'
}

export async function downloadImageByCode(
  token: string,
  robotCode: string,
  downloadCode: string,
  log: (line: string) => void,
): Promise<InboundImage | null> {
  try {
    const resp = await fetch(`${DINGTALK_API}/v1.0/robot/messageFiles/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ downloadCode, robotCode }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) {
      log(`media download-code exchange failed ${resp.status}`)
      return null
    }
    const { downloadUrl } = (await resp.json()) as { downloadUrl?: string }
    if (!downloadUrl) {
      log('media download-code exchange returned no downloadUrl')
      return null
    }
    const binary = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) })
    if (!binary.ok) {
      log(`media binary fetch failed ${binary.status}`)
      return null
    }
    const data = new Uint8Array(await binary.arrayBuffer())
    return { data, mediaType: sniffMediaType(data, binary.headers.get('content-type')) }
  } catch (err) {
    log(`media download error: ${err instanceof Error ? err.message : err}`)
    return null
  }
}
