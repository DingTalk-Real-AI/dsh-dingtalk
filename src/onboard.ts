/**
 * Scan-to-create onboarding: DingTalk's device-code app-registration flow.
 * Ported from dingtalk-openclaw-connector `src/device-auth.ts` (same
 * endpoints, poll semantics, and 2-minute transient-retry window). Scanning
 * the QR creates an in-org internal app + robot and returns its credentials.
 * The setup layer persists them through DSH's credential-store contract.
 */
const BASE = () => process.env.DINGTALK_REGISTRATION_BASE_URL?.trim() || 'https://oapi.dingtalk.com'
const SOURCE = () => process.env.DINGTALK_REGISTRATION_SOURCE?.trim() || 'DING_DSH'

function withRegistrationSource(uri: string, source: string): string {
  const url = new URL(uri)
  url.searchParams.set('source', source)
  return url.toString()
}

interface ApiBody extends Record<string, unknown> {
  errcode: number
  errmsg?: string
}

async function post<T extends ApiBody>(pathname: string, body: unknown, action: string): Promise<T> {
  const resp = await fetch(`${BASE()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`[${action}] HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const data = (await resp.json()) as T
  if (!data || data.errcode !== 0)
    throw new Error(`[${action}] ${data?.errmsg || 'unknown error'} (errcode=${data?.errcode ?? 'N/A'})`)
  return data
}

export interface RegistrationBegin {
  deviceCode: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
}

export async function beginRegistration(): Promise<RegistrationBegin> {
  const source = SOURCE()
  const init = await post<ApiBody & { nonce?: string }>('/app/registration/init', { source }, 'init')
  const nonce = String(init.nonce ?? '').trim()
  if (!nonce) throw new Error('[init] missing nonce')
  const begin = await post<
    ApiBody & {
      device_code?: string
      verification_uri_complete?: string
      expires_in?: number
      interval?: number
    }
  >('/app/registration/begin', { nonce }, 'begin')
  const deviceCode = String(begin.device_code ?? '').trim()
  const verificationUri = String(begin.verification_uri_complete ?? '').trim()
  if (!deviceCode || !verificationUri) throw new Error('[begin] missing device_code / verification_uri_complete')
  const expires = Number(begin.expires_in ?? 7200)
  const interval = Number(begin.interval ?? 5)
  return {
    deviceCode,
    verificationUriComplete: withRegistrationSource(verificationUri, source),
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 7200,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until scanned; transient errors and odd statuses get a 2-minute retry window. */
export async function waitForCredentials(
  begin: RegistrationBegin,
): Promise<{ clientId: string; clientSecret: string }> {
  const RETRY_WINDOW_MS = 2 * 60_000
  const startedAt = Date.now()
  let retryStart = 0
  while (Date.now() - startedAt < begin.expiresInSeconds * 1000) {
    await sleep(begin.intervalSeconds * 1000)
    let polled: ApiBody & { status?: string; client_id?: string; client_secret?: string; fail_reason?: string }
    try {
      polled = await post('/app/registration/poll', { device_code: begin.deviceCode }, 'poll')
    } catch (err) {
      if (!retryStart) retryStart = Date.now()
      if (Date.now() - retryStart < RETRY_WINDOW_MS) continue
      throw err
    }
    const status = String(polled.status ?? '')
      .trim()
      .toUpperCase()
    if (status === 'WAITING') {
      retryStart = 0
      continue
    }
    if (status === 'SUCCESS') {
      const clientId = String(polled.client_id ?? '').trim()
      const clientSecret = String(polled.client_secret ?? '').trim()
      if (!clientId || !clientSecret) throw new Error('authorization succeeded but credentials are missing')
      return { clientId, clientSecret }
    }
    if (!retryStart) retryStart = Date.now()
    if (Date.now() - retryStart < RETRY_WINDOW_MS) continue
    if (status === 'FAIL') throw new Error(polled.fail_reason || 'authorization failed')
    if (status === 'EXPIRED') throw new Error('authorization expired, please retry')
    throw new Error('authorization returned unknown status')
  }
  throw new Error('authorization timeout, please retry')
}

export async function renderQr(content: string): Promise<string | null> {
  try {
    const mod: any = await import('qrcode-terminal')
    const qr = mod.default ?? mod
    if (typeof qr.generate !== 'function') return null
    return await new Promise<string>((resolve) => qr.generate(content, { small: true }, (out: string) => resolve(out)))
  } catch {
    return null
  }
}
