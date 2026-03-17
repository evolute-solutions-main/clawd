/**
 * Markdown Formatter
 * 
 * Markdown formatting rules:
 * - Use standard markdown tables
 * - Headers with # syntax
 * - Standard bullet lists with -
 * - Links as [text](url)
 */

import { formatDate, sortOwners } from './index.mjs'

/**
 * Create a markdown table
 * @param {Array<Array<string>>} rows - 2D array, first row is header
 * @returns {string}
 */
function table(rows) {
  if (rows.length === 0) return ''
  
  const header = rows[0]
  const divider = header.map(() => '---')
  const body = rows.slice(1)
  
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + divider.join(' | ') + ' |',
    ...body.map(row => '| ' + row.join(' | ') + ' |')
  ]
  
  return lines.join('\n')
}

/**
 * Format Cold SMS Report as Markdown
 * @param {Object} report
 * @returns {string}
 */
export function coldSmsReport(report) {
  const lines = []
  
  // Header
  lines.push(`# Cold SMS Appointments Report — ${report.date} (${report.timezone})`)
  lines.push('')
  
  // Totals
  lines.push('## Totals')
  lines.push(table([
    ['Metric', 'Count'],
    ['Confirmed', String(report.totals.confirmed)],
    ['Unconfirmed', String(report.totals.unconfirmed)]
  ]))
  lines.push('')
  
  // By Owner
  const owners = sortOwners(report.byOwner).filter(o => o.name !== 'Unknown')
  if (owners.length > 0) {
    lines.push('## Setter Report')
    const ownerRows = [['Setter', 'Confirmed', 'Unconfirmed', 'Total']]
    for (const owner of owners) {
      ownerRows.push([
        owner.name,
        String(owner.confirmed),
        String(owner.unconfirmed),
        String(owner.confirmed + owner.unconfirmed)
      ])
    }
    lines.push(table(ownerRows))
    lines.push('')
  }
  
  // Appointments detail
  if (report.appointments?.length > 0) {
    lines.push('## Collapsed Appointments')
    lines.push('')
    
    const unconfirmed = report.appointments.filter(a => a.status === 'unconfirmed')
    const confirmed = report.appointments.filter(a => a.status === 'confirmed')
    
    if (unconfirmed.length > 0) {
      lines.push('### Unconfirmed (chronological)')
      const rows = [['Time', 'Setter', 'Name', 'Phone', 'Permalink']]
      for (const a of unconfirmed) {
        const link = a.permalink ? `<${a.permalink}>` : ''
        rows.push([a.time || '', a.setter || '', a.name || '', a.phone || '', link])
      }
      lines.push(table(rows))
      lines.push('')
    }
    
    if (confirmed.length > 0) {
      lines.push('### Confirmed (chronological)')
      const rows = [['Time', 'Setter', 'Name', 'Phone', 'Permalink']]
      for (const a of confirmed) {
        const link = a.permalink ? `<${a.permalink}>` : ''
        rows.push([a.time || '', a.setter || '', a.name || '', a.phone || '', link])
      }
      lines.push(table(rows))
      lines.push('')
    }
  }
  
  return lines.join('\n')
}

/**
 * Format Client Sweep Report as Markdown
 * @param {Object} report
 * @returns {string}
 */
export function clientSweepReport(report) {
  const lines = []
  
  lines.push(`# ${report.client} — ${formatDate(report.date)}`)
  lines.push('')
  
  if (report.summary) {
    lines.push(report.summary)
    lines.push('')
  }
  
  lines.push('---')
  lines.push('')
  
  if (report.highlights?.length > 0) {
    lines.push('## Highlights')
    for (const h of report.highlights) {
      lines.push(`- ${h}`)
    }
    lines.push('')
  }
  
  if (report.concerns?.length > 0) {
    lines.push('## Concerns')
    for (const c of report.concerns) {
      lines.push(`- ${c}`)
    }
    lines.push('')
  }
  
  if (report.actions?.length > 0) {
    lines.push('## Action Items')
    for (const a of report.actions) {
      lines.push(`- ${a}`)
    }
    lines.push('')
  }
  
  if (report.notionUrl) {
    lines.push(`[View in Notion](${report.notionUrl})`)
  }
  
  return lines.join('\n')
}

/**
 * Format a generic report as Markdown
 * @param {Object} opts
 * @returns {string}
 */
export function genericReport({ title, date, sections }) {
  const lines = []
  
  lines.push(`# ${title}${date ? ` — ${formatDate(date)}` : ''}`)
  lines.push('')
  
  for (const section of sections || []) {
    if (section.heading) {
      lines.push(`## ${section.heading}`)
    }
    
    if (section.table) {
      lines.push(table(section.table))
    }
    
    if (section.bullets) {
      for (const b of section.bullets) {
        lines.push(`- ${b}`)
      }
    }
    
    if (section.text) {
      lines.push(section.text)
    }
    
    lines.push('')
  }
  
  return lines.join('\n')
}

// Export helpers
export { table }
