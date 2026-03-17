#!/usr/bin/env node
/**
 * Combined: Run appointment tracking + export to Google Sheets
 * Usage: node run-and-export.mjs [--date=YYYY-MM-DD] [--dry-run] [--skip-sheets]
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

const repoRoot = process.cwd()

// Pass through args
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const skipSheets = args.includes('--skip-sheets')
const dateArg = args.find(a => a.startsWith('--date='))

const date = dateArg ? dateArg.split('=')[1] : (() => {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  return yesterday.toISOString().slice(0, 10)
})()

function run(script, scriptArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [script, ...scriptArgs], {
      cwd: repoRoot,
      stdio: 'inherit'
    })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${script} exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

(async () => {
  try {
    console.log(`\n📊 Running appointment tracking for ${date}...\n`)
    await run('agents/appointment-tracking/scripts/run.mjs', [`--date=${date}`])
    
    if (skipSheets) {
      console.log('\n⏭️  Skipping Google Sheets export (--skip-sheets)\n')
    } else {
      console.log(`\n📤 Exporting to Google Sheets...\n`)
      const exportArgs = [`--date=${date}`]
      if (dryRun) exportArgs.push('--dry-run')
      await run('agents/appointment-tracking/scripts/export-to-sheets.mjs', exportArgs)
    }
    
    console.log('\n✅ Done!\n')
  } catch (e) {
    console.error('\n❌ Failed:', e.message)
    process.exit(1)
  }
})()
