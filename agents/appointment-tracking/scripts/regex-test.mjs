#!/usr/bin/env node
// Regex isolation harness for Zapier appointment messages
// Usage:
//   node agents/appointment-tracking/scripts/regex-test.mjs --date=YYYY-MM-DD [--channel=confirmed|unconfirmed]
// Prints JSONL of results: {id, channelId, timeLocal, name, phone, calendar, flags}

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
const chArg = process.argv.find(a => a.startsWith('--channel='))
const ch = chArg ? chArg.split('=')[1] : null
if (!date) {
  console.error('Usage: node agents/appointment-tracking/scripts/regex-test.mjs --date=YYYY-MM-DD [--channel=confirmed|unconfirmed]')
  process.exit(1)
}

const wantedChannels = (!ch)
  ? [CHANNELS.unconfirmed, CHANNELS.confirmed]
  : (ch === 'confirmed' ? [CHANNELS.confirmed] : [CHANNELS.unconfirmed])

function parseFields(content) {
  const out = {}
  let m
  // Name tolerant
  m = content.match(/\*\*Name:\*\*\s*([^\n\r]+)/i) || content.match(/👤\s*\*\*Name:\*\*\s*([^\n\r]+)/i)
  out.name = m ? m[1].trim().replace(/\s+/g,' ') : undefined
  if (out.name) out.name = out.name.replace(/\s*-\s*$/,'')
  // Phone
  m = content.match(/\*\*Phone:\*\*\s*([+\d][\d\s()\-]+)/i)
  if (m) out.phone = m[1].trim().replace(/[^\d+]/g,'')
  // Calendar
  m = content.match(/\*\*Calendar:\*\*\s*([^\n\r]+)/i)
  out.calendar = m ? m[1].trim() : undefined
  // Time
  m = content.match(/\*\*Time:\*\*\s*([^\n\r]+)/i)
  out.timeText = m ? m[1].trim() : undefined
  return out
}

function coldFlags(calendar, body) {
  const cal = (calendar||'').toLowerCase()
  const txt = (body||'').toLowerCase()
  return {
    cal_exact: /\bcold\s*sms\b/i.test(calendar||''),
    cal_split: cal.includes('cold') && cal.includes('sms'),
    body_exact: txt.includes('cold sms'),
  }
}

(async () => {
  const rows = await fetchChannelWindow({ channelIds: wantedChannels, date, repoRoot, guildId: '1164939432722440282' })
  const zapier = rows.filter(r => r.author.toLowerCase() === 'zapier')
  for (const r of zapier) {
    const f = parseFields(r.content || '')
    const flags = coldFlags(f.calendar, r.content)
    const item = {
      id: r.id,
      channelId: r.channelId,
      timeLocal: r.tsLocal,
      name: f.name || null,
      phone: f.phone || null,
      calendar: f.calendar || null,
      flags
    }
    console.log(JSON.stringify(item))
  }
})().catch(e => { console.error(e); process.exit(1) })
