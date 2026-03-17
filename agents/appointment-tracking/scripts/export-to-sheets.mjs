#!/usr/bin/env node
/**
 * Export appointment tracking data to Google Sheets
 * Uses the shared formatters for consistent output
 * 
 * Usage: node export-to-sheets.mjs --date=YYYY-MM-DD [--dry-run]
 */

import fs from 'node:fs'
import path from 'node:path'
import { appendRows, readSheet } from '../../_shared/google-sheets/index.mjs'
import { toSheets, getGlobalTimezone } from '../../_shared/formatters/index.mjs'

const SPREADSHEET_ID = '1lZzukpw0VTm-TZDBPzzNUW2hYK69nWlx1JsmF_BZ_yI'
const SHEET_NAME = 'Cold SMS EOD Reports (Setters)'

const repoRoot = process.cwd()

// Parse args
const dateArg = process.argv.find(a => a.startsWith('--date='))
const dryRun = process.argv.includes('--dry-run')

const timezone = getGlobalTimezone(repoRoot)

const date = dateArg ? dateArg.split('=')[1] : (() => {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  return yesterday.toISOString().slice(0, 10)
})()

/**
 * Load report data from JSON or fall back to parsing markdown
 */
function loadReportData(date) {
  const outputDir = path.join(repoRoot, 'agents/appointment-tracking/outputs', date)
  
  // Try JSON first (structured data)
  const jsonPath = path.join(outputDir, 'cold-sms.report.json')
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  }
  
  // Fall back to parsing collapsed markdown
  const collapsedPath = path.join(outputDir, 'cold-sms.appointments.collapsed.md')
  if (!fs.existsSync(collapsedPath)) {
    return null
  }
  
  return parseCollapsedFile(collapsedPath, date)
}

/**
 * Parse collapsed markdown file (legacy support)
 */
function parseCollapsedFile(filePath, date) {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n')
  
  const report = {
    date,
    timezone,
    totals: { confirmed: 0, unconfirmed: 0 },
    byOwner: []
  }
  
  const setterStats = new Map()
  let currentSection = null
  
  for (const line of lines) {
    if (line.includes('## Confirmed')) {
      currentSection = 'confirmed'
      continue
    }
    if (line.includes('## Unconfirmed')) {
      currentSection = 'unconfirmed'
      continue
    }
    if (line.includes('## Totals')) {
      currentSection = null
      continue
    }
    
    if (currentSection && line.startsWith('|') && !line.includes('---') && !line.includes('Time')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean)
      if (cells.length >= 4) {
        const [time, setter, name, phone] = cells
        if (setter && setter !== 'Setter') {
          const stats = setterStats.get(setter) || { 
            name: setter, 
            confirmed: 0, 
            unconfirmed: 0, 
            notes: [] 
          }
          if (currentSection === 'confirmed') {
            stats.confirmed++
            report.totals.confirmed++
          } else {
            stats.unconfirmed++
            report.totals.unconfirmed++
          }
          if (name) stats.notes.push(name)
          else if (phone) stats.notes.push(phone)
          setterStats.set(setter, stats)
        }
      }
    }
  }
  
  report.byOwner = Array.from(setterStats.values())
  return report
}

/**
 * Format date for display in sheet (M/D/YYYY)
 */
function formatDateForSheet(isoDate) {
  const [y, m, d] = isoDate.split('-')
  return `${parseInt(m)}/${parseInt(d)}/${y}`
}

/**
 * Check if data already exists for this date/setter combo
 */
async function getExistingEntries() {
  try {
    const result = await readSheet({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:B`,
      repoRoot
    })
    const entries = new Set()
    for (const row of result.values || []) {
      if (row[0] && row[1]) {
        entries.add(`${row[0]}|${row[1]}`)
      }
    }
    return entries
  } catch (e) {
    console.error('Warning: Could not check existing entries:', e.message)
    return new Set()
  }
}

(async () => {
  try {
    const reportData = loadReportData(date)
    
    if (!reportData) {
      console.error(`No data found for ${date}. Run the appointment tracking first:`)
      console.error(`  node agents/appointment-tracking/scripts/run.mjs --date=${date}`)
      process.exit(1)
    }
    
    // Use the shared formatter
    const rows = toSheets.coldSmsReportRows(reportData, { includeUnknown: false })
    
    if (rows.length === 0) {
      console.log(`No setter data found for ${date}`)
      process.exit(0)
    }
    
    // Check for existing entries to avoid duplicates
    const existing = await getExistingEntries()
    const sheetDate = formatDateForSheet(date)
    
    const newRows = rows.filter(row => {
      const key = `${row[0]}|${sheetDate}`
      if (existing.has(key)) {
        console.log(`Skipping ${row[0]} for ${sheetDate} - already exists`)
        return false
      }
      return true
    })
    
    if (newRows.length === 0) {
      console.log('No new rows to add (all entries already exist)')
      process.exit(0)
    }
    
    console.log(`\nRows to append for ${date}:`)
    console.log('Setter | Date | UniqueContacts | Dials | Unconfirmed | Confirmed | Notes')
    console.log('-'.repeat(80))
    for (const row of newRows) {
      console.log(row.join(' | '))
    }
    
    if (dryRun) {
      console.log('\n[DRY RUN] Would append', newRows.length, 'rows')
      process.exit(0)
    }
    
    const result = await appendRows({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
      values: newRows,
      repoRoot
    })
    
    console.log(`\n✓ Appended ${newRows.length} rows to Google Sheets`)
    console.log(`  Updated range: ${result.updates?.updatedRange || 'unknown'}`)
    
  } catch (e) {
    console.error('ERROR:', e.message)
    process.exit(1)
  }
})()
