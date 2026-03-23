#!/usr/bin/env node
/**
 * fathom-match.mjs — Match Fathom call recordings to appointments in sales_data.json
 *
 * For each Fathom sales call in the date range:
 *   - Matches to an appointment by date + fuzzy contact name
 *   - Sets fathomLink on the appointment
 *   - If appointment is confirmed/new with no outcome, marks it 'showed'
 *     (close/not_closed is left for manual entry in Needs Review)
 *
 * Usage:
 *   node scripts/fathom-match.mjs --from 2025-12-01 --to 2026-03-31
 *   node scripts/fathom-match.mjs --from 2026-03-01 --to 2026-03-31 --dry-run
 */

import '../agents/_shared/env-loader.mjs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iterateMeetings } from '../agents/_shared/fathom/index.mjs'

const root     = path.resolve(fileURLToPath(import.meta.url), '../../')
const DATA_FILE = path.join(root, 'data', 'sales_data.json')

const args   = process.argv.slice(2)
const _fi    = args.indexOf('--from'); const fromArg = _fi !== -1 ? args[_fi+1] : null
const _ti    = args.indexOf('--to');   const toArg   = _ti !== -1 ? args[_ti+1] : null
const dryRun = args.includes('--dry-run')

if (!fromArg || !toArg) {
  console.error('Usage: node scripts/fathom-match.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]')
  process.exit(1)
}

// ── Name normalization + fuzzy match ─────────────────────────────────────────
function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function fuzzyMatch(fathomName, apptName) {
  const a = normName(fathomName)
  const b = normName(apptName)
  if (!a || !b) return false
  if (a === b) return true
  const wa = a.split(' ')
  const wb = b.split(' ')
  // full phrase contained as words (e.g. "john bear" in "john bear projects")
  const aInB = a.split(' ').every(w => wb.includes(w))
  const bInA = b.split(' ').every(w => wa.includes(w))
  if (aInB || bInA) return true
  // word overlap — only if at least one side has >1 word
  if (wa.length < 2 && wb.length < 2) return false
  return wa.some(w => w.length > 2 && wb.includes(w))
}

// Get the external (non-Evolute) invitee name from a Fathom meeting
function externalName(meeting) {
  const ext = meeting.calendar_invitees?.find(i => i.is_external)
  if (ext?.name) return ext.name
  // fallback: parse from title "Name x AI Strategy Session on DD Mon YYYY"
  const m = meeting.title?.match(/^(.+?)\s+x\s+/i)
  return m ? m[1].trim() : null
}

// ── Is this a sales call? (title-based, no LLM) ──────────────────────────────
function isSalesCall(meeting) {
  const t = (meeting.title || '').toLowerCase()
  if (!t) return false
  const deny = ['promotion', 'reveal', 'highlevel', 'standup', 'internal', 'interview', 'onboarding', 'ops']
  if (deny.some(w => t.includes(w))) return false
  const allow = ['ai growth game plan', 'ai strategy session', 'strategy session', 'growth game plan', 'discovery call', 'x maxwell', '- maxwell', 'x max', '- max']
  return allow.some(w => t.includes(w))
}

// ── Load data ─────────────────────────────────────────────────────────────────
const raw  = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const appts = raw.appointments

// Index appointments by date → array (multiple appts per day)
const byDate = {}
for (const a of appts) {
  const d = a.startTime?.slice(0, 10)
  if (!d) continue
  if (!byDate[d]) byDate[d] = []
  byDate[d].push(a)
}

// ── Fetch Fathom calls in range ───────────────────────────────────────────────
console.log(`Fetching Fathom calls ${fromArg} → ${toArg}…`)
const calls = []
for await (const m of iterateMeetings({ pageSize: 50, maxPages: 200 })) {
  const d = (m.scheduled_start_time || m.recording_start_time || '').slice(0, 10)
  if (!d) continue
  if (d < fromArg) break   // iterateMeetings returns newest-first; stop when past range
  if (d > toArg)  continue
  if (isSalesCall(m)) calls.push({ ...m, _date: d })
}
console.log(`Found ${calls.length} sales calls in range.\n`)

// ── Match ─────────────────────────────────────────────────────────────────────
let matched = 0, alreadyHad = 0, unmatched = 0

for (const call of calls) {
  const fName = externalName(call)
  const candidates = byDate[call._date] || []

  // Prefer exact normalized match over fuzzy to avoid false positives on common words
  const exactMatch = c => normName(fName) === normName(c.contactName)
  let appt = candidates.find(exactMatch) || candidates.find(a => fuzzyMatch(fName, a.contactName))

  // ±1 day fallback (call recorded day after scheduled)
  if (!appt) {
    const prev = new Date(call._date); prev.setDate(prev.getDate() - 1)
    const next = new Date(call._date); next.setDate(next.getDate() + 1)
    const prevD = prev.toISOString().slice(0, 10)
    const nextD = next.toISOString().slice(0, 10)
    const nearby = [...(byDate[prevD]||[]), ...(byDate[nextD]||[])]
    appt = nearby.find(exactMatch) || nearby.find(a => fuzzyMatch(fName, a.contactName))
  }

  if (!appt) {
    console.log(`[unmatched] ${call._date} — "${fName}" (${call.share_url})`)
    unmatched++
    continue
  }

  const updates = {}

  // Always set fathomLink if missing or different
  const link = call.share_url || call.url
  if (link && appt.fathomLink !== link) updates.fathomLink = link
  // Note: we do NOT set status='showed' — 'showed' is not a valid final status.
  // The appointment will surface in Needs Review via appointmentStatus='showed' (GHL field)
  // for the user to resolve to closed/not_closed.

  if (Object.keys(updates).length === 0) {
    alreadyHad++
    continue
  }

  matched++
  console.log(`[match] ${call._date} — "${fName}" → "${appt.contactName}"${updates.fathomLink ? ' + fathomLink' : ''}`)

  if (!dryRun) Object.assign(appt, updates)
}

// ── Save ──────────────────────────────────────────────────────────────────────
if (!dryRun && matched > 0) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2))
  console.log('\nSaved.')
}

console.log(`
── Summary ──────────────────────────────────
  Sales calls found:   ${calls.length}
  Matched + updated:   ${matched}
  Already up to date:  ${alreadyHad}
  Unmatched:           ${unmatched}
${dryRun ? '\n  (dry run — no changes written)' : ''}`)
