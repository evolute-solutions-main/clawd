/**
 * Fetch outbound dial counts from GHL by setter per day.
 * Iterates every conversation assigned to each setter,
 * pulls all messages, and counts TYPE_CALL outbound messages.
 *
 * Usage:
 *   node scripts/fetch-dials.mjs --from 2026-01-01 --to 2026-03-19
 *
 * Output: updates sales_data.json — adds/updates a top-level "dials" array:
 *   [ { setter, date, dials }, ... ]
 * Also writes dials.json as the inject-able standalone file.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import '../agents/_shared/env-loader.mjs'

const root     = path.resolve(fileURLToPath(import.meta.url), '../../')
const DIALS_FILE = path.join(root, 'dials.json')

const GHL_BASE = 'https://services.leadconnectorhq.com'
const LOC      = process.env.GHL_LOCATION_ID || 'Fv38qyVITGwToy2uDZgc'
const TOKEN    = process.env.GHL_PRIVATE_INTEGRATION_TOKEN
if (!TOKEN) throw new Error('GHL_PRIVATE_INTEGRATION_TOKEN missing')

const HEADERS = { 'Authorization': `Bearer ${TOKEN}`, 'Version': '2021-04-15' }

const SETTERS = {
  'ddUpjf6Fj9k9efSf874G': 'Eddie Stiwar Murillo Becerra',
  'YQcDJN2MiXUJfaAiKqyj': 'Daniel Franco',
  'VwnP4BSH4oQR6yWOaV4Q': 'Randy Ray Nadera',
}

const args   = process.argv.slice(2)
const FROM   = args[args.indexOf('--from') + 1] || '2026-01-01'
const TO     = args[args.indexOf('--to')   + 1] || new Date().toISOString().slice(0, 10)

async function ghl(endpoint, params = {}) {
  const url = new URL(endpoint, GHL_BASE)
  url.searchParams.set('locationId', LOC)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  const r = await fetch(url.toString(), { headers: HEADERS })
  if (!r.ok) throw new Error(`GHL ${r.status}: ${await r.text()}`)
  return r.json()
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function getAllConversations(userId) {
  const all = []
  let cursor = undefined
  do {
    const data = await ghl('/conversations/search', { assignedTo: userId, limit: 20, ...(cursor ? { cursor } : {}) })
    all.push(...(data.conversations || []))
    // GHL returns nextPageUrl or similar — check for cursor
    const next = data.meta?.nextPageUrl
    cursor = next ? new URL(next).searchParams.get('cursor') : undefined
    await sleep(100)
  } while (cursor)
  return all
}

async function getCallMessages(convId) {
  const msgs = []
  let lastId = undefined
  do {
    const data = await ghl(`/conversations/${convId}/messages`, { limit: 100, ...(lastId ? { lastMessageId: lastId } : {}) })
    const batch = data.messages?.messages || []
    msgs.push(...batch)
    lastId = data.messages?.nextPage ? data.messages?.lastMessageId : undefined
    if (batch.length) await sleep(80)
  } while (lastId)
  return msgs
}

async function main() {
  console.log(`Fetching outbound dials ${FROM} → ${TO}\n`)

  // { 'Eddie': { '2026-01-15': 3, ... }, ... }
  const dialsBySetterDate = {}

  for (const [userId, setterName] of Object.entries(SETTERS)) {
    console.log(`── ${setterName}`)
    dialsBySetterDate[setterName] = {}

    const convs = await getAllConversations(userId)
    console.log(`   ${convs.length} conversations`)

    let processed = 0
    for (const conv of convs) {
      const msgs = await getCallMessages(conv.id)
      const calls = msgs.filter(m =>
        m.messageType === 'TYPE_CALL' &&
        m.direction   === 'outbound'  &&
        m.userId      === userId
      )
      for (const c of calls) {
        const date = c.dateAdded?.slice(0, 10)
        if (!date || date < FROM || date > TO) continue
        dialsBySetterDate[setterName][date] = (dialsBySetterDate[setterName][date] || 0) + 1
      }
      processed++
      if (processed % 10 === 0) process.stdout.write(`   ${processed}/${convs.length}...\r`)
    }

    const total = Object.values(dialsBySetterDate[setterName]).reduce((s, n) => s + n, 0)
    console.log(`   ${total} outbound dials in range`)
  }

  // Build flat array: [ { setter, date, dials } ]
  const result = []
  for (const [setter, byDate] of Object.entries(dialsBySetterDate)) {
    for (const [date, dials] of Object.entries(byDate).sort()) {
      result.push({ setter, date, dials })
    }
  }

  fs.writeFileSync(DIALS_FILE, JSON.stringify(result, null, 2))
  console.log(`\nWrote ${result.length} rows to dials.json`)
}

main().catch(err => { console.error(err); process.exit(1) })
