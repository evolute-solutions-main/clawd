import fs from 'fs'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const root     = path.resolve(fileURLToPath(import.meta.url), '../../')
const data     = path.join(root, 'data')
const htmlFile = path.join(root, 'sales_tracker.html')

// Read lib/metrics.mjs, strip ES module export keywords for browser inlining,
// then wrap in a Metrics global so the HTML can call Metrics.computeRevenue() etc.
const metricsSource = fs.readFileSync(path.join(root, 'lib', 'metrics.mjs'), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace(/^export const /gm,   'const ')
const metricsBundle = `<script id="metrics-lib">
// AUTO-GENERATED from lib/metrics.mjs — do not edit here
;(function(){
${metricsSource}
window.Metrics={isColdSMS,isAds,parseDate,inWindow,filterAppts,filterExpenses,computeRevenue,computeShowRate,computeCAC,computeROAS,computePL,computeLTV,computeFunnel,computeSetters,computeMonthlyTrends,computePipeline}
})()
</script>`

// sales_data.json is now { appointments: [...], dials: [...] }
const salesData    = JSON.parse(fs.readFileSync(path.join(data, 'sales_data.json'), 'utf8'))
const appointments = JSON.stringify(salesData.appointments)
const dials        = JSON.stringify(salesData.dials)

// expenses.json is now the single unified expenses file
const expenses     = fs.readFileSync(path.join(data, 'expenses.json'), 'utf8').trim()
const transactions = fs.readFileSync(path.join(data, 'transactions.json'), 'utf8').trim()

let html = fs.readFileSync(htmlFile, 'utf8')
// Inject metrics lib (replaces previous bundle between the script tags)
html = html.replace(/<script id="metrics-lib">[\s\S]*?<\/script>/, metricsBundle)
// Inject data constants
html = html.replace(/const RAW = \[[\s\S]*?\];/,          'const RAW = '          + appointments + ';')
html = html.replace(/const EXPENSES = \[[\s\S]*?\];/,     'const EXPENSES = '     + expenses     + ';')
html = html.replace(/const DIALS = \[[\s\S]*?\];/,        'const DIALS = '        + dials        + ';')
html = html.replace(/const TRANSACTIONS = \[[\s\S]*?\];/, 'const TRANSACTIONS = ' + transactions + ';')
html = html.replace(/const BUS_EXP = \[[\s\S]*?\];/,      'const BUS_EXP = '      + expenses     + ';')
fs.writeFileSync(htmlFile, html)
execSync(`open "${htmlFile}"`)
console.log('Done.')
