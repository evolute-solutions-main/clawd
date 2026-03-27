#!/usr/bin/env node
/**
 * Simple cron runner - executes workflows and posts results to Discord
 * 
 * Usage:
 *   node cron-runner.mjs sweep          # Client sweep → post Notion link
 *   node cron-runner.mjs appt-report    # Appt setter report → post summary
 *   node cron-runner.mjs appt-collect   # Appt data collection (no post)
 *   node cron-runner.mjs appt-sync      # Rolling GHL sync (90d back, 30d forward) — runs every 30min
 */

// Load secrets first
import './_shared/env-loader.mjs'

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { postMessage } from './_shared/discord/index.mjs'
import { getGlobalTimezone } from './_shared/formatters/index.mjs'

const REPO_ROOT = '/root/clawd-evan'
const DISCORD_CHANNEL = '1475336170916544524'
const TZ = getGlobalTimezone(REPO_ROOT)

// Post to Discord — uses correct token automatically
async function postToDiscord(message) {
  return postMessage(DISCORD_CHANNEL, message)
}

// Get yesterday's date in global timezone
function getYesterdayDate() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(yesterday)
}

// Get today's date in global timezone
function getTodayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

// Get a date offset by N days from today in global timezone
function getDateOffset(days) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86400000))
}

// Run client sweep
async function runSweep() {
  console.log('Running client sweep...')
  
  const result = execSync(
    `cd ${REPO_ROOT} && node agents/client-sweep/scripts/run-pipeline.mjs 2>&1`,
    { encoding: 'utf8', timeout: 600000 } // 10 min timeout
  )
  
  console.log(result)
  
  // Extract Notion URL from output
  const notionMatch = result.match(/NOTION_PAGE_URL\s+(https:\/\/www\.notion\.so\/[^\s]+)/)
  const notionUrl = notionMatch ? notionMatch[1] : null
  
  // Count clients
  const clientMatch = result.match(/Found (\d+) clients/)
  const clientCount = clientMatch ? clientMatch[1] : '?'
  
  // Check for failures
  const failMatch = result.match(/(\d+) client\(s\) failed/)
  const failCount = failMatch ? failMatch[1] : '0'
  
  const date = getTodayDate()
  let message = `📋 **Client Sweep Complete** — ${date}\n`
  message += `Processed ${clientCount} clients`
  if (failCount !== '0') message += ` (${failCount} failed)`
  message += `\n`
  if (notionUrl) message += `\n${notionUrl}`
  
  await postToDiscord(message)
  console.log('Posted to Discord')
}

// Run appointment setter report
async function runApptReport() {
  const yesterday = getYesterdayDate()
  console.log(`Running appt setter report for ${yesterday}...`)
  
  const result = execSync(
    `cd ${REPO_ROOT} && node agents/appointment-tracking/scripts/run.mjs --date=${yesterday} 2>&1`,
    { encoding: 'utf8', timeout: 300000 } // 5 min timeout
  )
  
  console.log(result)
  
  // Read the generated report
  const reportPath = path.join(REPO_ROOT, `agents/appointment-tracking/outputs/${yesterday}/cold-sms.appointments.report.md`)
  
  let message
  if (fs.existsSync(reportPath)) {
    const report = fs.readFileSync(reportPath, 'utf8')
    
    // Convert to Discord-friendly format (truncate if needed)
    message = `📞 **Appointment Setter Report** — ${yesterday}\n\n`
    
    // Extract key stats from the report
    const lines = report.split('\n')
    const statsSection = []
    let inStats = false
    
    for (const line of lines) {
      if (line.includes('## Summary') || line.includes('# ') || line.match(/^\*\*Total/)) {
        inStats = true
      }
      if (inStats && line.trim()) {
        statsSection.push(line)
        if (statsSection.length > 20) break // Limit length
      }
    }
    
    message += statsSection.join('\n') || report.slice(0, 1500)
    
    // Truncate if too long for Discord
    if (message.length > 1900) {
      message = message.slice(0, 1900) + '\n\n_(truncated)_'
    }
  } else {
    message = `📞 **Appointment Setter Report** — ${yesterday}\n\nNo data found for this date.`
  }
  
  await postToDiscord(message)
  console.log('Posted to Discord')
}

// Run onboarding briefing
async function runOnboarding() {
  console.log('Running onboarding briefing...')

  const result = execSync(
    `cd ${REPO_ROOT} && node agents/onboarding/scripts/run.mjs 2>&1`,
    { encoding: 'utf8', timeout: 60000 }
  )

  console.log(result)

  if (!result.trim() || result.includes('No active onboarding clients')) {
    console.log('No onboarding clients — skipping Discord post')
    return
  }

  // Discord max is 2000 chars — split into chunks
  const chunks = []
  const lines = result.split('\n')
  let chunk = ''
  for (const line of lines) {
    if ((chunk + line + '\n').length > 1900) {
      chunks.push(chunk.trimEnd())
      chunk = ''
    }
    chunk += line + '\n'
  }
  if (chunk.trim()) chunks.push(chunk.trimEnd())

  for (const c of chunks) {
    await postToDiscord(c)
  }
  console.log(`Posted ${chunks.length} message(s) to Discord`)
}

// Rolling GHL sync — fetches 90 days back through 30 days forward, upserts into sales_data.json
async function runApptSync() {
  const from = getDateOffset(-90)
  const to   = getDateOffset(30)
  console.log(`Syncing appointments from ${from} to ${to}...`)

  const result = execSync(
    `cd ${REPO_ROOT} && node scripts/fetch-raw-appts.mjs --from ${from} --to ${to} 2>&1`,
    { encoding: 'utf8', timeout: 300000 }
  )

  console.log(result)
  console.log('Appointment sync complete')
}

// Run appointment data collection (no Discord post)
async function runApptCollect() {
  const today = getTodayDate()
  console.log(`Collecting appointment data for ${today}...`)
  
  const result = execSync(
    `cd ${REPO_ROOT} && node agents/appointment-tracking/scripts/run.mjs --date=${today} 2>&1`,
    { encoding: 'utf8', timeout: 300000 }
  )
  
  console.log(result)
  console.log('Data collection complete (no Discord post)')
}

// Main
async function main() {
  // Secrets already loaded by env-loader.mjs import
  const cmd = process.argv[2]
  
  switch (cmd) {
    case 'sweep':
      await runSweep()
      break
    case 'appt-report':
      await runApptReport()
      break
    case 'appt-collect':
      await runApptCollect()
      break
    case 'onboarding':
      await runOnboarding()
      break
    case 'appt-sync':
      await runApptSync()
      break
    default:
      console.error('Usage: node cron-runner.mjs <sweep|appt-report|appt-collect|appt-sync|onboarding>')
      process.exit(1)
  }
}

main().catch(err => {
  console.error('FATAL:', err.message)
  process.exit(1)
})
