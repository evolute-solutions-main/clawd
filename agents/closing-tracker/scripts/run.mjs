#!/usr/bin/env node
/**
 * Closing Tracker Runner
 * 
 * Usage:
 *   node agents/closing-tracker/scripts/run.mjs [--date=YYYY-MM-DD|yesterday|today]
 */

import '../../_shared/env-loader.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { getClosingData, TRACKED_CALENDARS } from '../lib/get-closing-data.mjs'

const args = process.argv.slice(2)
const dateArg = args.find(a => a.startsWith('--date='))
const date = dateArg ? dateArg.split('=')[1] : 'yesterday'

console.log(`\n🎯 Closing Tracker`)
console.log(`Date: ${date}`)
console.log(`Tracking calendars: ${TRACKED_CALENDARS.map(c => c.name).join(', ')}`)
console.log('─'.repeat(60))

try {
  const result = await getClosingData(date)
  
  console.log(`\n📅 Date: ${result.date}`)
  console.log(`\n📊 Summary:`)
  console.log(`   Total Scheduled: ${result.summary.totalScheduled}`)
  console.log(`   Showed: ${result.summary.showed}`)
  console.log(`   No-Show: ${result.summary.noShow}`)
  
  console.log(`\n📋 Appointments:`)
  console.log('─'.repeat(60))
  
  for (const appt of result.appointments) {
    const time = appt.startTime.slice(11, 16)
    const status = appt.showStatus === 'showed' ? '✅' : '❌'
    const ghlStatus = appt.ghlStatus.padEnd(10)
    const name = (appt.contactName || 'Unknown').slice(0, 20).padEnd(20)
    const calendar = appt.calendarName.slice(0, 12).padEnd(12)
    
    console.log(`${time} | ${status} ${appt.showStatus.padEnd(7)} | ${ghlStatus} | ${name} | ${calendar}`)
    
    if (appt.matchedFathomCall) {
      const dur = appt.matchedFathomCall.duration 
        ? `${Math.round(appt.matchedFathomCall.duration / 60)}min` 
        : ''
      console.log(`       └─ Fathom: "${appt.matchedFathomCall.title}" ${dur}`)
    }
  }
  
  console.log('─'.repeat(60))
  
  console.log(`\n📹 Fathom Calls Found: ${result.fathomCalls.length}`)
  for (const call of result.fathomCalls) {
    const dur = call.duration ? `(${Math.round(call.duration / 60)}min)` : ''
    console.log(`   - ${call.title} ${dur}`)
  }
  
  // Write output file
  const outDir = path.join(process.cwd(), 'agents/closing-tracker/outputs', result.date)
  fs.mkdirSync(outDir, { recursive: true })
  
  const outPath = path.join(outDir, 'closing-data.json')
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\n💾 Saved to: ${outPath}`)
  
} catch (err) {
  console.error('Error:', err.message)
  console.error(err.stack)
  process.exit(1)
}
