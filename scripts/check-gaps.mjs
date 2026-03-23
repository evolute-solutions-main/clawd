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
// appointmentStatus=showed OR status=showed but not yet resolved to closed/not_closed
// no_show and cancelled mean the call didn't happen — closed/not_closed don't apply
const needsOutcome = past.filter(a =>
  (a.appointmentStatus === 'showed' || a.status === 'showed') &&
  !['closed','not_closed','no_show','cancelled'].includes(a.status)
)

// ── Gap type 2: GHL says "showed", outcome recorded, but cash/revenue missing ─
// closed but no cashCollected and no contractRevenue
const closedNoCash = past.filter(a =>
  a.status === 'closed' &&
  !a.cashCollected &&
  !a.contractRevenue
)

// ── Gap type 3: Confirmed past their date with no outcome ────────────────────
// 'new' = unconfirmed placeholder, never needs outcome (not a real committed appointment)
// Only 'confirmed' (our status field) past-date means a real appointment with missing outcome
const staleStatus = past.filter(a => a.status === 'confirmed')

// ── Gap type 4: closed/not_closed but no closer recorded ────────────────────
const noCloser = past.filter(a =>
  ['closed', 'not_closed'].includes(a.status) &&
  !a.closer
)

// ── Gap type 5: Cold SMS appointment with no setter recorded ─────────────────
// createdBy should always be populated for Cold SMS — blank means the fetch didn't
// resolve the setter userId, or the appointment was created outside the normal flow
const noSetter = past.filter(a =>
  (a.calendarName?.toLowerCase().includes('cold') || a.source === 'Cold SMS') &&
  !a.createdBy
)

// ── Gap type 6: showed or closed but no Fathom link ──────────────────────────
// Every show should have a recording — missing link means fathom-match didn't find it
// or the call happened outside Fathom and needs manual entry
const noFathom = past.filter(a =>
  ['showed', 'closed', 'not_closed'].includes(a.status) &&
  !a.fathomLink
)

function fmtAppt(a) {
  const date = a.startTime?.slice(0, 10) || '?'
  const cal  = a.calendarName?.includes('Cold') ? 'Cold SMS' : 'Ads'
  return `  ${date}  ${(a.contactName || 'Unknown').padEnd(28)}  [${cal}]  ghl=${a.appointmentStatus}  status=${a.status || '—'}`
}

if (jsonOut) {
  console.log(JSON.stringify({ needsOutcome, closedNoCash, staleStatus, noCloser, noSetter, noFathom }, null, 2))
  process.exit(0)
}

const total = needsOutcome.length + closedNoCash.length + staleStatus.length + noCloser.length + noSetter.length + noFathom.length

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

if (noSetter.length) {
  console.log(`── ${noSetter.length} Cold SMS appointment(s) with no setter recorded ──`)
  noSetter.forEach(a => console.log(fmtAppt(a)))
  console.log()
}

if (noFathom.length) {
  console.log(`── ${noFathom.length} showed/closed with no Fathom link (run fathom-match or add manually) ──`)
  noFathom.forEach(a => console.log(fmtAppt(a)))
  console.log()
}

console.log(`Run: node scripts/log-outcome.mjs   to fill these in interactively`)
