/**
 * Shared Formatters - Common utilities and re-exports
 * 
 * Design Principles:
 * 1. Single source of truth: Raw data as JSON/object
 * 2. Destination-specific formatters: Each output has its own renderer
 * 3. Consistent data shapes: Each report type defines a schema
 * 4. No hardcoded timezones: Always read from SETTINGS.md
 * 
 * Usage:
 *   import { toDiscord, toNotion, toMarkdown, toSheets } from './formatters/index.mjs'
 *   const discordMsg = toDiscord.coldSmsReport(reportData)
 */

import fs from 'node:fs'
import path from 'node:path'

// Re-export all formatters
export * as toDiscord from './discord.mjs'
export * as toNotion from './notion.mjs'
export * as toMarkdown from './markdown.mjs'
export * as toSheets from './sheets.mjs'

/**
 * Read the global timezone from SETTINGS.md
 * @param {string} repoRoot - Path to repo root
 * @returns {string} IANA timezone string
 */
export function getGlobalTimezone(repoRoot = process.cwd()) {
  try {
    const settingsPath = path.join(repoRoot, 'SETTINGS.md')
    const content = fs.readFileSync(settingsPath, 'utf8')
    const match = content.match(/^-\s*value:\s*(.+)$/m)
    return match ? match[1].trim() : 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Format a date for display
 * @param {string} isoDate - YYYY-MM-DD format
 * @param {string} style - 'short' (Mar 16), 'long' (March 16, 2026), 'iso' (2026-03-16)
 */
export function formatDate(isoDate, style = 'long') {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  
  if (style === 'iso') return isoDate
  if (style === 'short') {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Format date for Google Sheets (M/D/YYYY)
 * @param {string} isoDate - YYYY-MM-DD format
 */
export function formatDateForSheets(isoDate) {
  const [y, m, d] = isoDate.split('-')
  return `${parseInt(m)}/${parseInt(d)}/${y}`
}

/**
 * Pluralize a word
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 */
export function pluralize(count, singular, plural) {
  return count === 1 ? singular : (plural || singular + 's')
}

/**
 * Sort owners alphabetically, but put "Unknown" last
 * @param {Array<{name: string}>} owners
 */
export function sortOwners(owners) {
  return [...owners].sort((a, b) => {
    if (a.name === 'Unknown') return 1
    if (b.name === 'Unknown') return -1
    return a.name.localeCompare(b.name)
  })
}
