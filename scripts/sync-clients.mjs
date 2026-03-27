#!/usr/bin/env node
/**
 * sync-clients.mjs — Reconcile clients.json against sales_data.json
 *
 * Finds unlinked clients and unlinked closed appointments, matches them,
 * and stamps both sides bidirectionally.
 *
 * Safe to run at any time — skips already-linked records.
 *
 * Usage:
 *   node scripts/sync-clients.mjs
 *   node scripts/sync-clients.mjs --dry-run   (show matches without writing)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import { findAppointmentMatch, syncAllClients } from '../lib/client-sync.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT    = path.resolve(__dirname, '..')
const CLIENTS_FILE = path.join(REPO_ROOT, 'data/clients.json')
const SALES_FILE   = path.join(REPO_ROOT, 'data/sales_data.json')

const dryRun = process.argv.includes('--dry-run')

if (dryRun) {
  // Preview only — no writes
  const clientsData  = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
  const rawSales     = JSON.parse(fs.readFileSync(SALES_FILE,   'utf8'))
  const appointments = Array.isArray(rawSales) ? rawSales : rawSales.appointments

  const unlinkedClients      = clientsData.clients.filter(c => !c.appointmentId)
  const unlinkedAppointments = appointments.filter(a => a.status === 'closed' && !a.onboardingClientId)

  console.log(`\n📊 Sync preview`)
  console.log(`   Clients without appointment link: ${unlinkedClients.length}`)
  console.log(`   Closed appointments without client link: ${unlinkedAppointments.length}`)

  if (unlinkedClients.length === 0) {
    console.log('\n✅ All clients are already linked.')
    process.exit(0)
  }

  console.log('\nMatches found:')
  let found = 0
  for (const client of unlinkedClients) {
    const result = findAppointmentMatch(client, appointments)
    if (result) {
      const { appointment, confidence } = result
      console.log(`  ✓ [${confidence}] ${client.companyName} → ${appointment.contactName} (${appointment.id})`)
      // Mark as linked so next client can't claim it
      appointment.onboardingClientId = '__preview__'
      found++
    } else {
      console.log(`  ✗ No match: ${client.companyName} (${client.email || 'no email'})`)
    }
  }
  console.log(`\n${found} link(s) would be created. Run without --dry-run to apply.`)

} else {
  const linked = syncAllClients(CLIENTS_FILE, SALES_FILE)

  if (linked.length === 0) {
    console.log('✅ All clients already synced — nothing to link.')
  } else {
    console.log(`\n✅ Synced ${linked.length} client(s):`)
    for (const { client, appointment, confidence } of linked) {
      console.log(`   [${confidence}] ${client.companyName} ↔ ${appointment.contactName} (${appointment.id})`)
    }
  }
}
