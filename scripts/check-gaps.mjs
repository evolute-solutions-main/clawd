#!/usr/bin/env node
/**
 * check-gaps.mjs — Find appointments with missing or ambiguous outcome data.
 *
 * Prints a report of appointments that need Max's input, grouped by issue type.
 *
 * Usage:
 *   node scripts/check-gaps.mjs
 *   node scripts/check-gaps.mjs --from 2026-03-01   (limit to date range)
 *   node scripts/check-gaps.mjs --json              (machine-readable output)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root      = path.resolve(fileURLToPath(import.meta.url), '../../')
const DATA_FILE = path.join(root, 'data', 'sales_data.json')

const args = process.argv.slice(2)
const _fi  = args.indexOf('--from'); const fromArg = _fi !== -1 ? args[_fi + 1] || null : null
const _ti  = args.indexOf('--to');   const toArg   = _ti !== -1 ? args[_ti + 1] || null : null
const jsonOut = args.includes('--json')

const raw  = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const appts = Array.isArray(raw) ? raw : raw.appointments

const today     = new Date().toISOString().slice(0, 10)
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

function inWindow(dateStr) {
  const d = dateStr?.slice(0, 10)
  if (!d) return false
  if (fromArg && d < fromArg) return false
  if (toArg   && d > toArg)   return false
  return true
}

// Only look at past appointments (call has already happened or been missed)
const past = appts.filter(a => {
  const d = a.startTime?.slice(0, 10)
  return d && d <= yesterday && (!fromArg || inWindow(a.startTime))
})

// ── Gap type 1: GHL says "showed" but no outcome recorded ────────────────────
// appointmentStatus=showed but status is not closed/not_closed
const needsOutcome = past.filter(a =>
  a.appointmentStatus === 'showed' &&
  a.status !== 'closed' &&
  a.status !== 'not_closed'
)

// ── Gap type 2: GHL says "showed", outcome recorded, but cash/revenue missing ─
// closed but no cashCollected and no contractRevenue
const closedNoCash = past.filter(a =>
  a.status === 'closed' &&
  !a.cashCollected &&
  !a.contractRevenue
)

// ── Gap type 3: Still "new" or "confirmed" past their date ───────────────────
// Appointment date passed but GHL still shows new/confirmed — likely no-show or cancel not logged
const staleStatus = past.filter(a =>
  ['new', 'confirmed'].includes(a.appointmentStatus) &&
  !['cancelled', 'no_show', 'closed', 'not_closed'].includes(a.status)
)

// ── Gap type 4: closed/not_closed but no closer recorded ────────────────────
const noCloser = past.filter(a =>
  ['closed', 'not_closed'].includes(a.status) &&
  !a.closer
)

function fmtAppt(a) {
  const date = a.startTime?.slice(0, 10) || '?'
  const cal  = a.calendarName?.includes('Cold') ? 'Cold SMS' : 'Ads'
  return `  ${date}  ${(a.contactName || 'Unknown').padEnd(28)}  [${cal}]  ghl=${a.appointmentStatus}  status=${a.status || '—'}`
}

if (jsonOut) {
  console.log(JSON.stringify({ needsOutcome, closedNoCash, staleStatus, noCloser }, null, 2))
  process.exit(0)
}

const total = needsOutcome.length + closedNoCash.length + staleStatus.length + noCloser.length

if (total === 0) {
  console.log('✅ No gaps found — all past appointments have complete outcome data.')
  process.exit(0)
}

console.log(`\n⚠️  ${total} appointment(s) need your input:\n`)

if (needsOutcome.length) {
  console.log(`── ${needsOutcome.length} showed but outcome unknown (closed or not_closed?) ──`)
  needsOutcome.forEach(a => console.log(fmtAppt(a)))
  console.log()
}

if (closedNoCash.length) {
  console.log(`── ${closedNoCash.length} marked closed but no cash or revenue recorded ──`)
  closedNoCash.forEach(a => console.log(fmtAppt(a)))
  console.log()
}

if (staleStatus.length) {
  console.log(`── ${staleStatus.length} still new/confirmed past their date (no-show? cancel? reschedule?) ──`)
  staleStatus.forEach(a => console.log(fmtAppt(a)))
  console.log()
}

if (noCloser.length) {
  console.log(`── ${noCloser.length} closed/not_closed with no closer recorded ──`)
  noCloser.forEach(a => console.log(fmtAppt(a)))
  console.log()
}

console.log(`Run: node scripts/log-outcome.mjs   to fill these in interactively`)
