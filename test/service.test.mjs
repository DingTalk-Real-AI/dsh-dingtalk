import assert from 'node:assert/strict'
import test from 'node:test'

import { dshWebMayBeRunningFromOutput, dshWebStatusFromProbe, findRunningDshWeb } from '../lib/service.js'

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
  assert.equal(
    dshWebMayBeRunningFromOutput(
      ' 800 1 dsh web\n 801 1 node /Users/raph/.nvm/versions/node/v22/bin/dsh/lib/bin.js web\n',
    ),
    true,
  )
  assert.equal(dshWebMayBeRunningFromOutput(' 900 1 node unrelated.js\n'), false)
  assert.equal(dshWebStatusFromProbe(1, ''), 'unknown')
  assert.equal(dshWebStatusFromProbe(0, ' 900 1 node unrelated.js\n'), 'stopped')
  assert.equal(dshWebStatusFromProbe(0, ' 901 1 /opt/homebrew/bin/dsh web\n'), 'running')
  assert.equal(dshWebStatusFromProbe(0, ' 902 1 sh -c echo dsh web\n'), 'unknown')
  assert.equal(findRunningDshWeb(' 902 1 sh -c echo dsh web\n'), undefined)
})
