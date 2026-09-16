import assert from 'node:assert/strict'
import test from 'node:test'
import { describeTurnError } from '../lib/errors.js'

test('INVALID_REQUEST 角色不兼容不能因 request id 内含 401 而误报凭据或额度', () => {
  const message = '400: messages[0].role: unknown variant developer (request id: fixture-6401403593)'
  const output = describeTurnError(message, 'INVALID_REQUEST')
  assert.match(output, /模型请求参数或协议不兼容/)
  assert.doesNotMatch(output, /凭据无效或额度不足/)
  assert.doesNotMatch(describeTurnError(message), /凭据无效或额度不足/)
})

test('真正的 401 仍提示凭据错误', () => {
  assert.match(describeTurnError('401 Unauthorized'), /模型凭据无效或额度不足/)
})
