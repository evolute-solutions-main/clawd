/**
 * Discord Formatter
 * 
 * Discord formatting rules:
 * - NO markdown tables (render as bullet lists)
 * - Wrap multiple links in <> to suppress embeds
 * - Use **bold** for emphasis
 * - Use bullet points (•) for lists
 * - Keep messages under 2000 chars (split if needed)
 * - Emojis are encouraged for visual scanning
 */

import { formatDate, sortOwners, pluralize } from './index.mjs'

/**
 * Format Cold SMS Report for Discord
 * @param {Object} report
 * @param {string} report.date - YYYY-MM-DD
 * @param {string} report.timezone
 * @param {Object} report.totals - { confirmed, unconfirmed }
 * @param {Array} report.byOwner - [{ name, confirmed, unconfirmed, notes }]
 * @param {Array} [report.appointments] - [{ time, setter, name, phone, status, permalink }]
 * @returns {string} Discord-formatted message
 */
export function coldSmsReport(report) {
  const lines = []
  
  // Header
  lines.push(`📊 **Cold SMS Report — ${formatDate(report.date)}**`)
  lines.push('')
  
  // Totals
  const total = report.totals.confirmed + report.totals.unconfirmed
  lines.push('**Totals**')
  lines.push(`• Confirmed: **${report.totals.confirmed}**`)
  lines.push(`• Unconfirmed: **${report.totals.unconfirmed}**`)
  lines.push(`• Total: **${total}** ${pluralize(total, 'appointment')}`)
  lines.push('')
  
  // By Owner (sorted, skip Unknown)
  const owners = sortOwners(report.byOwner).filter(o => o.name !== 'Unknown')
  if (owners.length > 0) {
    lines.push('**By Setter**')
    for (const owner of owners) {
      const parts = []
      if (owner.confirmed > 0) parts.push(`${owner.confirmed} confirmed`)
      if (owner.unconfirmed > 0) parts.push(`${owner.unconfirmed} unconfirmed`)
      const summary = parts.length > 0 ? parts.join(', ') : 'none'
      lines.push(`• **${owner.name}**: ${summary}`)
    }
    lines.push('')
  }
  
  // Appointment names (if any)
  const allNotes = owners.flatMap(o => o.notes || []).filter(Boolean)
  if (allNotes.length > 0) {
    lines.push('**Appointments**')
    // Group by setter for clarity
    for (const owner of owners) {
      const notes = (owner.notes || []).filter(Boolean)
      if (notes.length > 0) {
        // Format: phone numbers as-is, names capitalized
        const formatted = notes.map(n => {
          if (n.startsWith('+') || /^\d+$/.test(n)) return n
          return n.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
        })
        lines.push(`• ${owner.name}: ${formatted.join(', ')}`)
      }
    }
  }
  
  return lines.join('\n')
}

/**
 * Format Client Sweep Report for Discord
 * @param {Object} report
 * @param {string} report.date
 * @param {string} report.client
 * @param {string} report.summary
 * @param {Array} report.highlights
 * @param {Array} report.concerns
 * @param {string} [report.notionUrl]
 * @returns {string}
 */
export function clientSweepReport(report) {
  const lines = []
  
  lines.push(`🔍 **Client Sweep: ${report.client}** — ${formatDate(report.date)}`)
  lines.push('')
  
  if (report.summary) {
    lines.push(report.summary)
    lines.push('')
  }
  
  if (report.highlights?.length > 0) {
    lines.push('**Highlights**')
    for (const h of report.highlights) {
      lines.push(`• ${h}`)
    }
    lines.push('')
  }
  
  if (report.concerns?.length > 0) {
    lines.push('**Concerns**')
    for (const c of report.concerns) {
      lines.push(`• ${c}`)
    }
    lines.push('')
  }
  
  if (report.notionUrl) {
    lines.push(`📄 Full report: <${report.notionUrl}>`)
  }
  
  return lines.join('\n')
}

/**
 * Format a generic summary for Discord
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} [opts.emoji]
 * @param {Object} [opts.stats] - key-value pairs
 * @param {Array} [opts.items] - bullet points
 * @param {string} [opts.footer]
 * @returns {string}
 */
export function genericSummary({ title, emoji = '📋', stats, items, footer }) {
  const lines = []
  
  lines.push(`${emoji} **${title}**`)
  lines.push('')
  
  if (stats && Object.keys(stats).length > 0) {
    for (const [key, value] of Object.entries(stats)) {
      lines.push(`• **${key}**: ${value}`)
    }
    lines.push('')
  }
  
  if (items?.length > 0) {
    for (const item of items) {
      lines.push(`• ${item}`)
    }
    lines.push('')
  }
  
  if (footer) {
    lines.push(footer)
  }
  
  return lines.join('\n').trim()
}
