import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

test('DSH bundle patch 加载的模块名与发布包名一致', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))

  assert.equal(patch[0].insert[0].name, manifest.name)
})
