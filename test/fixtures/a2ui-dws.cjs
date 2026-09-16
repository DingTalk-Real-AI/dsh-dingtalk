#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.A2UI_FIXTURE_LOG, JSON.stringify(args) + '\n')
const flow = args[args.indexOf('--flow-status') + 1]
const reply = () => process.stdout.write(JSON.stringify({ ok: true, result: { bizId: 'fixture-biz' } }))
if (flow === 'CONFIRMING' && process.env.A2UI_FIXTURE_SLOW === '1') {
  setTimeout(reply, 2000)
} else reply()
