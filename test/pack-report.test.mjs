import assert from 'node:assert/strict'
import test from 'node:test'

import { extractPackReport } from '../scripts/pack-report.mjs'

const report = {
  name: '@dingtalk-real-ai/dsh-dingtalk',
  files: [{ path: 'package.json' }],
  unpackedSize: 1,
}

test('兼容 npm 11 的数组格式', () => {
  assert.equal(extractPackReport([report], report.name), report)
})

test('兼容 npm 12 以包名为键的对象格式', () => {
  assert.equal(extractPackReport({ [report.name]: report }, report.name), report)
})

test('未知 npm pack 输出提供明确错误', () => {
  assert.throws(() => extractPackReport({}, report.name), /无法识别 npm pack --json 输出/)
})
