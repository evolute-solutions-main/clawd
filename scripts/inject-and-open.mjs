import fs from 'fs'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const root     = path.resolve(fileURLToPath(import.meta.url), '../../')
const data     = path.join(root, 'data')
const htmlFile = path.join(root, 'dashboard.html')

// Read lib/metrics.mjs, strip ES module export keywords for browser inlining,
// then wrap in a Metrics global so the HTML can call Metrics.computeRevenue() etc.
const metricsSource = fs.readFileSync(path.join(root, 'lib', 'metrics.mjs'), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace(/^export const /gm,   'const ')
const metricsBundle = `<script id="metrics-lib">
// AUTO-GENERATED from lib/metrics.mjs — do not edit here
;(function(){
${metricsSource}
window.Metrics={pct,isColdSMS,isAds,parseDate,inWindow,isUnresolved,filterAppts,filterExpenses,computeRevenue,computeShowRate,computeCAC,computeROAS,computePL,computeLTV,computeFunnel,computeSetters,computeSetterTrends,computeDOW,computeMonthlyTrends,computePipeline,computeWeekly}
})()
</script>`

// sales_data.json is now { appointments: [...], dials: [...] }
const salesData    = JSON.parse(fs.readFileSync(path.join(data, 'sales_data.json'), 'utf8'))
const appointments = JSON.stringify(salesData.appointments)
const dials        = JSON.stringify(salesData.dials)

// expenses.json is now the single unified expenses file
const expenses     = fs.readFileSync(path.join(data, 'expenses.json'), 'utf8').trim()
const transactions = fs.readFileSync(path.join(data, 'transactions.json'), 'utf8').trim()
const weeklyDials       = fs.readFileSync(path.join(data, 'weekly_dials.json'),    'utf8').trim()
const unmatchedFathom   = fs.readFileSync(path.join(data, 'unmatched_fathom.json'), 'utf8').trim()

// clients.json + alerts.json — combined and injected into Ops > Onboarding tab
let onboardingRaw
try {
  const clients = JSON.parse(fs.readFileSync(path.join(data, 'clients.json'), 'utf8'))
  const alerts  = JSON.parse(fs.readFileSync(path.join(data, 'alerts.json'),  'utf8'))
  onboardingRaw = JSON.stringify({ clients: clients.clients, alerts: alerts.alerts })
} catch {
  onboardingRaw = '{"clients":[],"alerts":[]}'
}

let html = fs.readFileSync(htmlFile, 'utf8')
// Inject metrics lib (replaces previous bundle between the script tags)
html = html.replace(/<script id="metrics-lib">[\s\S]*?<\/script>/, metricsBundle)
// Inject data constants
html = html.replace(/const RAW = \[[\s\S]*?\];/,          'const RAW = '          + appointments + ';')
html = html.replace(/const EXPENSES = \[[\s\S]*?\];/,     'const EXPENSES = '     + expenses     + ';')
html = html.replace(/const DIALS = \[[\s\S]*?\];/,        'const DIALS = '        + dials        + ';')
html = html.replace(/const TRANSACTIONS = \[[\s\S]*?\];/, 'const TRANSACTIONS = ' + transactions + ';')
html = html.replace(/const BUS_EXP = \[[\s\S]*?\];/,          'const BUS_EXP = '          + expenses     + ';')
html = html.replace(/const WEEKLY_DIALS = \[[\s\S]*?\];/,      'const WEEKLY_DIALS = '      + weeklyDials      + ';')
html = html.replace(/const UNMATCHED_FATHOM = \[[\s\S]*?\];/, 'const UNMATCHED_FATHOM = ' + unmatchedFathom + ';')
html = html.replace(/const ONBOARDING_DATA = \{[\s\S]*?\};/, 'const ONBOARDING_DATA = ' + onboardingRaw + ';')

// Bake year/month select options from data (avoids relying on runtime JS to populate them)
const MONTH_NAMES = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const apptData  = JSON.parse(appointments)
const rawMonths = [...new Set(apptData.map(a => a.startTime?.slice(0,7)).filter(Boolean))].sort()
const rawYears  = [...new Set(rawMonths.map(m => m.slice(0,4)))].sort()
const yearOpts  = rawYears.map(y => `<option value="${y}">${y}</option>`).join('')
const monthOpts = [...new Set(rawMonths.map(m => parseInt(m.slice(5))))].sort((a,b)=>a-b)
  .map(n => `<option value="${String(n).padStart(2,'0')}">${MONTH_NAMES[n]}</option>`).join('')
html = html.replace(
  /<select id="selYear"[^>]*>[\s\S]*?<\/select>/,
  `<select id="selYear"><option value="">Year</option>${yearOpts}</select>`
)
html = html.replace(
  /<select id="selMonth"[^>]*>[\s\S]*?<\/select>/,
  `<select id="selMonth"><option value="">Month</option>${monthOpts}</select>`
)
fs.writeFileSync(htmlFile, html)
if (!process.argv.includes('--no-open')) {
  try { execSync(`open "${htmlFile}"`) } catch {}
}
console.log('Done.')
