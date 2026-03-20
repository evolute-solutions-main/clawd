/**
 * Fetch raw appointment data from GHL for a date range.
 * Upserts into raw_appts_march.json — one record per appointment (latest status),
 * with an embedded statusHistory array tracking every status change.
 *
 * Usage:
 *   node scripts/fetch-raw-appts.mjs --from 2026-03-01 --to 2026-03-18
 */

import fs from 'fs'
import { fetchAppointments, getContact, CALENDARS } from '../agents/_shared/ghl/index.mjs'
import { SETTER_MAP } from '../agents/closing-tracker/lib/row-builder.mjs'

const CALENDAR_NAMES = {
  [CALENDARS.COLD_SMS]:     'Cold SMS',
  [CALENDARS.META_INBOUND]: 'AI Strategy Session (Meta Inbound)',
}

const DATA_FILE = new URL('../sales_data.json', import.meta.url).pathname

const args = process.argv.slice(2)
const fromIso = args[args.indexOf('--from') + 1]
const toIso   = args[args.indexOf('--to')   + 1]

if (!fromIso || !toIso) {
  console.error('Usage: node scripts/fetch-raw-appts.mjs --from YYYY-MM-DD --to YYYY-MM-DD')
  process.exit(1)
}

function loadJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) } catch { return fallback }
}

async function main() {
  const existing = loadJSON(DATA_FILE, [])
  const existingById = Object.fromEntries(existing.map(a => [a.id, a]))

  const [coldAppts, metaAppts] = await Promise.all(
    [CALENDARS.COLD_SMS, CALENDARS.META_INBOUND].map(id => fetchAppointments(id, fromIso, toIso))
  )
  const allAppts = [...coldAppts, ...metaAppts].filter(a => a.startTime >= fromIso)

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
      // First time seeing this appointment — log initial status
      statusHistory.push({ status: appt.appointmentStatus, at: now })
      console.log(`[new]    ${appt.contactName} — ${appt.appointmentStatus}`)
    } else if (prev.appointmentStatus !== appt.appointmentStatus) {
      // Status changed — append to history
      statusHistory.push({ status: appt.appointmentStatus, at: now })
      console.log(`[update] ${appt.contactName} — ${prev.appointmentStatus} → ${appt.appointmentStatus}`)
    }

    fresh.push({
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
    })
  }

  // Merge: keep existing records outside this date range, upsert fetched ones
  const freshById = Object.fromEntries(fresh.map(a => [a.id, a]))
  const merged = [
    ...existing.filter(a => !freshById[a.id]),
    ...fresh
  ]
  merged.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2))

  console.log(`\nDone. ${fresh.length} fetched, ${merged.length} total in file.`)
}

main().catch(err => { console.error(err); process.exit(1) })
