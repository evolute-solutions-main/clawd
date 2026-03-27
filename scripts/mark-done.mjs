#!/usr/bin/env node
/**
 * mark-done.mjs — Mark an onboarding step complete for a client
 *
 * Called by Evan when a team member says "Facebook access done for Smith Roofing"
 * or checks a box in the dashboard. Never called directly by humans.
 *
 * Usage:
 *   node scripts/mark-done.mjs --client "Smith Roofing" --step "facebook_access_granted"
 *   node scripts/mark-done.mjs --client "smith" --step "facebook"   (fuzzy match)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const CLIENTS_FILE = path.join(REPO_ROOT, 'data/clients.json')

// ── Args ──────────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2)
const get    = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const clientArg = get('--client')
const stepArg   = get('--step')
const actor     = get('--by') || 'unknown'

if (!clientArg || !stepArg) {
  console.error('Usage: node scripts/mark-done.mjs --client "Company Name" --step "step_key" [--by "name"]')
  process.exit(1)
}

// ── Fuzzy match helpers ───────────────────────────────────────────────────────

function matchClient(clients, query) {
  const q = query.toLowerCase()
  return clients.find(c =>
    c.companyName.toLowerCase().includes(q) ||
    c.name.toLowerCase().includes(q) ||
    c.id.toLowerCase().includes(q)
  )
}

function matchStep(steps, query) {
  const q = query.toLowerCase().replace(/[\s-]/g, '_')
  if (steps[q]) return q
  return Object.keys(steps).find(k => k.includes(q) || q.includes(k.replace(/_/g, '')))
}

// ── Step labels ───────────────────────────────────────────────────────────────

const STEP_LABELS = {
  payment_collected:             'Collect payment',
  contract_signed:               'Sign contract',
  welcome_email_sent:            'Send welcome email',
  added_to_daily_sweep:          'Add to daily sweep',
  onboarding_form_submitted:     'Complete onboarding form',
  client_joined_discord:         'Join Discord server',
  discord_channel_created:       'Create Discord channel',
  ghl_subaccount_configured:     'Configure GHL sub-account',
  facebook_access_granted:       'Grant Meta/Facebook access',
  client_media_submitted:        'Submit photos & videos',
  ad_scripts_written:            'Write ad scripts',
  ad_scripts_sent_to_client:     'Send scripts to client',
  ad_scripts_approved:           'Approve ad scripts',
  video_editor_briefed:          'Brief the video editor',
  ad_creatives_produced:         'Produce ad creatives',
  meta_campaigns_built:          'Build Meta campaigns',
  onboarding_call_booked:        'Book onboarding call',
  onboarding_call_completed:     'Complete onboarding call',
  campaigns_launched:            'Launch campaigns',
  '48hr_health_check':           'Run 48-hour health check',
  post_launch_checkin_scheduled: 'Schedule post-launch check-in'
}

// ── Dependency evaluator ──────────────────────────────────────────────────────

function getNewlyUnlocked(steps, justCompletedKey) {
  const unlocked = []
  for (const [key, step] of Object.entries(steps)) {
    if (step.status === 'complete') continue
    const deps = step.dependsOn || []
    if (!deps.includes(justCompletedKey)) continue
    const allDepsNowDone = deps.every(d => steps[d]?.status === 'complete')
    if (allDepsNowDone) unlocked.push({ key, owner: step.owner, label: STEP_LABELS[key] || key, readyToBookTrigger: step.readyToBookTrigger || false })
  }
  return unlocked
}

// ── Main ──────────────────────────────────────────────────────────────────────

const data = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))

const client = matchClient(data.clients, clientArg)
if (!client) {
  console.error(`No onboarding client found matching "${clientArg}"`)
  console.error(`Active clients: ${data.clients.filter(c => c.onboarding?.status === 'onboarding').map(c => c.companyName).join(', ')}`)
  process.exit(1)
}

const stepKey = matchStep(client.onboarding.steps, stepArg)
if (!stepKey) {
  console.error(`No step found matching "${stepArg}" for ${client.companyName}`)
  console.error(`Available steps: ${Object.keys(client.onboarding.steps).join(', ')}`)
  process.exit(1)
}

const step = client.onboarding.steps[stepKey]

if (step.status === 'complete') {
  console.log(`⚠️  "${STEP_LABELS[stepKey] || stepKey}" is already marked complete for ${client.companyName} (${step.completedAt})`)
  process.exit(0)
}

// Mark complete
const now   = new Date().toISOString()
const today = now.split('T')[0]

step.status      = 'complete'
step.completedAt = today

client.onboarding.log.push({
  timestamp: now,
  event:     'step_completed',
  step:      stepKey,
  by:        actor
})

// ── Special handlers ──────────────────────────────────────────────────────────

// Record launch timestamp for 48hr health check gating
if (stepKey === 'campaigns_launched') {
  client.onboarding.status             = 'launched'
  client.onboarding.launchedDate       = today
  client.onboarding.campaignsLaunchedAt = now
}

// Find newly unlocked steps
const newlyUnlocked = getNewlyUnlocked(client.onboarding.steps, stepKey)

// Detect ready-to-book condition — fires when onboarding_call_booked is newly unlocked
const readyToBook = newlyUnlocked.find(u => u.key === 'onboarding_call_booked' && u.readyToBookTrigger)
if (readyToBook && !client.onboarding.readyToBookCallAt) {
  client.onboarding.readyToBookCallAt = now
  client.onboarding.log.push({
    timestamp: now,
    event:     'ready_to_book_call',
    note:      'All pre-call deps met. Send booking link to client in Discord. Dashboard task created.'
  })
}

// Save
fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2))

// ── Output ────────────────────────────────────────────────────────────────────

console.log(`\n✅ [${client.companyName}] "${STEP_LABELS[stepKey] || stepKey}" marked complete`)

if (readyToBook) {
  console.log(`\n🚀 READY TO BOOK ONBOARDING CALL`)
  console.log(`   → Send booking link to ${client.companyName} in their Discord channel`)
  console.log(`   → Dashboard task created for account manager`)
}

if (newlyUnlocked.length > 0) {
  console.log(`\n🔓 Now unlocked:`)
  for (const u of newlyUnlocked) {
    console.log(`   [${u.owner || 'auto'}] ${u.label}`)
  }
} else {
  console.log(`   No new steps unlocked yet — waiting on other dependencies.`)
}

// JSON output for Evan to parse and relay to team
console.log('\n---JSON---')
console.log(JSON.stringify({
  client:       client.companyName,
  step:         stepKey,
  label:        STEP_LABELS[stepKey] || stepKey,
  newlyUnlocked,
  readyToBook:  !!readyToBook
}))
