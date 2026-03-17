/**
 * Google Sheets Formatter
 * 
 * Sheets formatting rules:
 * - Output as 2D array of values
 * - First row can be headers (optional)
 * - Dates as M/D/YYYY (Sheets-friendly)
 * - Numbers as numbers, not strings
 * - Empty values as empty strings
 */

import { formatDateForSheets, sortOwners } from './index.mjs'

/**
 * Format Cold SMS Report for Google Sheets
 * Returns rows for the "Cold SMS EOD Reports (Setters)" sheet
 * Columns: [Setter, Date, UniqueContacts, Dials, Unconfirmed, Confirmed, Notes]
 * 
 * @param {Object} report
 * @param {Object} [opts]
 * @param {boolean} [opts.includeUnknown=false] - Include Unknown setter
 * @returns {Array<Array>} 2D array of rows (no header)
 */
export function coldSmsReportRows(report, opts = {}) {
  const { includeUnknown = false } = opts
  const rows = []
  
  const sheetDate = formatDateForSheets(report.date)
  const owners = sortOwners(report.byOwner)
  
  for (const owner of owners) {
    // Skip Unknown unless explicitly included
    if (owner.name === 'Unknown' && !includeUnknown) continue
    
    const notes = (owner.notes || [])
      .filter(Boolean)
      .map(n => {
        // Clean up notes: capitalize names, keep phone numbers as-is
        if (n.startsWith('+') || /^\d+$/.test(n)) return n
        return n.trim()
      })
      .join(', ')
    
    rows.push([
      owner.name,           // Setter
      sheetDate,            // Date (M/D/YYYY)
      '',                   // Unique Contacts (manual input)
      '',                   // Dials (manual input)
      owner.unconfirmed,    // Unconfirmed
      owner.confirmed,      // Confirmed
      notes                 // Notes (appointment names)
    ])
  }
  
  return rows
}

/**
 * Format Cold SMS Report with headers (for new sheets or exports)
 * @param {Object} report
 * @returns {Array<Array>}
 */
export function coldSmsReportWithHeaders(report) {
  return [
    ['Setter', 'Date', 'Unique Contacts', 'Dials', 'Unconfirmed', 'Confirmed', 'Notes'],
    ...coldSmsReportRows(report)
  ]
}

/**
 * Format appointments as rows for detailed tracking
 * Columns: [Date, Time, Setter, Name, Phone, Status, Permalink]
 * 
 * @param {Object} report
 * @returns {Array<Array>}
 */
export function appointmentDetailRows(report) {
  const rows = []
  const sheetDate = formatDateForSheets(report.date)
  
  for (const appt of report.appointments || []) {
    rows.push([
      sheetDate,
      appt.time || '',
      appt.setter || 'Unknown',
      appt.name || '',
      appt.phone || '',
      appt.status || '',
      appt.permalink || ''
    ])
  }
  
  return rows
}

/**
 * Format generic data as rows
 * @param {Array<Object>} items - Array of objects
 * @param {Array<string>} columns - Column keys to extract
 * @param {Object} [transforms] - Key -> transform function map
 * @returns {Array<Array>}
 */
export function genericRows(items, columns, transforms = {}) {
  return items.map(item => 
    columns.map(col => {
      const value = item[col]
      if (transforms[col]) return transforms[col](value, item)
      return value ?? ''
    })
  )
}

/**
 * Add headers to rows
 * @param {Array<string>} headers
 * @param {Array<Array>} rows
 * @returns {Array<Array>}
 */
export function withHeaders(headers, rows) {
  return [headers, ...rows]
}
