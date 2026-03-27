#!/usr/bin/env node
/**
 * new-client.mjs — Create a new onboarding record when a client is signed
 *
 * Run this immediately after closing a deal on the sales call.
 * Marks payment, contract, welcome email as complete and kicks off
 * the onboarding checklist with all dependencies pre-wired.
 *
 * Usage:
 *   node scripts/new-client.mjs --name "John Smith" --company "Smith Roofing" --email "john@smithroofing.com"
 *   node scripts/new-client.mjs --name "John Smith" --company "Smith Roofing" --email "john@smithroofing.com" \
 *     --contract-end "2026-09-25" --fathom "https://fathom.ai/..." --stripe "cus_xxx" --video-editor
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import { syncAllClients } from '../lib/client-sync.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT    = path.resolve(__dirname, '..')
const CLIENTS_FILE = path.join(REPO_ROOT, 'data/clients.json')
const SALES_FILE   = path.join(REPO_ROOT, 'data/sales_data.json')
const TEAM_FILE    = path.join(REPO_ROOT, 'data/team.json')

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const name            = get('--name')
const company         = get('--company') || name
const email           = get('--email')
const contractEnd     = get('--contract-end')
const fathomLink      = get('--fathom')
const stripeId        = get('--stripe')
const appointmentId   = get('--appointment-id') || null
const signedDate      = get('--signed') || null   // historical clients: pass actual sign date
const needsVideoEditor = args.includes('--video-editor')

if (!name || !email) {
  console.error('Usage: node scripts/new-client.mjs --name "Name" --email "email@example.com" [--company "Co"] [--contract-end "YYYY-MM-DD"] [--fathom "url"] [--stripe "cus_xxx"] [--appointment-id "ghl_appt_xxx"] [--signed "YYYY-MM-DD"] [--video-editor]')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const now   = new Date().toISOString()
const today = signedDate || now.split('T')[0]  // use --signed if provided
const id    = 'client_' + company.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now()

function makeSteps(needsVideoEditor) {
  const steps = {
    // ── Done at signing ────────────────────────────────────────────────────
    payment_collected: {
      status: 'complete', completedAt: today,
      autoDetected: true, trigger: 'manual',
      note: 'Collected on closing call'
    },
    contract_signed: {
      status: 'complete', completedAt: today,
      autoDetected: false, trigger: 'manual'
    },
    welcome_email_sent: {
      status: 'complete', completedAt: today,
      autoDetected: true, trigger: 'auto'
    },
    added_to_daily_sweep: {
      status: 'complete', completedAt: today,
      autoDetected: true, trigger: 'auto'
    },

    // ── Client actions — auto-detected via webhooks/events ─────────────────
    onboarding_form_submitted: {
      status: 'pending', completedAt: null,
      autoDetected: true, trigger: 'ghl_webhook',
      dependsOn: ['contract_signed']
    },
    client_joined_discord: {
      status: 'pending', completedAt: null,
      autoDetected: true, trigger: 'discord_event',
      dependsOn: ['contract_signed']
    },
    discord_channel_created: {
      status: 'pending', completedAt: null,
      autoDetected: true, trigger: 'auto',
      dependsOn: ['client_joined_discord'],
      note: 'Bot auto-creates channel and adds client on join'
    },

    // ── Account Manager — post-form ────────────────────────────────────────
    ghl_subaccount_configured: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'accountManager',
      dependsOn: ['onboarding_form_submitted'],
      note: 'Create GHL sub-account and configure settings'
    },
    facebook_access_granted: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'accountManager',
      dependsOn: ['onboarding_form_submitted'],
      note: 'Client grants access to Meta Business Manager'
    },

    // ── Client deliverables ────────────────────────────────────────────────
    client_media_submitted: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'accountManager',
      dependsOn: ['onboarding_form_submitted'],
      note: 'Client sends photos/videos via Discord or onboarding funnel'
    },

    // ── Scripts track ──────────────────────────────────────────────────────
    ad_scripts_written: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'mediaBuyer',
      dependsOn: ['onboarding_form_submitted'],
      note: 'Media buyer writes ad scripts (future: AI-assisted from Fathom call)'
    },
    ad_scripts_sent_to_client: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'mediaBuyer',
      dependsOn: ['ad_scripts_written'],
      note: 'Send to client via their Discord channel'
    },
    ad_scripts_approved: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'accountManager',
      dependsOn: ['ad_scripts_sent_to_client'],
      note: 'Client reviews, revises if needed, then approves. Mark done when final approval received.'
    },
  }

  // ── Video editor path (conditional) ────────────────────────────────────
  if (needsVideoEditor) {
    steps.video_editor_briefed = {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'mediaBuyer',
      dependsOn: ['ad_scripts_approved', 'client_media_submitted'],
      note: 'Brief video editor with approved scripts + client media assets'
    }
    steps.ad_creatives_produced = {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'videoEditor',
      dependsOn: ['video_editor_briefed']
    }
    steps.meta_campaigns_built = {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'mediaBuyer',
      dependsOn: ['ad_creatives_produced', 'facebook_access_granted'],
      note: 'Build campaigns in Meta Ads Manager'
    }
  } else {
    steps.meta_campaigns_built = {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'mediaBuyer',
      dependsOn: ['ad_scripts_approved', 'client_media_submitted', 'facebook_access_granted'],
      note: 'Build campaigns in Meta Ads Manager (no video editor)'
    }
  }

  // ── Onboarding call ─────────────────────────────────────────────────────
  steps.onboarding_call_booked = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['ghl_subaccount_configured', 'meta_campaigns_built', 'onboarding_form_submitted', 'client_joined_discord'],
    note: 'Send booking link to client in their Discord channel. Bot sends message automatically when all deps are met.',
    readyToBookTrigger: true
  }
  steps.onboarding_call_completed = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['onboarding_call_booked'],
    checklist: ['calendar_connected', 'crm_access_granted', 'test_lead_run'],
    note: 'Mark done after the call. Checklist: calendar connected, CRM access granted, test lead run.'
  }

  // ── Launch ──────────────────────────────────────────────────────────────
  steps.campaigns_launched = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['onboarding_call_completed'],
    note: 'Account manager flips campaigns on in Meta Ads Manager'
  }
  steps['48hr_health_check'] = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['campaigns_launched'],
    timeGatedHours: 48,
    note: 'Verify leads are coming in and everything is running correctly. Not a performance review.'
  }
  steps.post_launch_checkin_scheduled = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['campaigns_launched'],
    note: '~2 week performance review'
  }

  return steps
}

// ── Write ─────────────────────────────────────────────────────────────────────

const data = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))

data.clients = data.clients.filter(c => c.id !== 'client_example')

const existingByEmail = data.clients.find(c => c.email === email)
if (existingByEmail) {
  if (existingByEmail.onboarding?.status === 'launched') {
    console.warn(`⚠️  A client with email ${email} already exists and has been launched. Aborting.`)
    process.exit(1)
  }
  console.log(`ℹ️  Email ${email} matched existing client ${existingByEmail.id} (${existingByEmail.name}) — already in onboarding. No new record needed.`)
  process.exit(0)
}

const client = {
  id,
  name,
  companyName: company,
  email,
  appointmentId,
  contractSignedDate: today,
  contractEndDate:    contractEnd || null,
  stripeCustomerId:   stripeId   || null,
  fathomSalesCallLink: fathomLink || null,
  needsVideoEditor,
  discordChannelId: null,
  onboarding: {
    status: 'onboarding',
    launchedDate:        null,
    campaignsLaunchedAt: null,
    readyToBookCallAt:   null,
    steps: makeSteps(needsVideoEditor),
    log: [{ timestamp: now, event: 'client_created', note: 'Signed. Created via new-client.mjs.' }]
  }
}

data.clients.push(client)
fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2))

// ── Auto-sync to sales_data ───────────────────────────────────────────────────

const synced = syncAllClients(CLIENTS_FILE, SALES_FILE)
let thisLink = synced.find(s => s.client.id === id)

// If appointmentId was passed explicitly, syncAllClients skips this client
// (because it already has an appointmentId). Stamp onboardingClientId on the
// appointment directly so both sides stay in sync.
if (!thisLink && appointmentId) {
  const rawSales = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'))
  const appointments = rawSales.appointments || rawSales
  const appt = appointments.find(a => a.id === appointmentId)
  if (appt && !appt.onboardingClientId) {
    appt.onboardingClientId = id
    const salesOut = Array.isArray(rawSales) ? appointments : { ...rawSales, appointments }
    fs.writeFileSync(SALES_FILE, JSON.stringify(salesOut, null, 2))
    thisLink = { appointment: appt, confidence: 'explicit' }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n✅ Client created: ${name} (${company})`)
console.log(`   ID:             ${id}`)
console.log(`   Email:          ${email}`)
console.log(`   Contract end:   ${contractEnd  || 'not set — add with --contract-end'}`)
console.log(`   Fathom call:    ${fathomLink   || 'not set — add with --fathom'}`)
console.log(`   Stripe ID:      ${stripeId     || 'not set — add with --stripe'}`)
console.log(`   Video editor:   ${needsVideoEditor ? 'yes' : 'no — pass --video-editor if needed'}`)
if (thisLink) {
  console.log(`   Appointment:    ${thisLink.appointment.contactName} (${thisLink.confidence} match) → ${thisLink.appointment.id}`)
} else {
  console.log(`   Appointment:    no closed deal matched — run sync-clients.mjs if needed`)
}
console.log(`\n📋 Unlocked immediately:`)
console.log(`   [Account Manager] Follow up — client needs to complete onboarding form + join Discord`)
console.log(`   [Media Buyer]     Write ad scripts once form is submitted`)
console.log(`\n💡 Tip: add Fathom link now if you have it — needed for AI script generation`)
console.log(`   node scripts/new-client.mjs ... --fathom "https://..."`)
