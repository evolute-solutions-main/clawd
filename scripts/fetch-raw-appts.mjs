/**
 * Fetch raw appointment data from GHL for a date range.
 * Upserts into data/sales_data.json — one record per appointment (latest GHL status),
 * with an embedded statusHistory array tracking every status change.
 *
 * IMPORTANT: Preserves all manually-set outcome fields (status, closer, cashCollected,
 * contractRevenue, followUpBooked, fathomLink, offerMade) — never overwrites them.
 *
 * Usage:
 *   node scripts/fetch-raw-appts.mjs --from 2026-03-01 --to 2026-03-31
 */

import '../agents/_shared/env-loader.mjs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fetchAppointments, getContact, CALENDARS } from '../agents/_shared/ghl/index.mjs'

const root     = path.resolve(fileURLToPath(import.meta.url), '../../')
const DATA_FILE = path.join(root, 'data', 'sales_data.json')

// Setter GHL user ID → display name
const SETTER_MAP = {
  'GheOd0K8eB8qosL2Z8RP': 'Max',
  'ddUpjf6Fj9k9efSf874G': 'Eddie',
  'YQcDJN2MiXUJfaAiKqyj': 'Daniel',
  'VwnP4BSH4oQR6yWOaV4Q': 'Randy',
  'KHUC7ccubjjmR4sV5DOa': 'Richard Ramilo',
}

const CALENDAR_NAMES = {
  [CALENDARS.COLD_SMS]:          'Cold SMS',
  [CALENDARS.META_INBOUND]:      'AI Strategy Session (Meta Inbound)',
  [CALENDARS.INBOUND_STRATEGY]:  'Inbound Strategy Session',
}

// Fields set manually (outcome data) — never overwrite these from GHL
const OUTCOME_FIELDS = [
  'status', 'closer', 'cashCollected', 'cashCollectedAfterFirstCall',
  'contractRevenue', 'followUpBooked', 'fathomLink', 'offerMade',
]

// Map GHL's appointmentStatus → our unified status enum for new records.
// 'showed' is intentionally omitted — needs a manual close/not_closed outcome.
const GHL_STATUS_MAP = {
  new:       'new',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  noshow:    'no_show',
}

const args    = process.argv.slice(2)
const fromIso = args[args.indexOf('--from') + 1]
const toIso   = args[args.indexOf('--to')   + 1]

if (!fromIso || !toIso) {
  console.error('Usage: node scripts/fetch-raw-appts.mjs --from YYYY-MM-DD --to YYYY-MM-DD')
  process.exit(1)
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    // Handle both old flat-array format and new { appointments, dials } format
    if (Array.isArray(raw)) return { appointments: raw, dials: [] }
    return raw
  } catch {
    return { appointments: [], dials: [] }
  }
}

async function main() {
  const data = loadData()
  const existingById = Object.fromEntries(data.appointments.map(a => [a.id, a]))

  const [coldAppts, metaAppts, inboundAppts] = await Promise.all(
    [CALENDARS.COLD_SMS, CALENDARS.META_INBOUND, CALENDARS.INBOUND_STRATEGY].map(id => fetchAppointments(id, fromIso, toIso))
  )
  const allAppts = [...coldAppts, ...metaAppts, ...inboundAppts].filter(a => a.startTime >= fromIso)

  const now = new Date().toISOString()
  const fresh = []

  for (const appt of allAppts) {
    let contact = { phone: '', email: '' }
    if (appt.contactId) {
      try { contact = await getContact(appt.contactId) } catch {}
    }
    await new Promise(r => setTimeout(r, 150))

    const prev = existingById[appt.id]
    const statusHistory = prev?.statusHistory ?? []

    if (!prev) {
      statusHistory.push({ status: appt.appointmentStatus, at: now })
      console.log(`[new]    ${appt.contactName} — ${appt.appointmentStatus}`)
    } else if (prev.appointmentStatus !== appt.appointmentStatus) {
      statusHistory.push({ status: appt.appointmentStatus, at: now })
      console.log(`[update] ${appt.contactName} — ${prev.appointmentStatus} → ${appt.appointmentStatus}`)
    }

    // Build updated record — GHL fields only
    const record = {
      id:                appt.id,
      contactName:       appt.contactName,
      calendarName:      CALENDAR_NAMES[appt.calendarId] || appt.calendarId,
      startTime:         appt.startTime,
      timeCreated:       appt.dateAdded,
      appointmentStatus: appt.appointmentStatus,
      createdBy:         SETTER_MAP[appt.createdBy?.userId] || appt.createdBy?.userId || '',
      phone:             contact.phone,
      email:             contact.email,
      statusHistory,
    }

    // Preserve all manually-set outcome fields from existing record.
    // For any record with no prior status (new or existing), derive from GHL.
    if (prev) {
      for (const field of OUTCOME_FIELDS) {
        if (prev[field] !== undefined) record[field] = prev[field]
      }
    }
    if (!record.status) {
      const derived = GHL_STATUS_MAP[appt.appointmentStatus]
      if (derived) record.status = derived
    }

    fresh.push(record)
  }

  // Merge: keep existing records outside this date range, upsert fetched ones
  const freshById = Object.fromEntries(fresh.map(a => [a.id, a]))
  const merged = [
    ...data.appointments.filter(a => !freshById[a.id]),
    ...fresh,
  ].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  fs.writeFileSync(DATA_FILE, JSON.stringify({ appointments: merged, dials: data.dials }, null, 2))
  console.log(`\nDone. ${fresh.length} fetched, ${merged.length} total appointments in file.`)
}

main().catch(err => { console.error(err); process.exit(1) })
