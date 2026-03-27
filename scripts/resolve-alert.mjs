#!/usr/bin/env node
/**
 * resolve-alert.mjs — Mark an onboarding alert as resolved
 *
 * Use this after manually handling an unmatched form submission or other alert.
 *
 * Usage:
 *   node scripts/resolve-alert.mjs --id alert_1234567890
 *   node scripts/resolve-alert.mjs --list                  (show all pending alerts)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const ALERTS_FILE = path.join(REPO_ROOT, 'data/alerts.json')

const args     = process.argv.slice(2)
const get      = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }
const listMode = args.includes('--list')
const alertId  = get('--id')

const data   = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'))
const alerts = data.alerts || []

if (listMode) {
  const pending = alerts.filter(a => a.status === 'pending')
  if (pending.length === 0) {
    console.log('No pending alerts.')
  } else {
    console.log(`${pending.length} pending alert(s):\n`)
    for (const a of pending) {
      console.log(`[${a.id}] ${a.type} — ${a.receivedAt.split('T')[0]}`)
      console.log(`  ${a.message}\n`)
    }
  }
  process.exit(0)
}

if (!alertId) {
  console.error('Usage: node scripts/resolve-alert.mjs --id <alert_id>')
  console.error('       node scripts/resolve-alert.mjs --list')
  process.exit(1)
}

const alert = alerts.find(a => a.id === alertId)
if (!alert) {
  console.error(`No alert found with id: ${alertId}`)
  console.error(`Run with --list to see pending alerts.`)
  process.exit(1)
}

if (alert.status === 'resolved') {
  console.log(`Alert ${alertId} is already resolved (${alert.resolvedAt}).`)
  process.exit(0)
}

alert.status     = 'resolved'
alert.resolvedAt = new Date().toISOString()

fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2))
console.log(`✅ Alert ${alertId} marked resolved.`)
