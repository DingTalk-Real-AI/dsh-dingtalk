import assert from 'node:assert/strict'
import test from 'node:test'

import { modelAcceptsImages } from '../lib/image-mode.js'

test('图片 Auto 模式读取当前 DSH 模型的 inputModalities', async () => {
  const vision = await modelAcceptsImages(
    'auto',
    { provider: 'p', model: 'vision' },
    {
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    },
  )
  const textOnly = await modelAcceptsImages(
    'auto',
    { provider: 'p', model: 'text' },
    {
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    },
  )

  assert.equal(vision, true)
  assert.equal(textOnly, false)
})

test('图片 Auto 模式在模型信息缺失或查询失败时安全关闭', async () => {
  assert.equal(await modelAcceptsImages('auto', undefined, undefined), false)
  assert.equal(
    await modelAcceptsImages(
      'auto',
      { provider: 'p', model: 'm' },
      {
        resolveModelInfo: async () => {
          throw new Error('catalog unavailable')
        },
      },
    ),
    false,
  )
})

test('Always 与 Never 模式不依赖模型目录', async () => {
  assert.equal(await modelAcceptsImages('always', undefined, undefined), true)
  assert.equal(await modelAcceptsImages('never', { provider: 'p', model: 'm' }, undefined), false)
})
