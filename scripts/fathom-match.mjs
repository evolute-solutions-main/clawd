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

const root              = path.resolve(fileURLToPath(import.meta.url), '../../')
const DATA_FILE         = path.join(root, 'data', 'sales_data.json')
const UNMATCHED_FILE    = path.join(root, 'data', 'unmatched_fathom.json')
const ALIASES_FILE      = path.join(root, 'data', 'fathom_aliases.json')

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

// Get the external invitee email from a Fathom meeting
function externalEmail(meeting) {
  const ext = meeting.calendar_invitees?.find(i => i.is_external)
  return ext?.email || null
}

// Match priority: alias → exact name → email → fuzzy name
// Returns { appt, strategy } or undefined.
function findMatch(candidates, fName, fEmail) {
  const alias = aliases.find(a => normName(a.fathomName) === normName(fName))
  if (alias) {
    const hit = candidates.find(c => normName(alias.contactName) === normName(c.contactName))
    if (hit) return { appt: hit, strategy: 'alias' }
  }
  const byExact = candidates.find(c => normName(fName) === normName(c.contactName))
  if (byExact) return { appt: byExact, strategy: 'exact' }
  const byEmail = fEmail ? candidates.find(c => c.email && fEmail.toLowerCase() === c.email.toLowerCase()) : null
  if (byEmail) return { appt: byEmail, strategy: 'email' }
  const byFuzzy = candidates.find(c => fuzzyMatch(fName, c.contactName))
  if (byFuzzy) return { appt: byFuzzy, strategy: 'fuzzy' }
  return null
}

// ── Is this a sales call? (title-based, no LLM) ──────────────────────────────
function isSalesCall(meeting) {
  const t = (meeting.title || '').toLowerCase()
  if (!t) return false
  const deny = ['promotion', 'reveal', 'highlevel', 'standup', 'interview', 'onboarding']
  if (deny.some(w => t.includes(w))) return false
  const allow = ['ai growth game plan', 'ai strategy session', 'strategy session', 'growth game plan', 'discovery call', 'x maxwell', '- maxwell', 'x max', '- max']
  return allow.some(w => t.includes(w))
}

// ── Load data ─────────────────────────────────────────────────────────────────
const raw   = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const appts = raw.appointments

// fathom_aliases.json — manual overrides for when Fathom uses a company name,
// alias, or any name that doesn't match the GHL contact name.
// Format: [{ "fathomName": "...", "contactName": "..." }, ...]
// When a Fathom call's external name matches an alias, the alias contactName is
// used for matching instead — bypassing email and fuzzy matching entirely.
// Add entries here whenever a call ends up in unmatched_fathom.json due to a name mismatch.
let aliases = []
try { aliases = JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) } catch {}

// ── Alias-driven dedup ────────────────────────────────────────────────────────
// For each alias, check if there are two appointments on the same date where one
// has the fathomName (company/alias name from GHL) and another has the contactName
// (the real person's name, usually from a manual xl_ record). If found, merge them:
// keep the GHL record (real ID, phone, email, fathom link), pull outcome fields from
// the person-name record, fix contactName, and drop the duplicate.
// This prevents the situation where a company-name GHL record and a person-name xl_
// record coexist for the same call, with outcome and fathom link split across both.
const OUTCOME_FIELDS = ['status','source','excluded','closer','cashCollected',
  'cashCollectedAfterFirstCall','contractRevenue','followUpBooked','fathomLink','offerMade']

let aliasDeduped = 0
for (const alias of aliases) {
  const fromNorm = normName(alias.fathomName)
  const toNorm   = normName(alias.contactName)

  // Find all pairs on the same date
  const companyRecords = appts.filter(a => normName(a.contactName) === fromNorm)
  for (const company of companyRecords) {
    const date = company.startTime?.slice(0, 10)
    if (!date) continue
    const person = appts.find(a =>
      normName(a.contactName) === toNorm && a.startTime?.slice(0, 10) === date && a.id !== company.id
    )
    if (!person) continue

    // Merge: person's outcome fields → company record; fix name; drop person record
    for (const f of OUTCOME_FIELDS) {
      if (person[f] !== undefined && person[f] !== null) company[f] = person[f]
    }
    company.contactName = alias.contactName
    const personIdx = appts.indexOf(person)
    if (personIdx !== -1) appts.splice(personIdx, 1)
    aliasDeduped++
    console.log(`[alias dedup] Merged "${alias.fathomName}" + "${alias.contactName}" → kept GHL record as "${alias.contactName}" (${date})`)
  }
}
if (aliasDeduped > 0 && !dryRun) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2))
  console.log(`Saved ${aliasDeduped} alias-dedup merge(s).\n`)
}

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
const unmatchedRecords = []

for (const call of calls) {
  const fName  = externalName(call)
  const fEmail = externalEmail(call)
  const candidates = byDate[call._date] || []

  // Match priority: alias → exact name → email → fuzzy name
  let result = findMatch(candidates, fName, fEmail)
  let matchDay = call._date

  // ±1 day fallback (call recorded day after scheduled)
  if (!result) {
    const prev = new Date(call._date); prev.setDate(prev.getDate() - 1)
    const next = new Date(call._date); next.setDate(next.getDate() + 1)
    const prevD = prev.toISOString().slice(0, 10)
    const nextD = next.toISOString().slice(0, 10)
    const nearby = [...(byDate[prevD]||[]), ...(byDate[nextD]||[])]
    result = findMatch(nearby, fName, fEmail)
    if (result) matchDay = result.appt.startTime?.slice(0, 10)
  }

  if (!result) {
    const link = call.share_url || call.url
    console.log(`[unmatched] ${call._date} — "${fName}" (${link})`)
    unmatchedRecords.push({ name: fName, date: call._date, fathomLink: link })
    unmatched++
    continue
  }

  const { appt, strategy } = result
  if (strategy !== 'exact') {
    console.log(`[${strategy} match] "${fName}"${fEmail ? ` <${fEmail}>` : ''} → "${appt.contactName}" on ${matchDay}`)
  }

  const updates = {}

  // Never set fathomLink on a no_show or cancelled appointment.
  // The call didn't happen, so no recording should exist.
  // If one does, it's a false-positive match — log it as unmatched instead.
  if (['no_show','cancelled'].includes(appt.status)) {
    const link = call.share_url || call.url
    console.log(`[conflict] ${call._date} — "${fName}" matched "${appt.contactName}" but status=${appt.status}; skipping fathomLink (${link})`)
    unmatchedRecords.push({ name: fName, date: call._date, fathomLink: link, note: `matched to ${appt.contactName} (${appt.status}) — verify status or false-positive` })
    unmatched++
    continue
  }

  // Set fathomLink if missing or different
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
if (!dryRun && unmatchedRecords.length > 0) {
  fs.writeFileSync(UNMATCHED_FILE, JSON.stringify(unmatchedRecords, null, 2))
  console.log(`Wrote ${unmatchedRecords.length} unmatched recording(s) to unmatched_fathom.json`)
}

console.log(`
── Summary ──────────────────────────────────
  Sales calls found:   ${calls.length}
  Matched + updated:   ${matched}
  Already up to date:  ${alreadyHad}
  Unmatched:           ${unmatched}
${dryRun ? '\n  (dry run — no changes written)' : ''}`)
