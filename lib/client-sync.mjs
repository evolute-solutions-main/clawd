/**
 * client-sync.mjs — Bidirectional sync between clients.json and sales_data.json
 *
 * When a client exists in clients.json, their closed appointment in sales_data
 * should have onboardingClientId stamped on it, and the client record should have
 * appointmentId. This module keeps both sides in sync automatically.
 *
 * Matching priority:
 *   1. Exact email match (case-insensitive)
 *   2. Fuzzy name match (first name or company substring against contactName)
 *
 * Only matches against appointments with status: 'closed' that are not yet linked.
 */

import fs from 'node:fs'

// Words to strip when comparing company names
const NOISE = /\b(llc|inc|co|corp|services|solutions|roofing|plumbing|electric|hvac|painting|construction|contractors?|group|enterprises?)\b/gi
function normalize(s) {
  return s.toLowerCase().replace(NOISE, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Find the best matching closed appointment for a client.
 * Returns { appointment, confidence: 'email' | 'name' } or null.
 * Only considers appointments that are not already linked.
 */
export function findAppointmentMatch(client, appointments) {
  const candidates = appointments.filter(a => a.status === 'closed' && !a.onboardingClientId)

  const clientEmail = client.email?.toLowerCase().trim()

  // 1. Exact email match
  if (clientEmail) {
    const match = candidates.find(a => a.email?.toLowerCase().trim() === clientEmail)
    if (match) return { appointment: match, confidence: 'email' }
  }

  // 2. Fuzzy name match
  const clientName    = client.name?.toLowerCase() || ''
  const clientCompany = client.companyName?.toLowerCase() || ''
  const firstName     = clientName.split(' ')[0]
  const normCompany   = normalize(clientCompany)

  const match = candidates.find(a => {
    const contactName  = (a.contactName || '').toLowerCase()
    const normContact  = normalize(contactName)

    const firstNameMatch  = firstName.length > 2 && contactName.includes(firstName)
    const companyMatch    = normCompany.length > 3 && (
      normContact.includes(normCompany) || normCompany.includes(normContact)
    )

    return firstNameMatch || companyMatch
  })

  if (match) return { appointment: match, confidence: 'name' }

  return null
}

/**
 * Search for a matching appointment regardless of status (for Stripe auto-close logic).
 * Used when a payment comes in for someone who doesn't have a closed deal yet.
 * Returns { appointment, confidence: 'email' | 'name' } or null.
 * Only considers unlinked appointments (no onboardingClientId).
 */
export function findUnclaimedAppointment(client, appointments) {
  const candidates = appointments.filter(a => !a.onboardingClientId)

  const clientEmail = client.email?.toLowerCase().trim()

  // 1. Exact email match
  if (clientEmail) {
    // Prefer most recent appointment by startTime
    const matches = candidates.filter(a => a.email?.toLowerCase().trim() === clientEmail)
    if (matches.length > 0) {
      const best = matches.sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0]
      return { appointment: best, confidence: 'email' }
    }
  }

  // 2. Fuzzy name match
  const clientName    = client.name?.toLowerCase() || ''
  const clientCompany = client.companyName?.toLowerCase() || ''
  const firstName     = clientName.split(' ')[0]
  const normCompany   = normalize(clientCompany)

  const match = candidates.find(a => {
    const contactName = (a.contactName || '').toLowerCase()
    const normContact = normalize(contactName)

    const firstNameMatch = firstName.length > 2 && contactName.includes(firstName)
    const companyMatch   = normCompany.length > 3 && (
      normContact.includes(normCompany) || normCompany.includes(normContact)
    )

    return firstNameMatch || companyMatch
  })

  if (match) return { appointment: match, confidence: 'name' }

  return null
}

/**
 * Sync all unlinked clients against closed appointments.
 * Idempotent — skips clients that already have appointmentId.
 * Stamps both sides (client.appointmentId + appointment.onboardingClientId).
 * Returns array of { client, appointment, confidence } for each link made.
 */
export function syncAllClients(CLIENTS_FILE, SALES_FILE) {
  const clientsData = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
  const rawSales    = JSON.parse(fs.readFileSync(SALES_FILE,   'utf8'))
  const appointments = Array.isArray(rawSales) ? rawSales : rawSales.appointments

  const linked = []

  for (const client of clientsData.clients) {
    if (client.appointmentId) continue  // already linked

    const result = findAppointmentMatch(client, appointments)
    if (!result) continue

    const { appointment, confidence } = result
    client.appointmentId           = appointment.id
    appointment.onboardingClientId = client.id

    linked.push({ client, appointment, confidence })
  }

  if (linked.length > 0) {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsData, null, 2))
    const salesOut = Array.isArray(rawSales) ? appointments : { ...rawSales, appointments }
    fs.writeFileSync(SALES_FILE, JSON.stringify(salesOut, null, 2))
  }

  return linked
}
