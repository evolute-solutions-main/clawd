#!/usr/bin/env node
/**
 * Post Cold SMS Report to Discord
 * Reads the structured report data and formats for Discord
 * 
 * Usage: node post-to-discord.mjs [--date=YYYY-MM-DD] [--channel=ID] [--dry-run]
 */

import fs from 'node:fs'
import path from 'node:path'
import { toDiscord, getGlobalTimezone } from '../../_shared/formatters/index.mjs'

const repoRoot = process.cwd()

// Parse args
const args = process.argv.slice(2)
const dateArg = args.find(a => a.startsWith('--date='))
const channelArg = args.find(a => a.startsWith('--channel='))
const dryRun = args.includes('--dry-run')

const DISCORD_CHANNEL = channelArg 
  ? channelArg.split('=')[1] 
  : '1475336170916544524' // Default: reports channel

// Get yesterday's date in global timezone
function getYesterdayDate(tz) {
  const now = new Date()
  // Get current date string in the timezone
  const formatter = new Intl.DateTimeFormat('en-CA', { 
    timeZone: tz, 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit' 
  })
  const todayStr = formatter.format(now)
  const [y, m, d] = todayStr.split('-').map(Number)
  const today = new Date(y, m - 1, d)
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  return yesterday.toISOString().slice(0, 10)
}

const timezone = getGlobalTimezone(repoRoot)
const date = dateArg ? dateArg.split('=')[1] : getYesterdayDate(timezone)

/**
 * Load report data from JSON or parse from markdown
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
    throw new Error(`No report found for ${date}. Run tracking first.`)
  }
  
  return parseCollapsedMarkdown(fs.readFileSync(collapsedPath, 'utf8'), date, timezone)
}

/**
 * Parse the collapsed markdown file into structured data
 */
function parseCollapsedMarkdown(content, date, timezone) {
  const lines = content.split('\n')
  
  const report = {
    date,
    timezone,
    totals: { confirmed: 0, unconfirmed: 0 },
    byOwner: [],
    appointments: []
  }
  
  const setterStats = new Map()
  let currentSection = null
  
  for (const line of lines) {
    // Detect sections
    if (line.includes('## Confirmed')) {
      currentSection = 'confirmed'
      continue
    }
    if (line.includes('## Unconfirmed')) {
      currentSection = 'unconfirmed'
      continue
    }
    if (line.includes('## Totals')) {
      currentSection = 'totals'
      continue
    }
    
    // Parse totals
    if (currentSection === 'totals') {
      const confMatch = line.match(/Confirmed:\s*(\d+)/)
      const unconfMatch = line.match(/Unconfirmed:\s*(\d+)/)
      if (confMatch) report.totals.confirmed = parseInt(confMatch[1])
      if (unconfMatch) report.totals.unconfirmed = parseInt(unconfMatch[1])
      continue
    }
    
    // Parse table rows
    if ((currentSection === 'confirmed' || currentSection === 'unconfirmed') && 
        line.startsWith('|') && !line.includes('---') && !line.includes('Time')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean)
      if (cells.length >= 4) {
        const [time, setter, name, phone] = cells
        const permalink = cells[4]?.replace(/[<>]/g, '') || ''
        
        if (setter && setter !== 'Setter') {
          // Track appointment
          report.appointments.push({
            time,
            setter,
            name: name || '',
            phone: phone || '',
            status: currentSection,
            permalink
          })
          
          // Aggregate by setter
          const stats = setterStats.get(setter) || { 
            name: setter, 
            confirmed: 0, 
            unconfirmed: 0, 
            notes: [] 
          }
          if (currentSection === 'confirmed') stats.confirmed++
          else stats.unconfirmed++
          
          // Add name or phone to notes
          const note = name || phone || ''
          if (note && !note.startsWith('|')) stats.notes.push(note)
          
          setterStats.set(setter, stats)
        }
      }
    }
  }
  
  report.byOwner = Array.from(setterStats.values())
  return report
}

/**
 * Send message to Discord via Clawdbot message tool
 * This writes to stdout for the cron handler to pick up
 */
function outputForDiscord(message, channel) {
  // Output in a format the cron system can use
  console.log('=== DISCORD MESSAGE ===')
  console.log(`Channel: ${channel}`)
  console.log('---')
  console.log(message)
  console.log('=== END ===')
}

(async () => {
  try {
    console.log(`Loading report for ${date}...`)
    const reportData = loadReportData(date)
    
    console.log(`Found ${reportData.totals.confirmed} confirmed, ${reportData.totals.unconfirmed} unconfirmed`)
    console.log(`Owners: ${reportData.byOwner.map(o => o.name).join(', ')}`)
    
    const discordMessage = toDiscord.coldSmsReport(reportData)
    
    if (dryRun) {
      console.log('\n[DRY RUN] Would post to Discord:\n')
      console.log(discordMessage)
      process.exit(0)
    }
    
    // For cron execution, output the message
    // The cron handler (Evan) will read this and use the message tool
    outputForDiscord(discordMessage, DISCORD_CHANNEL)
    
    // Also save the formatted message for reference
    const outputDir = path.join(repoRoot, 'agents/appointment-tracking/outputs', date)
    fs.writeFileSync(
      path.join(outputDir, 'discord-message.txt'),
      discordMessage
    )
    console.log(`\nSaved to ${outputDir}/discord-message.txt`)
    
  } catch (e) {
    console.error('ERROR:', e.message)
    process.exit(1)
  }
})()
