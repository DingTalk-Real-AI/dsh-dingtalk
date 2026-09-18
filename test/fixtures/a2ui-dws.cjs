#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.A2UI_FIXTURE_LOG, JSON.stringify(args) + '\n')
if (args.includes('--help')) {
  const mode = process.env.A2UI_FIXTURE_MODE
  if (mode === 'no-commands') process.exit(1)
  const help = args.includes('consume')
    ? '--flatten user_card_action_triggered'
    : '--summary --content --a2ui-annotations --open-dingtalk-id --conversation-id --biz-id --flow-status'
  process.stdout.write(
    mode === 'no-summary'
      ? help.replace('--summary', '')
      : mode === 'no-events'
        ? help.replace('user_card_action_triggered', '')
        : help,
  )
  process.exit(0)
}
if (args.includes('send-a2ui-card') && process.env.A2UI_FIXTURE_MODE === 'unknown-send') {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'TIMEOUT' } }))
  process.exit(1)
}
if (args.includes('update-a2ui-card') && process.env.A2UI_FIXTURE_MODE === 'update-fails') process.exit(1)
const flow = args[args.indexOf('--flow-status') + 1]
const reply = () => process.stdout.write(JSON.stringify({ ok: true, result: { bizId: 'fixture-biz' } }))
if (flow === 'CONFIRMING' && process.env.A2UI_FIXTURE_SLOW === '1') {
  setTimeout(reply, 2000)
} else reply()
