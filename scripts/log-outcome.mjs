#!/usr/bin/env node
/**
 * log-outcome.mjs — Interactively record call outcomes for appointments with missing data.
 *
 * Walks through each gap found by check-gaps.mjs and prompts for:
 *   - closed / not_closed / no_show / cancelled
 *   - closer name
 *   - cash collected
 *   - contract revenue
 *   - follow-up booked?
 *
 * After all updates, rebuilds the dashboard.
 *
 * Usage:
 *   node scripts/log-outcome.mjs                      (all gaps)
 *   node scripts/log-outcome.mjs --from 2026-03-01    (limit by date)
 *   node scripts/log-outcome.mjs --name "John Smith"  (single contact)
 */

import fs       from 'fs'
import path     from 'path'
import readline from 'readline'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const root      = path.resolve(fileURLToPath(import.meta.url), '../../')
const DATA_FILE = path.join(root, 'data', 'sales_data.json')

const args = process.argv.slice(2)
const _fi  = args.indexOf('--from'); const fromArg = _fi !== -1 ? args[_fi + 1] || null : null
const _ti  = args.indexOf('--to');   const toArg   = _ti !== -1 ? args[_ti + 1] || null : null
const _ni  = args.indexOf('--name'); const nameArg = _ni !== -1 ? args[_ni + 1] || null : null

// ── Load data ─────────────────────────────────────────────────────────────────
const raw   = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const data  = Array.isArray(raw) ? { appointments: raw, dials: [] } : raw
const appts = data.appointments

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

function inWindow(dateStr) {
  const d = dateStr?.slice(0, 10)
  if (!d) return false
  if (fromArg && d < fromArg) return false
  if (toArg   && d > toArg)   return false
  return true
}

// ── Find gaps ─────────────────────────────────────────────────────────────────
let gaps = appts.filter(a => {
  const d = a.startTime?.slice(0, 10)
  if (!d || d > yesterday) return false
  if (fromArg || toArg) { if (!inWindow(a.startTime)) return false }
  if (nameArg) {
    if (!a.contactName?.toLowerCase().includes(nameArg.toLowerCase())) return false
  }

  const needsOutcome = (((a.appointmentStatus === 'showed' || a.status === 'showed') &&
                        !['closed','not_closed','no_show','cancelled'].includes(a.status)) ||
                        a.status === 'confirmed')
  const closedNoCash = a.status === 'closed' && !a.cashCollected && !a.contractRevenue
  const noCloser     = ['closed','not_closed'].includes(a.status) && !a.closer

  return needsOutcome || closedNoCash || noCloser
}).sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

if (gaps.length === 0) {
  console.log('✅ No gaps to fill.')
  process.exit(0)
}

console.log(`\n${gaps.length} appointment(s) need outcome data. Press Enter to skip any field.\n`)

// ── Readline helpers ───────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = q => new Promise(resolve => rl.question(q, resolve))

function describeGap(a) {
  const issues = []
  if (((a.appointmentStatus === 'showed' || a.status === 'showed') &&
      !['closed','not_closed','no_show','cancelled'].includes(a.status)) ||
      a.status === 'confirmed')
    issues.push('missing outcome — log closed / not_closed / no_show / cancelled')
  if (a.status === 'closed' && !a.cashCollected && !a.contractRevenue)
    issues.push('closed but no cash/revenue')
  if (['closed','not_closed'].includes(a.status) && !a.closer)
    issues.push('no closer recorded')
  return issues.join(', ')
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let updated = 0

for (let i = 0; i < gaps.length; i++) {
  const a    = gaps[i]
  const idx  = appts.findIndex(x => x.id === a.id)
  const date = a.startTime?.slice(0, 10) || '?'
  const cal  = a.calendarName?.includes('Cold') ? 'Cold SMS' : 'Ads'

  console.log(`\n─── ${i + 1}/${gaps.length} ─────────────────────────────────────`)
  console.log(`  Name:    ${a.contactName}`)
  console.log(`  Date:    ${date}  [${cal}]`)
  console.log(`  GHL:     ${a.appointmentStatus}   Current status: ${a.status || '—'}`)
  console.log(`  Issue:   ${describeGap(a)}`)
  console.log()

  const skip = await ask('  Skip this one? (y/Enter to continue) ')
  if (skip.trim().toLowerCase() === 'y') continue

  // Status
  const statusNeedsUpdate =
    ((a.appointmentStatus === 'showed' || a.status === 'showed') &&
     !['closed','not_closed','no_show','cancelled'].includes(a.status)) ||
    a.status === 'confirmed'  // confirmed past date = same action needed

  if (statusNeedsUpdate) {
    const st = await ask('  Status (c=closed, n=not_closed, ns=no_show, x=cancelled, skip=Enter): ')
    const statusMap = { c: 'closed', n: 'not_closed', ns: 'no_show', x: 'cancelled' }
    if (statusMap[st.trim()]) {
      appts[idx].status = statusMap[st.trim()]
      updated++
    }
  }

  // Closer
  if (!appts[idx].closer && ['closed','not_closed'].includes(appts[idx].status)) {
    const closer = await ask('  Closer (Enter to skip): ')
    if (closer.trim()) { appts[idx].closer = closer.trim(); updated++ }
  }

  // Cash collected
  if (appts[idx].status === 'closed' && !appts[idx].cashCollected) {
    const cash = await ask('  Cash collected $ (Enter to skip): ')
    const n = parseFloat(cash.replace(/[$,]/g, ''))
    if (!isNaN(n)) { appts[idx].cashCollected = n; updated++ }
  }

  // Contract revenue
  if (appts[idx].status === 'closed' && !appts[idx].contractRevenue) {
    const rev = await ask('  Contract revenue $ (Enter to skip): ')
    const n = parseFloat(rev.replace(/[$,]/g, ''))
    if (!isNaN(n)) { appts[idx].contractRevenue = n; updated++ }
  }

  // Follow-up booked
  if (appts[idx].status === 'not_closed' && appts[idx].followUpBooked === undefined) {
    const fu = await ask('  Follow-up booked? (y/n/Enter to skip): ')
    if (fu.trim() === 'y') { appts[idx].followUpBooked = true;  updated++ }
    if (fu.trim() === 'n') { appts[idx].followUpBooked = false; updated++ }
  }
}

rl.close()

if (updated === 0) {
  console.log('\nNo changes made.')
  process.exit(0)
}

// ── Save + rebuild ─────────────────────────────────────────────────────────────
fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
console.log(`\n✅ Saved ${updated} update(s) to data/sales_data.json`)
console.log('Rebuilding dashboard...')
try {
  execSync('node scripts/inject-and-open.mjs', { cwd: root, stdio: 'inherit' })
} catch (e) {
  console.error('Dashboard rebuild failed — run manually: node scripts/inject-and-open.mjs')
}
