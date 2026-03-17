/**
 * Notion Formatter
 * 
 * Notion formatting rules:
 * - Use Notion block types (paragraph, heading_1/2/3, bulleted_list_item, table, etc.)
 * - Rich text supports bold, italic, code, links
 * - Tables are supported (unlike Discord)
 * - Keep blocks under 100 children per request
 */

import { formatDate, sortOwners } from './index.mjs'

/**
 * Create a rich text object
 * @param {string} text
 * @param {Object} [annotations] - { bold, italic, code, underline, strikethrough }
 * @param {string} [link] - URL to link to
 */
function richText(text, annotations = {}, link = null) {
  const obj = {
    type: 'text',
    text: { content: text }
  }
  if (link) obj.text.link = { url: link }
  if (Object.keys(annotations).length > 0) {
    obj.annotations = annotations
  }
  return obj
}

/**
 * Create a paragraph block
 * @param {Array|string} content - Rich text array or plain string
 */
function paragraph(content) {
  const richTextArr = typeof content === 'string' 
    ? [richText(content)] 
    : content
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richTextArr }
  }
}

/**
 * Create a heading block
 * @param {number} level - 1, 2, or 3
 * @param {string} text
 */
function heading(level, text) {
  const type = `heading_${level}`
  return {
    object: 'block',
    type,
    [type]: { rich_text: [richText(text)] }
  }
}

/**
 * Create a bulleted list item
 * @param {Array|string} content
 */
function bulletItem(content) {
  const richTextArr = typeof content === 'string'
    ? [richText(content)]
    : content
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richTextArr }
  }
}

/**
 * Create a table block with rows
 * @param {Array<Array<string>>} rows - 2D array, first row is header
 * @param {boolean} [hasHeader=true]
 */
function table(rows, hasHeader = true) {
  if (rows.length === 0) return null
  
  const width = rows[0].length
  
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      has_column_header: hasHeader,
      has_row_header: false,
      children: rows.map(row => ({
        type: 'table_row',
        table_row: {
          cells: row.map(cell => [richText(String(cell ?? ''))])
        }
      }))
    }
  }
}

/**
 * Create a divider block
 */
function divider() {
  return { object: 'block', type: 'divider', divider: {} }
}

/**
 * Format Cold SMS Report for Notion
 * @param {Object} report
 * @returns {Array} Array of Notion blocks
 */
export function coldSmsReport(report) {
  const blocks = []
  
  // Header
  blocks.push(heading(1, `Cold SMS Report — ${formatDate(report.date)}`))
  blocks.push(paragraph(`Timezone: ${report.timezone}`))
  blocks.push(divider())
  
  // Totals
  blocks.push(heading(2, 'Totals'))
  const total = report.totals.confirmed + report.totals.unconfirmed
  blocks.push(table([
    ['Metric', 'Count'],
    ['Confirmed', String(report.totals.confirmed)],
    ['Unconfirmed', String(report.totals.unconfirmed)],
    ['Total', String(total)]
  ]))
  
  // By Owner
  const owners = sortOwners(report.byOwner).filter(o => o.name !== 'Unknown')
  if (owners.length > 0) {
    blocks.push(heading(2, 'By Setter'))
    const ownerRows = [['Setter', 'Confirmed', 'Unconfirmed', 'Total']]
    for (const owner of owners) {
      ownerRows.push([
        owner.name,
        String(owner.confirmed),
        String(owner.unconfirmed),
        String(owner.confirmed + owner.unconfirmed)
      ])
    }
    blocks.push(table(ownerRows))
  }
  
  // Appointments detail
  if (report.appointments?.length > 0) {
    blocks.push(heading(2, 'Appointments'))
    
    const confirmed = report.appointments.filter(a => a.status === 'confirmed')
    const unconfirmed = report.appointments.filter(a => a.status === 'unconfirmed')
    
    if (confirmed.length > 0) {
      blocks.push(heading(3, 'Confirmed'))
      const rows = [['Time', 'Setter', 'Name', 'Phone']]
      for (const a of confirmed) {
        rows.push([a.time || '', a.setter || '', a.name || '', a.phone || ''])
      }
      blocks.push(table(rows))
    }
    
    if (unconfirmed.length > 0) {
      blocks.push(heading(3, 'Unconfirmed'))
      const rows = [['Time', 'Setter', 'Name', 'Phone']]
      for (const a of unconfirmed) {
        rows.push([a.time || '', a.setter || '', a.name || '', a.phone || ''])
      }
      blocks.push(table(rows))
    }
  }
  
  return blocks
}

/**
 * Format Client Sweep Report for Notion
 * @param {Object} report
 * @returns {Array} Array of Notion blocks
 */
export function clientSweepReport(report) {
  const blocks = []
  
  blocks.push(heading(1, `${report.client} — ${formatDate(report.date)}`))
  
  if (report.summary) {
    blocks.push(paragraph(report.summary))
  }
  
  blocks.push(divider())
  
  if (report.highlights?.length > 0) {
    blocks.push(heading(2, 'Highlights'))
    for (const h of report.highlights) {
      blocks.push(bulletItem(h))
    }
  }
  
  if (report.concerns?.length > 0) {
    blocks.push(heading(2, 'Concerns'))
    for (const c of report.concerns) {
      blocks.push(bulletItem(c))
    }
  }
  
  if (report.actions?.length > 0) {
    blocks.push(heading(2, 'Action Items'))
    for (const a of report.actions) {
      blocks.push(bulletItem(a))
    }
  }
  
  return blocks
}

// Export helpers for custom formatting
export { richText, paragraph, heading, bulletItem, table, divider }
