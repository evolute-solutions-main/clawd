#!/usr/bin/env node
/**
 * Onboarding Agent — Daily Briefing
 *
 * Reads all active onboarding clients, walks the dependency graph,
 * and outputs a per-role action list. No one has to think about
 * what's next — this tells them.
 *
 * Usage:
 *   node agents/onboarding/scripts/run.mjs
 *   node agents/onboarding/scripts/run.mjs --client "Smith Roofing"   (single client)
 *   node agents/onboarding/scripts/run.mjs --dry-run                  (console only, no Discord)
 *
 * Output: console + agents/onboarding/outputs/YYYY-MM-DD/briefing.md
 * Discord posting: handled by cron-runner.mjs (pipes stdout to Discord)
 */

import '../../_shared/env-loader.mjs'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import { getGlobalTimezone } from '../../_shared/formatters/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = path.resolve(__dirname, '../../..')
const CLIENTS_FILE = path.join(REPO_ROOT, 'data/clients.json')
const ALERTS_FILE  = path.join(REPO_ROOT, 'data/alerts.json')
const TEAM_FILE    = path.join(REPO_ROOT, 'data/team.json')
const OUTPUTS_DIR     = path.join(__dirname, '../outputs')

const args       = process.argv.slice(2)
const filterName = args.includes('--client') ? args[args.indexOf('--client') + 1]?.toLowerCase() : null
const dryRun     = args.includes('--dry-run')
const TZ         = getGlobalTimezone(REPO_ROOT)
const now        = new Date()
const today      = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

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

// ── Dependency + time-gate evaluator ─────────────────────────────────────────

function evaluateSteps(steps, onboarding) {
  const results = { unlocked: [], queued: [], blocked: [], complete: [], waiting_auto: [] }

  for (const [key, step] of Object.entries(steps)) {
    if (step.status === 'complete') {
      results.complete.push(key)
      continue
    }

    const deps = step.dependsOn || []
    const depsComplete = deps.every(d => steps[d]?.status === 'complete')

    if (!depsComplete) {
      const pendingDeps = deps.filter(d => steps[d]?.status !== 'complete')
      // Truly blocked = waiting on an external/auto-detected step (webhook, client action)
      // Queued = all pending deps are manual — someone just needs to do them first
      const hasExternalDep = pendingDeps.some(d => steps[d]?.autoDetected === true)
      if (hasExternalDep) {
        results.blocked.push({ key, pendingDeps })
      } else {
        results.queued.push({ key, pendingDeps })
      }
      continue
    }

    // Time-gated steps: check if enough time has passed
    if (step.timeGatedHours && onboarding.campaignsLaunchedAt) {
      const launchedAt  = new Date(onboarding.campaignsLaunchedAt)
      const gatePassesAt = new Date(launchedAt.getTime() + step.timeGatedHours * 60 * 60 * 1000)
      if (now < gatePassesAt) {
        const hoursLeft = Math.ceil((gatePassesAt - now) / (60 * 60 * 1000))
        results.blocked.push({ key, pendingDeps: [], timeGated: true, hoursLeft })
        continue
      }
    }

    if (step.autoDetected) {
      results.waiting_auto.push(key)
    } else {
      results.unlocked.push({ key, owner: step.owner, note: step.note })
    }
  }

  return results
}

// ── Phase label ───────────────────────────────────────────────────────────────

function getPhase(steps) {
  const s = steps
  if (s['48hr_health_check']?.status === 'complete')    return 'LAUNCHED'
  if (s.campaigns_launched?.status === 'complete')      return 'POST-LAUNCH CHECK'
  if (s.onboarding_call_completed?.status === 'complete') return 'LAUNCHING'
  if (s.onboarding_call_booked?.status === 'complete')  return 'ONBOARDING CALL SCHEDULED'
  if (s.meta_campaigns_built?.status === 'complete')    return 'READY TO BOOK'
  if (s.ad_scripts_approved?.status === 'complete')     return 'CAMPAIGNS BUILD'
  if (s.ad_scripts_written?.status === 'complete')      return 'SCRIPTS REVIEW'
  if (s.onboarding_form_submitted?.status === 'complete') return 'PRODUCTION'
  if (s.contract_signed?.status === 'complete')         return 'AWAITING CLIENT FUNNEL'
  return 'NEW'
}

// ── Main ──────────────────────────────────────────────────────────────────────

const clientData = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
const alertData  = JSON.parse(fs.readFileSync(ALERTS_FILE,  'utf8'))
const team       = JSON.parse(fs.readFileSync(TEAM_FILE,    'utf8'))

const ROLE_LABELS = {
  accountManager: 'Account Manager',
  mediaBuyer:     'Media Buyer',
  videoEditor:    'Video Editor'
}
function resolveRole(roleKey) {
  const person = team.roles?.[roleKey]
  const label  = ROLE_LABELS[roleKey] || roleKey
  return person ? `${person} (${label})` : label
}

const pendingAlerts = (alertData.alerts || []).filter(a => a.status === 'pending')

let clients = clientData.clients.filter(c =>
  c.onboarding?.status === 'onboarding' ||
  (c.onboarding?.status === 'launched' && c.onboarding.steps?.post_launch_checkin_scheduled?.status !== 'complete')
)
if (filterName) clients = clients.filter(c => c.companyName.toLowerCase().includes(filterName))

if (clients.length === 0 && pendingAlerts.length === 0) {
  console.log('No active onboarding clients and no pending alerts.')
  process.exit(0)
}

const roleActions = {
  accountManager: [],
  mediaBuyer:     [],
  videoEditor:    [],
  auto:           []
}

const clientSummaries = []

for (const client of clients) {
  const eval_  = evaluateSteps(client.onboarding.steps, client.onboarding)
  const phase   = getPhase(client.onboarding.steps)

  // Flag ready-to-book clients that haven't been notified yet
  const isReadyToBook = client.onboarding.readyToBookCallAt &&
    client.onboarding.steps?.onboarding_call_booked?.status !== 'complete'

  for (const item of eval_.unlocked) {
    const bucket = roleActions[item.owner] || roleActions.accountManager
    bucket.push({ client: client.companyName, step: item.key, label: STEP_LABELS[item.key] || item.key, note: item.note })
  }

  for (const key of eval_.waiting_auto) {
    roleActions.auto.push({ client: client.companyName, step: key, label: STEP_LABELS[key] || key })
  }

  const blockedSummary = eval_.blocked.map(b => ({
    step:      STEP_LABELS[b.key] || b.key,
    timeGated: b.timeGated || false,
    hoursLeft: b.hoursLeft || null,
    waitingOn: (b.pendingDeps || []).map(d => STEP_LABELS[d] || d)
  }))

  clientSummaries.push({
    name:        client.companyName,
    phase,
    isReadyToBook,
    unlocked:    eval_.unlocked.length,
    queued:      eval_.queued.length,
    blocked:     blockedSummary,
    complete:    eval_.complete.length,
    total:       Object.keys(client.onboarding.steps).length
  })
}

// ── Format output ─────────────────────────────────────────────────────────────

const lines = []

lines.push(`# Onboarding Briefing — ${today}`)
lines.push(`${clients.length} client(s) in onboarding\n`)

if (pendingAlerts.length > 0) {
  lines.push(`## ⚠️ Needs Manual Review (${pendingAlerts.length})`)
  for (const a of pendingAlerts) {
    lines.push(`- [${a.id}] ${a.message}`)
  }
  lines.push(`\nResolve alerts with: node scripts/resolve-alert.mjs --id <alert_id>\n`)
}

lines.push(`## Client Status`)
for (const c of clientSummaries) {
  lines.push(`\n### ${c.name}`)
  lines.push(`Phase: ${c.phase} | ${c.complete}/${c.total} steps complete`)
  if (c.isReadyToBook) lines.push(`🚀 READY TO BOOK — send booking link to client in Discord`)
  if (c.unlocked > 0)  lines.push(`${c.unlocked} step(s) ready to action`)
  if (c.queued > 0)    lines.push(`${c.queued} step(s) queued behind current actions`)
  if (c.blocked.length > 0) {
    lines.push(`Blocked (waiting on external):`)
    for (const b of c.blocked) {
      if (b.timeGated) {
        lines.push(`  - "${b.step}" → time-gated, available in ~${b.hoursLeft}h`)
      } else {
        lines.push(`  - "${b.step}" → waiting on: ${b.waitingOn.join(', ')}`)
      }
    }
  }
}

lines.push(`\n---\n`)
lines.push(`## Action List — ${resolveRole('accountManager')}`)
if (roleActions.accountManager.length === 0) {
  lines.push(`Nothing to action right now.`)
} else {
  for (const a of roleActions.accountManager) {
    lines.push(`- [ ] [${a.client}] ${a.label}${a.note ? `\n      → ${a.note}` : ''}`)
  }
}

lines.push(`\n## Action List — ${resolveRole('mediaBuyer')}`)
if (roleActions.mediaBuyer.length === 0) {
  lines.push(`Nothing to action right now.`)
} else {
  for (const a of roleActions.mediaBuyer) {
    lines.push(`- [ ] [${a.client}] ${a.label}${a.note ? `\n      → ${a.note}` : ''}`)
  }
}

lines.push(`\n## Action List — ${resolveRole('videoEditor')}`)
if (roleActions.videoEditor.length === 0) {
  lines.push(`Nothing to action right now.`)
} else {
  for (const a of roleActions.videoEditor) {
    lines.push(`- [ ] [${a.client}] ${a.label}${a.note ? `\n      → ${a.note}` : ''}`)
  }
}

if (roleActions.auto.length > 0) {
  lines.push(`\n## Waiting on Automation`)
  lines.push(`These steps are unlocked but waiting on a webhook/event:`)
  for (const a of roleActions.auto) {
    lines.push(`- [${a.client}] ${a.label}`)
  }
}

const output = lines.join('\n')

// ── Write output ──────────────────────────────────────────────────────────────

console.log(output)

if (!dryRun) {
  const outDir = path.join(OUTPUTS_DIR, today)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'briefing.md'), output)
  console.log(`\n✅ Written to agents/onboarding/outputs/${today}/briefing.md`)
}

// Discord posting is handled by cron-runner.mjs which pipes this output
