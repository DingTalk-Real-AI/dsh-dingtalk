import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveStateDir } from '../lib/paths.js'

test('setup、doctor 与插件运行时使用同一个 state 目录解析规则', () => {
  assert.equal(resolveStateDir({ DSH_DINGTALK_STATE_DIR: '/tmp/custom-dingtalk-state' }), '/tmp/custom-dingtalk-state')
  assert.equal(resolveStateDir({}), path.join(os.homedir(), '.dsh-dingtalk'))
})
