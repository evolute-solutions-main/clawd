/**
 * Closing Tracker - Get appointment show/no-show data for a date
 * 
 * Pulls appointments from tracked calendars, matches against Fathom calls,
 * and returns each appointment with showed/no-show status.
 * 
 * Usage:
 *   import { getClosingData } from './lib/get-closing-data.mjs'
 *   const result = await getClosingData('2026-03-17')
 */

import { getCalendarAppointments } from '../../_shared/ghl/index.mjs'
import { iterateMeetings } from '../../_shared/fathom/index.mjs'

/**
 * Calendars to track for closing/sales calls
 * Add/remove calendar IDs here to change what's tracked
 */
export const TRACKED_CALENDARS = [
  { id: 'FITm7fIlhVTworbpJArx', name: 'Cold SMS' },
  { id: '8OhPnPLb8e6czA50rozN', name: 'Meta Inbound' },
]

/**
 * Normalize a title for matching (lowercase, trim, remove extra spaces)
 */
function normalizeTitle(title) {
  if (!title) return ''
  return title.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Extract the contact/lead name from an appointment or call title
 * GHL format: "Bob x Maxwell - AI Growth Game Plan Call"
 * Fathom format: similar or just the meeting name
 */
function extractName(title) {
  if (!title) return ''
  // Try to get name before " x " or before " - "
  const normalized = normalizeTitle(title)
  const match = normalized.match(/^(.+?)\s+x\s+/i) || normalized.match(/^(.+?)\s+-\s+/)
  if (match) {
    return match[1].trim()
  }
  return normalized
}

/**
 * Check if a GHL appointment matches a Fathom call
 * Match by: normalized title similarity or extracted contact name
 */
// Heuristic: determine if a call/title likely represents a sales call
function isLikelySalesTitle(title) {
  const t = normalizeTitle(title)
  if (!t) return false
  // Denylist obvious non-sales/internal items
  const deny = ['promotion', 'reveal', 'highlevel', 'internal', 'standup']
  if (deny.some(w => t.includes(w))) return false
  // Allowlist common sales patterns
  const allow = [
    'x maxwell - ai growth game plan call',
    'ai growth game plan call',
    'ai strategy session',
    'strategy session',
    'growth game plan',
    'discovery call',
    'intro call',
    'maxwell -',
    ' x maxwell '
  ]
  return allow.some(w => t.includes(w))
}

function isMatch(appointment, fathomCall) {
  const apptTitle = normalizeTitle(appointment.title || '')
  const fathomTitle = normalizeTitle(fathomCall.title || fathomCall.meeting_title || '')
  
  // Quick filter: only consider fathom calls that look like sales calls
  if (!isLikelySalesTitle(fathomTitle)) {
    return false
  }
  
  // Exact title match
  if (apptTitle && fathomTitle && apptTitle === fathomTitle) {
    return true
  }
  
  // Extract names and compare
  const apptName = extractName(appointment.title)
  const fathomName = extractName(fathomCall.title || fathomCall.meeting_title)
  
  if (apptName && fathomName && apptName.length > 2) {
    // Check if names match or one contains the other
    if (apptName === fathomName) return true
    if (apptName.includes(fathomName) || fathomName.includes(apptName)) return true
  }
  
  return false
}

/**
 * Get closing data for a specific date
 * 
 * @param {string} date - Date string: 'yesterday', 'today', or 'YYYY-MM-DD'
 * @returns {Promise<{
 *   date: string,
 *   appointments: Array<{
 *     id: string,
 *     calendarId: string,
 *     calendarName: string,
 *     contactName: string,
 *     contactId: string,
 *     startTime: string,
 *     endTime: string,
 *     ghlStatus: string,
 *     showStatus: 'showed' | 'no-show',
 *     notes: string,
 *     matchedFathomCall: object | null
 *   }>,
 *   fathomCalls: Array<object>,
 *   summary: {
 *     totalScheduled: number,
 *     showed: number,
 *     noShow: number
 *   }
 * }>}
 */
export async function getClosingData(date) {
  // Normalize date string
  let dateStr = date
  if (date === 'today') {
    dateStr = new Date().toISOString().slice(0, 10)
  } else if (date === 'yesterday') {
    dateStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  }

  // Step 1: Get appointments from all tracked calendars
  const allAppointments = []
  
  for (const calendar of TRACKED_CALENDARS) {
    const result = await getCalendarAppointments(calendar.id, dateStr)
    
    // Filter: exclude "new" status (include confirmed, showed, noshow, cancelled)
    const filtered = result.appointments.filter(appt => appt.status !== 'new')
    
    // Add calendar info to each appointment
    for (const appt of filtered) {
      allAppointments.push({
        ...appt,
        calendarId: calendar.id,
        calendarName: calendar.name,
        title: appt.contactName ? `${appt.contactName}` : 'Unknown' // Keep original title for matching
      })
    }
  }

  // Step 2: Get Fathom calls for the date
  // Fathom API doesn't filter by date server-side, so we iterate and filter client-side
  // Limit pages to avoid runaway iteration on large accounts
  const fathomCalls = []
  
  for await (const call of iterateMeetings({ pageSize: 50, maxPages: 10 })) {
    // Get the call date - prefer scheduled/recording time over created_at
    // (created_at can be after midnight for late-night calls)
    const callDate = (
      call.scheduled_start_time || 
      call.recording_start_time || 
      call.start_time || 
      call.created_at || 
      ''
    ).slice(0, 10)
    if (callDate === dateStr) {
      fathomCalls.push(call)
    }
  }

  // Step 3: Match appointments to Fathom calls
  const enrichedAppointments = []
  
  for (const appt of allAppointments) {
    // Find matching Fathom call
    const matchedCall = fathomCalls.find(call => isMatch(appt, call))
    
    enrichedAppointments.push({
      id: appt.id,
      calendarId: appt.calendarId,
      calendarName: appt.calendarName,
      contactName: appt.contactName,
      contactId: appt.contactId,
      startTime: appt.startTime,
      endTime: appt.endTime,
      ghlStatus: appt.status,
      showStatus: matchedCall ? 'showed' : 'no-show',
      notes: appt.notes,
      matchedFathomCall: matchedCall ? {
        id: matchedCall.id,
        title: matchedCall.title || matchedCall.meeting_title,
        duration: matchedCall.duration,
        recordingUrl: matchedCall.recording_url
      } : null
    })
  }

  // Sort by start time
  enrichedAppointments.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  // Calculate summary
  const showed = enrichedAppointments.filter(a => a.showStatus === 'showed').length
  const noShow = enrichedAppointments.filter(a => a.showStatus === 'no-show').length

  return {
    date: dateStr,
    appointments: enrichedAppointments,
    fathomCalls: fathomCalls.map(c => ({
      id: c.id,
      title: c.title || c.meeting_title,
      startTime: c.start_time,
      duration: c.duration
    })),
    summary: {
      totalScheduled: enrichedAppointments.length,
      showed,
      noShow
    }
  }
}

export default { getClosingData, TRACKED_CALENDARS }
