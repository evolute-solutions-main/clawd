#!/usr/bin/env node
// Dump confirmed messages content for a given date
import fs from 'node:fs'
import path from 'node:path'
import { fetchChannelWindow } from '../../_shared/discord-fetcher/index.mjs'
import { CHANNELS } from './appointmentsDailyReport.mjs'

function loadSecrets(repoRoot) {
  try {
    const p = path.join(repoRoot, '.secrets.env')
    const text = fs.readFileSync(p, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) {
        const [, k, v] = m
        if (!process.env[k]) process.env[k] = v
      }
    }
  } catch {}
}

const repoRoot = process.cwd()
loadSecrets(repoRoot)

const dateArg = process.argv.find(a => a.startsWith('--date='))
const date = dateArg ? dateArg.split('=')[1] : null
if (!date) {
  console.error('Usage: node agents/appointment-tracking/scripts/dump-confirmed.mjs --date=YYYY-MM-DD')
  process.exit(1)
}

const rows = await fetchChannelWindow({ channelIds: [CHANNELS.confirmed], date, repoRoot, guildId: '1164939432722440282' })
const zapier = rows.filter(r => r.author.toLowerCase() === 'zapier')
for (const r of zapier) {
  const snippet = (r.content || '').replace(/\s+/g,' ').slice(0, 400)
  console.log(JSON.stringify({ id: r.id, timeLocal: r.tsLocal, channelId: r.channelId, contentSnippet: snippet }))
}
