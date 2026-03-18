/**
 * Google Calendar Client (ICS Feed)
 * 
 * Read-only access to Google Calendar via secret iCal URL.
 * No OAuth required - uses permanent secret URL.
 * 
 * Usage:
 *   import { getUpcomingEvents, getTodayEvents } from './agents/_shared/google-calendar/index.mjs'
 *   const events = await getUpcomingEvents({ days: 7 })
 */

const { GOOGLE_CALENDAR_ICS_URL } = process.env

if (!GOOGLE_CALENDAR_ICS_URL) {
  console.warn('Warning: GOOGLE_CALENDAR_ICS_URL not set in environment')
}

/**
 * Parse ICS text into event objects
 */
function parseICS(text) {
  const events = []
  const eventBlocks = text.split('BEGIN:VEVENT')

  for (const block of eventBlocks.slice(1)) {
    const getField = (name) => {
      // Handle multi-line values (lines starting with space are continuations)
      const regex = new RegExp(`${name}[^:]*:(.+?)(?=\\r?\\n[A-Z]|END:VEVENT)`, 's')
      const match = block.match(regex)
      if (!match) return null
      // Remove line continuations
      return match[1].replace(/\r?\n /g, '').trim()
    }

    const dtstart = getField('DTSTART')
    const dtend = getField('DTEND')
    const summary = getField('SUMMARY')
    const description = getField('DESCRIPTION')
    const location = getField('LOCATION')
    const uid = getField('UID')

    if (!dtstart || !summary) continue

    // Parse date - handle formats: 20260318T120000Z, 20260318T120000, 20260318
    let startDate, endDate
    
    const parseICSDate = (str) => {
      if (!str) return null
      // Remove TZID prefix if present
      str = str.replace(/^[^:]*:/, '')
      
      if (str.includes('T')) {
        // DateTime format
        const match = str.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/)
        if (match) {
          const [, y, m, d, h, min, s] = match
          const isUTC = str.endsWith('Z')
          if (isUTC) {
            return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s))
          } else {
            return new Date(+y, +m - 1, +d, +h, +min, +s)
          }
        }
      } else {
        // Date only format (all-day event)
        const match = str.match(/(\d{4})(\d{2})(\d{2})/)
        if (match) {
          const [, y, m, d] = match
          return new Date(+y, +m - 1, +d)
        }
      }
      return null
    }

    startDate = parseICSDate(dtstart)
    endDate = parseICSDate(dtend)

    if (!startDate) continue

    events.push({
      uid,
      summary: summary.replace(/\\\\/g, '\\').replace(/\\,/g, ',').replace(/\\n/g, '\n'),
      description: description?.replace(/\\\\/g, '\\').replace(/\\,/g, ',').replace(/\\n/g, '\n'),
      location: location?.replace(/\\\\/g, '\\').replace(/\\,/g, ','),
      start: startDate,
      end: endDate,
      allDay: !dtstart.includes('T')
    })
  }

  return events.sort((a, b) => a.start - b.start)
}

/**
 * Fetch and parse calendar events
 */
async function fetchCalendar() {
  if (!GOOGLE_CALENDAR_ICS_URL) {
    throw new Error('GOOGLE_CALENDAR_ICS_URL not configured')
  }

  const res = await fetch(GOOGLE_CALENDAR_ICS_URL)
  if (!res.ok) {
    throw new Error(`Failed to fetch calendar: ${res.status}`)
  }

  const text = await res.text()
  return parseICS(text)
}

/**
 * Get upcoming events
 * @param {Object} opts
 * @param {number} opts.days - Number of days to look ahead (default: 7)
 * @param {number} opts.limit - Max events to return (default: 20)
 */
export async function getUpcomingEvents({ days = 7, limit = 20 } = {}) {
  const events = await fetchCalendar()
  const now = new Date()
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  return events
    .filter(e => e.start >= now && e.start <= cutoff)
    .slice(0, limit)
}

/**
 * Get today's events
 * @param {Object} opts
 * @param {string} opts.timezone - Timezone for "today" calculation (default: UTC)
 */
export async function getTodayEvents({ timezone = 'UTC' } = {}) {
  const events = await fetchCalendar()
  
  // Get today's date boundaries
  const now = new Date()
  const todayStart = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')
  const todayEnd = new Date(now.toISOString().slice(0, 10) + 'T23:59:59Z')

  return events.filter(e => e.start >= todayStart && e.start <= todayEnd)
}

/**
 * Get events for a specific date
 * @param {string} date - Date string YYYY-MM-DD
 */
export async function getEventsForDate(date) {
  const events = await fetchCalendar()
  
  const dayStart = new Date(date + 'T00:00:00Z')
  const dayEnd = new Date(date + 'T23:59:59Z')

  return events.filter(e => e.start >= dayStart && e.start <= dayEnd)
}

export default { getUpcomingEvents, getTodayEvents, getEventsForDate }
