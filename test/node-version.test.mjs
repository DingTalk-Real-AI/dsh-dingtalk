import assert from 'node:assert/strict'
import test from 'node:test'

import { isSupportedNodeVersion } from '../lib/node-version.js'

test('Node 支持范围与 package engines 完全一致', () => {
  assert.equal(isSupportedNodeVersion('22.18.0'), false)
  assert.equal(isSupportedNodeVersion('22.19.0'), true)
  assert.equal(isSupportedNodeVersion('23.11.1'), false)
  assert.equal(isSupportedNodeVersion('24.0.0'), true)
  assert.equal(isSupportedNodeVersion('26.4.0'), true)
  assert.equal(isSupportedNodeVersion('invalid'), false)
})
