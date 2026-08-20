/**
 * Inbound media: exchange a robot message downloadCode for its OSS URL and
 * fetch the bytes (connector's downloadMediaByCode port). The binary GET must
 * not send a Content-Type header or the OSS signature check fails.
 */

const DINGTALK_API = 'https://api.dingtalk.com'

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
