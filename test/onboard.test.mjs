import assert from 'node:assert/strict'
import test from 'node:test'

import { beginRegistration } from '../lib/onboard.js'

async function captureInitRequest(t, source) {
  const originalFetch = globalThis.fetch
  const originalSource = process.env.DINGTALK_REGISTRATION_SOURCE
  const requests = []

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalSource === undefined) delete process.env.DINGTALK_REGISTRATION_SOURCE
    else process.env.DINGTALK_REGISTRATION_SOURCE = originalSource
  })

  if (source === undefined) delete process.env.DINGTALK_REGISTRATION_SOURCE
  else process.env.DINGTALK_REGISTRATION_SOURCE = source
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return new Response(
      JSON.stringify(
        requests.length === 1
          ? { errcode: 0, nonce: 'test-nonce' }
          : {
              errcode: 0,
              device_code: 'test-device-code',
              verification_uri_complete:
                'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=test-user-code&source=STALE_SOURCE',
              expires_in: 60,
              interval: 5,
            },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const registration = await beginRegistration()
  return { initRequest: requests[0], registration }
}

test('扫码注册默认使用 DING_DSH 来源', async (t) => {
  const { initRequest, registration } = await captureInitRequest(t)
  assert.deepEqual(initRequest, {
    url: 'https://oapi.dingtalk.com/app/registration/init',
    body: { source: 'DING_DSH' },
  })
  assert.equal(
    registration.verificationUriComplete,
    'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=test-user-code&source=DING_DSH',
  )
})

test('扫码注册允许环境变量覆盖默认来源', async (t) => {
  const { initRequest, registration } = await captureInitRequest(t, 'DING_TEST_OVERRIDE')
  assert.deepEqual(initRequest, {
    url: 'https://oapi.dingtalk.com/app/registration/init',
    body: { source: 'DING_TEST_OVERRIDE' },
  })
  assert.equal(
    registration.verificationUriComplete,
    'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=test-user-code&source=DING_TEST_OVERRIDE',
  )
})
