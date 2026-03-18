/**
 * GoHighLevel (GHL) API Client
 * Shared module for all agents that need GHL calendar/appointment data.
 * 
 * Usage:
 *   import { getCalendarAppointments, listCalendars } from '../_shared/ghl/index.mjs'
 *   const appointments = await getCalendarAppointments('FITm7fIlhVTworbpJArx', '2026-03-17')
 */

import '../../_shared/env-loader.mjs'

const GHL_BASE_URL = 'https://services.leadconnectorhq.com'
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'Fv38qyVITGwToy2uDZgc'
const GHL_TOKEN = process.env.GHL_PRIVATE_INTEGRATION_TOKEN

if (!GHL_TOKEN) {
  throw new Error('GHL_PRIVATE_INTEGRATION_TOKEN not found in environment')
}

/**
 * Make authenticated request to GHL API
 */
async function ghlRequest(endpoint, params = {}) {
  const url = new URL(endpoint, GHL_BASE_URL)
  url.searchParams.set('locationId', GHL_LOCATION_ID)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${GHL_TOKEN}`,
      'Version': '2021-04-15',
      'Content-Type': 'application/json'
    }
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GHL API error ${res.status}: ${text}`)
  }

  return res.json()
}

/**
 * List all calendars in the location
 * @returns {Promise<Array<{id: string, name: string, type: string, isActive: boolean}>>}
 */
export async function listCalendars() {
  const data = await ghlRequest('/calendars/')
  return data.calendars.map(cal => ({
    id: cal.id,
    name: cal.name,
    type: cal.calendarType,
    isActive: cal.isActive
  }))
}

/**
 * Get a specific calendar by ID
 * @param {string} calendarId
 * @returns {Promise<Object>}
 */
export async function getCalendar(calendarId) {
  const data = await ghlRequest(`/calendars/${calendarId}`)
  return data.calendar
}

/**
 * Parse a date string into start/end epoch milliseconds for a full day
 * Handles: 'yesterday', 'today', 'YYYY-MM-DD'
 * @param {string} dateStr
 * @returns {{startMs: number, endMs: number, dateStr: string}}
 */
function parseDateRange(dateStr) {
  let targetDate

  if (dateStr === 'today') {
    targetDate = new Date()
  } else if (dateStr === 'yesterday') {
    targetDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
  } else {
    // Assume YYYY-MM-DD format
    targetDate = new Date(dateStr + 'T00:00:00Z')
  }

  // Get YYYY-MM-DD string
  const yyyy = targetDate.getUTCFullYear()
  const mm = String(targetDate.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(targetDate.getUTCDate()).padStart(2, '0')
  const dateString = `${yyyy}-${mm}-${dd}`

  // Start of day UTC
  const startMs = Date.UTC(yyyy, targetDate.getUTCMonth(), targetDate.getUTCDate(), 0, 0, 0)
  // End of day UTC (actually start of next day for exclusive range)
  const endMs = startMs + 24 * 60 * 60 * 1000

  return { startMs, endMs, dateStr: dateString }
}

/**
 * Get all appointments for a specific calendar on a specific date
 * 
 * @param {string} calendarId - The GHL calendar ID
 * @param {string} date - Date string: 'yesterday', 'today', or 'YYYY-MM-DD'
 * @returns {Promise<{
 *   date: string,
 *   calendarId: string,
 *   appointments: Array<{
 *     id: string,
 *     contactName: string,
 *     contactId: string,
 *     startTime: string,
 *     endTime: string,
 *     status: 'new' | 'confirmed' | 'showed' | 'noshow' | 'cancelled',
 *     notes: string,
 *     meetingLink: string,
 *     createdBy: { source: string, userId: string }
 *   }>,
 *   summary: {
 *     total: number,
 *     byStatus: Record<string, number>
 *   }
 * }>}
 */
export async function getCalendarAppointments(calendarId, date) {
  const { startMs, endMs, dateStr } = parseDateRange(date)

  // Fetch events from GHL
  // Note: GHL returns events that START within the range, using epoch ms
  const data = await ghlRequest('/calendars/events', {
    calendarId,
    startTime: startMs.toString(),
    endTime: endMs.toString()
  })

  const events = data.events || []

  // Filter to only events that actually start on the target date
  // (API may return slightly outside range due to timezone handling)
  const filteredEvents = events.filter(evt => {
    const evtDate = evt.startTime.slice(0, 10) // Get YYYY-MM-DD part
    return evtDate === dateStr
  })

  // Map to clean output format
  const appointments = filteredEvents.map(evt => ({
    id: evt.id,
    contactName: extractContactName(evt.title),
    contactId: evt.contactId,
    startTime: evt.startTime,
    endTime: evt.endTime,
    status: evt.appointmentStatus,
    notes: evt.notes || evt.description || '',
    meetingLink: evt.address || '',
    createdBy: evt.createdBy || { source: 'unknown', userId: null }
  }))

  // Sort by start time
  appointments.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  // Calculate summary
  const byStatus = {}
  for (const appt of appointments) {
    byStatus[appt.status] = (byStatus[appt.status] || 0) + 1
  }

  return {
    date: dateStr,
    calendarId,
    appointments,
    summary: {
      total: appointments.length,
      byStatus
    }
  }
}

/**
 * Extract contact name from appointment title
 * Titles are usually formatted like "John x Maxwell - AI Growth Game Plan Call"
 */
function extractContactName(title) {
  if (!title) return ''
  // Try to extract name before " x " or " - "
  const match = title.match(/^(.+?)\s+x\s+/i) || title.match(/^(.+?)\s+-\s+/)
  if (match) {
    return match[1].trim()
  }
  return title.trim()
}

/**
 * Get appointments across multiple calendars for a date
 * @param {string[]} calendarIds
 * @param {string} date
 * @returns {Promise<Object>}
 */
export async function getAppointmentsMultiCalendar(calendarIds, date) {
  const results = await Promise.all(
    calendarIds.map(id => getCalendarAppointments(id, date))
  )

  const allAppointments = results.flatMap(r => r.appointments)
  allAppointments.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  const byStatus = {}
  for (const appt of allAppointments) {
    byStatus[appt.status] = (byStatus[appt.status] || 0) + 1
  }

  return {
    date: results[0]?.date,
    calendarIds,
    appointments: allAppointments,
    summary: {
      total: allAppointments.length,
      byStatus
    },
    byCalendar: results
  }
}

/**
 * Well-known calendar IDs for quick reference
 */
export const CALENDARS = {
  COLD_SMS: 'FITm7fIlhVTworbpJArx',
  INBOUND_STRATEGY: 'zw9NEaBUY5kYCTkGjuS7',
  META_INBOUND: '8OhPnPLb8e6czA50rozN',
  ONBOARDING: 'xV68ly3unyKB89BytgZH',
  MEETING_WITH_MAX: 'hhzCnDrgoTMj7sLr9KjS'
}

export default {
  listCalendars,
  getCalendar,
  getCalendarAppointments,
  getAppointmentsMultiCalendar,
  CALENDARS
}
