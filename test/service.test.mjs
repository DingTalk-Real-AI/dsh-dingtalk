import assert from 'node:assert/strict'
import test from 'node:test'

import { findRunningDshWeb } from '../lib/service.js'

test('识别 shell 启动和 Node 直接执行的 dsh web，避免 setup 重复占用 3080', () => {
  assert.deepEqual(findRunningDshWeb(' 123 1 /opt/homebrew/bin/dsh web\n'), {
    pid: 123,
    command: '/opt/homebrew/bin/dsh web',
  })
  assert.deepEqual(findRunningDshWeb(' 456 1 node /Users/raph/.nvm/versions/node/v22/bin/dsh/lib/bin.js web\n'), {
    pid: 456,
    command: 'node /Users/raph/.nvm/versions/node/v22/bin/dsh/lib/bin.js web',
  })
  assert.deepEqual(
    findRunningDshWeb(
      ' 700 1 npm exec dsh web\n 701 700 node /Users/raph/.nvm/versions/node/v22/bin/dsh/lib/bin.js web\n',
    ),
    { pid: 701, command: 'node /Users/raph/.nvm/versions/node/v22/bin/dsh/lib/bin.js web' },
  )
  assert.equal(
    findRunningDshWeb(' 800 1 dsh web\n 801 1 node /Users/raph/.nvm/versions/node/v22/bin/dsh/lib/bin.js web\n'),
    undefined,
  )
})
