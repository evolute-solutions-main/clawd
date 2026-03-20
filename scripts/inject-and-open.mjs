import fs from 'fs'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(fileURLToPath(import.meta.url), '../../')
const dataFile = path.join(root, 'sales_data.json')
const htmlFile = path.join(root, 'sales_tracker.html')

const data         = fs.readFileSync(dataFile, 'utf8').trim()
const expenses     = fs.readFileSync(path.join(root, 'expenses.json'), 'utf8').trim()
const dials        = fs.readFileSync(path.join(root, 'dials.json'), 'utf8').trim()
const transactions = fs.readFileSync(path.join(root, 'transactions.json'), 'utf8').trim()
const busExp       = fs.readFileSync(path.join(root, 'business_expenses.json'), 'utf8').trim()
let html = fs.readFileSync(htmlFile, 'utf8')
html = html.replace(/const RAW = \[[\s\S]*?\];/, 'const RAW = ' + data + ';')
html = html.replace(/const EXPENSES = \[[\s\S]*?\];/, 'const EXPENSES = ' + expenses + ';')
html = html.replace(/const DIALS = \[[\s\S]*?\];/, 'const DIALS = ' + dials + ';')
html = html.replace(/const TRANSACTIONS = \[[\s\S]*?\];/, 'const TRANSACTIONS = ' + transactions + ';')
html = html.replace(/const BUS_EXP = \[[\s\S]*?\];/, 'const BUS_EXP = ' + busExp + ';')
fs.writeFileSync(htmlFile, html)
execSync(`open "${htmlFile}"`)
console.log('Done.')
