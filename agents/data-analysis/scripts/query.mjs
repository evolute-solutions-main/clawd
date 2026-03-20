#!/usr/bin/env node
/**
 * query.mjs — Evolute business analytics CLI
 *
 * Thin wrapper around lib/metrics.mjs — all computation lives there.
 * Reads data/*.json, outputs a single JSON object to stdout.
 * No writes, no external dependencies, no dashboard edits.
 *
 * Usage:
 *   node agents/data-analysis/scripts/query.mjs --metric=revenue --from 2026-02-01 --to 2026-03-18
 *   node agents/data-analysis/scripts/query.mjs --metric=show-rate --source "Cold SMS" --from 2026-01-01 --to 2026-03-31
 *   node agents/data-analysis/scripts/query.mjs --metric=cac --source Ads --from 2026-02-01 --to 2026-03-18
 *   node agents/data-analysis/scripts/query.mjs --metric="p&l" --month 2026-03
 *   node agents/data-analysis/scripts/query.mjs --metric=ltv
 *   node agents/data-analysis/scripts/query.mjs --metric=roas --source Ads --from 2026-01-01 --to 2026-03-31
 *   node agents/data-analysis/scripts/query.mjs --metric=funnel --source "Cold SMS" --from 2026-01-01 --to 2026-03-31
 *   node agents/data-analysis/scripts/query.mjs --metric=setters --from 2026-01-01 --to 2026-03-31
 *   node agents/data-analysis/scripts/query.mjs --metric=trends
 */

import fs   from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  computeRevenue, computeShowRate, computeCAC, computeROAS,
  computePL, computeLTV, computeFunnel, computeSetters, computeMonthlyTrends,
} from '../../../lib/metrics.mjs'

const root    = path.resolve(fileURLToPath(import.meta.url), '../../../../')
const dataDir = path.join(root, 'data')

const salesData    = JSON.parse(fs.readFileSync(path.join(dataDir, 'sales_data.json'),   'utf8'))
const expenses     = JSON.parse(fs.readFileSync(path.join(dataDir, 'expenses.json'),     'utf8'))
const transactions = JSON.parse(fs.readFileSync(path.join(dataDir, 'transactions.json'), 'utf8'))

const appointments = salesData.appointments
const dials        = salesData.dials

// ── Arg parsing ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=')
      args[k] = rest.length ? rest.join('=') : (argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true)
    }
  }
  return args
}

const args   = parseArgs(process.argv.slice(2))
const metric = (args.metric || args.m || '').toLowerCase().replace('&', '&')
const source = args.source
const month  = args.month
const human  = args.human === true || args.human === 'true'

// ── Date window ───────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  return null
}

let from = parseDate(args.from)
let to   = parseDate(args.to)

if (month) {
  const [y, m] = month.split('-').map(Number)
  from = `${month}-01`
  to   = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2,'0')}`
}

const opts = { from, to, source }

// ── Dispatch ──────────────────────────────────────────────────────────────────
const METRICS = {
  'revenue':   () => computeRevenue(appointments, opts),
  'show-rate': () => computeShowRate(appointments, opts),
  'showrate':  () => computeShowRate(appointments, opts),
  'cac':       () => computeCAC(appointments, expenses, opts),
  'roas':      () => computeROAS(appointments, expenses, opts),
  'p&l':       () => computePL(transactions, expenses, opts),
  'pl':        () => computePL(transactions, expenses, opts),
  'ltv':       () => computeLTV(transactions),
  'funnel':    () => computeFunnel(appointments, expenses, dials, opts),
  'setters':   () => computeSetters(appointments, expenses, dials, opts),
  'trends':    () => computeMonthlyTrends(appointments, expenses, opts),
}

if (!metric || !METRICS[metric]) {
  console.error(JSON.stringify({ error: `Unknown metric: "${metric}"`, available: Object.keys(METRICS) }))
  process.exit(1)
}

const result = METRICS[metric]()

// ── Human-readable summary ────────────────────────────────────────────────────
if (human) {
  const r = result
  const w = r.window ? `${r.window.from||'?'} → ${r.window.to||'?'}` : ''
  const src = r.window?.source !== 'all' ? ` [${r.window?.source}]` : ''
  console.log(`\n── ${(r.metric||metric).toUpperCase()}${src} ${w} ──`)
  if (r.metric === 'revenue')
    console.log(`Booked: ${r.booked} | Showed: ${r.showed} | Closed: ${r.closed}\nCash: $${r.totalCash?.toLocaleString()} | Contract: $${r.contractRevenue?.toLocaleString()} | Avg/close: $${r.avgCashPerClose?.toLocaleString()}`)
  if (r.metric === 'show-rate')
    console.log(`Show rate: ${r.showRatePct} (${r.showed}/${r.denom})`)
  if (r.metric === 'cac')
    console.log(`Closes: ${r.closes} | Spend: $${r.spend?.toLocaleString()} | CAC: $${r.cac?.toLocaleString()}`)
  if (r.metric === 'roas')
    console.log(`Cash: $${r.cashCollected?.toLocaleString()} | Spend: $${r.spend?.toLocaleString()} | ROAS: ${r.roasX}`)
  if (r.metric === 'p&l')
    console.log(`Revenue: $${r.revenue?.toLocaleString()} | Expenses: $${r.expenses?.toLocaleString()} | Profit: $${r.profit?.toLocaleString()} | Margin: ${r.margin}`)
  if (r.metric === 'ltv')
    console.log(`${r.clientCount} clients | Total: $${r.totalRevenue?.toLocaleString()} | Avg LTV: $${r.avgLTV?.toLocaleString()}`)
  if (r.source !== undefined)
    console.log(`Booked: ${r.booked} | Showed: ${r.showed} | Closed: ${r.closed} | Spend: $${r.spend?.toLocaleString()} | CAC: $${r.cac?.toLocaleString()} | ROAS: ${r.roi?.toFixed(2)}x`)
  console.log()
  r.bySetter?.forEach(s => console.log(`  ${s.setter}: ${s.showed}/${s.booked} (${(s.showRate*100).toFixed(0)}%)`))
  r.setters?.forEach(s => console.log(`  ${s.name}: ${s.booked} booked, ${s.closed} closed, ${s.showRate ? (s.showRate*100).toFixed(0)+'%' : '—'} show`))
  r.byMonth?.forEach(m => console.log(`  ${m.month}: rev $${m.revenue?.toLocaleString()} | exp $${m.expenses?.toLocaleString()} | net $${m.profit?.toLocaleString()}`))
  r.months?.slice(-6).forEach(m => console.log(`  ${m.month}: ${m.closed} closed | $${m.cash?.toLocaleString()} cash | CAC $${m.cac?.toLocaleString()}`))
  r.clients?.slice(0,10).forEach(c => console.log(`  ${c.name}: $${c.total?.toLocaleString()} (${c.payments} payments)`))
  console.log()
}

console.log(JSON.stringify(result, null, 2))
