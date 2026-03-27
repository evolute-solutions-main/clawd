/**
 * startup-catchup.mjs — Global webhook catch-up on server startup
 *
 * The webhook server can go down (crash, redeploy, VM restart). Push-based
 * webhooks that fired while it was down may be lost forever once Stripe/GHL
 * stop retrying. This module runs once on every server start and proactively
 * reconciles state from each source so a restart never means missed data.
 *
 * Sources covered:
 *   1. Stripe  — replays payment_intent.succeeded events since last run
 *   2. GHL     — checks form submissions for all clients with pending onboarding_form_submitted
 *   3. Discord — reconciles guild members against clients with pending client_joined_discord
 *
 * State: state/catchup-state.json
 *   {
 *     "stripe":  { "lastCheckedAt": "<ISO>" },
 *     "ghl":     { "lastCheckedAt": "<ISO>" },
 *     "discord": { "lastCheckedAt": "<ISO>" }
 *   }
 *
 * Each source advances its own checkpoint independently.
 * Idempotent — handlers skip steps that are already complete.
 */

import Stripe from 'stripe'
import fs     from 'node:fs'
import path   from 'node:path'
import { fileURLToPath } from 'url'
import { processPaymentIntent }  from './handlers/stripe.mjs'
import { processFormSubmission } from './handlers/ghl.mjs'
import { postMessage }           from '../_shared/discord/index.mjs'
import { execFileSync }          from 'node:child_process'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = path.resolve(__dirname, '../..')
const STATE_FILE = path.join(REPO_ROOT, 'state/catchup-state.json')
const CLIENTS_FILE = path.join(REPO_ROOT, 'data/clients.json')

const DEFAULT_LOOKBACK_HOURS = 72
const OPS_CHANNEL_ID = process.env.DISCORD_OPS_CHANNEL_ID || '1475336170916544524'

// ── State helpers ─────────────────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function getSince(state, source) {
  const ts = state[source]?.lastCheckedAt
  return ts
    ? new Date(ts)
    : new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000)
}

// ── Source 1: Stripe ──────────────────────────────────────────────────────────

async function catchupStripe(state) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.log('[catchup:stripe] STRIPE_SECRET_KEY not set — skipping')
    return 0
  }

  const since    = getSince(state, 'stripe')
  const sinceStr = since.toISOString()
  const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY)

  console.log(`[catchup:stripe] Checking for missed payments since ${sinceStr}`)

  let processed = 0
  let startingAfter

  try {
    while (true) {
      const params = {
        limit:   100,
        created: { gte: Math.floor(since.getTime() / 1000) }
      }
      if (startingAfter) params.starting_after = startingAfter

      const page = await stripe.paymentIntents.list(params)
      const succeeded = page.data.filter(pi => pi.status === 'succeeded')

      for (const pi of succeeded) {
        try {
          await processPaymentIntent(pi)
          processed++
        } catch (err) {
          console.error(`[catchup:stripe] Error processing ${pi.id}:`, err.message)
        }
      }

      if (!page.has_more) break
      startingAfter = page.data.at(-1).id
    }
  } catch (err) {
    console.error('[catchup:stripe] Stripe API error:', err.message)
  }

  state.stripe = { lastCheckedAt: new Date().toISOString() }
  console.log(`[catchup:stripe] Done — ${processed} payment(s) processed`)
  return processed
}

// ── Source 2: GHL form submissions ────────────────────────────────────────────

async function catchupGHL(state) {
  const token    = process.env.GHL_PRIVATE_INTEGRATION_TOKEN
  const location = process.env.GHL_LOCATION_ID
  const formId   = process.env.GHL_ONBOARDING_FORM_ID || null  // optional — blank means query all

  if (!token || !location) {
    console.log('[catchup:ghl] GHL_PRIVATE_INTEGRATION_TOKEN or GHL_LOCATION_ID not set — skipping')
    return 0
  }

  const since = getSince(state, 'ghl')
  console.log(`[catchup:ghl] Checking form submissions since ${since.toISOString()}`)

  let processed = 0

  try {
    // Fetch recent form submissions from GHL
    const url = new URL('https://services.leadconnectorhq.com/forms/submissions')
    url.searchParams.set('locationId', location)
    if (formId) url.searchParams.set('formId', formId)  // omit to get all forms
    url.searchParams.set('limit', '100')

    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      }
    })

    if (!res.ok) {
      console.error(`[catchup:ghl] GHL API ${res.status}:`, await res.text())
      state.ghl = { lastCheckedAt: new Date().toISOString() }
      return 0
    }

    const data = await res.json()
    const submissions = data.submissions || []

    // Filter to those submitted after our last check
    const missed = submissions.filter(s => {
      const submittedAt = new Date(s.submittedAt || s.dateAdded || 0)
      return submittedAt > since
    })

    console.log(`[catchup:ghl] ${missed.length} form submission(s) since last check`)

    for (const sub of missed) {
      const email = (sub.data?.email || sub.email || '').toLowerCase().trim()
      const name  = sub.data?.full_name || sub.data?.name || sub.contactName || ''

      if (!email) continue

      try {
        await processFormSubmission({ email, name, formId, type: 'FormSubmitted' })
        processed++
      } catch (err) {
        console.error(`[catchup:ghl] Error processing submission from ${email}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[catchup:ghl] Error during GHL catchup:', err.message)
  }

  state.ghl = { lastCheckedAt: new Date().toISOString() }
  console.log(`[catchup:ghl] Done — ${processed} submission(s) processed`)
  return processed
}

// ── Source 3: Discord guild member reconciliation ─────────────────────────────

async function catchupDiscord(state) {
  const token   = process.env.DISCORD_CHAT_BOT_TOKEN
  const guildId = '1164939432722440282'

  if (!token) {
    console.log('[catchup:discord] DISCORD_CHAT_BOT_TOKEN not set — skipping')
    return 0
  }

  console.log('[catchup:discord] Reconciling Discord guild members against pending clients')

  let processed = 0

  try {
    // Find clients waiting for Discord join
    const clientsData = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
    const pending = clientsData.clients.filter(c =>
      c.onboarding?.status === 'onboarding' &&
      c.onboarding.steps?.client_joined_discord?.status !== 'complete'
    )

    if (pending.length === 0) {
      console.log('[catchup:discord] No clients with pending Discord join')
      state.discord = { lastCheckedAt: new Date().toISOString() }
      return 0
    }

    // Fetch all guild members (paginate if needed)
    let members = []
    let after = '0'

    while (true) {
      const res = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`,
        { headers: { 'Authorization': `Bot ${token}` } }
      )

      if (!res.ok) {
        console.error(`[catchup:discord] Discord API ${res.status}:`, await res.text())
        break
      }

      const page = await res.json()
      members = members.concat(page)
      if (page.length < 1000) break
      after = page.at(-1).user.id
    }

    console.log(`[catchup:discord] ${members.length} guild members, ${pending.length} client(s) pending join`)

    // For each pending client, check if they're already in the server
    for (const client of pending) {
      const firstName   = client.name.toLowerCase().split(' ')[0]
      const companyWord = client.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 6)

      const match = members.find(m => {
        const displayName = (m.nick || m.user.global_name || m.user.username || '').toLowerCase()
        const username    = (m.user.username || '').toLowerCase()
        return (
          displayName.includes(firstName) ||
          username.includes(firstName) ||
          username.includes(companyWord)
        )
      })

      if (!match) continue

      // Found them — mark the step and create their channel if missing
      console.log(`[catchup:discord] Found ${client.companyName} in guild as "${match.nick || match.user.username}" — marking joined`)

      try {
        execFileSync('node', [
          path.join(REPO_ROOT, 'scripts/mark-done.mjs'),
          '--client', client.companyName,
          '--step',   'client_joined_discord',
          '--by',     'discord_catchup'
        ], { encoding: 'utf8' })

        // Alert ops so they know this was auto-detected on catchup
        await postMessage(OPS_CHANNEL_ID,
          `🔄 **Discord catch-up** — ${client.companyName} was already in the server\nMarked \`client_joined_discord\` complete. Discord name: ${match.nick || match.user.username}\n\nNote: channel may still need to be created if the bot missed the join event.`
        )

        processed++
      } catch (err) {
        console.error(`[catchup:discord] Error marking ${client.companyName}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[catchup:discord] Error during Discord catchup:', err.message)
  }

  state.discord = { lastCheckedAt: new Date().toISOString() }
  console.log(`[catchup:discord] Done — ${processed} member(s) reconciled`)
  return processed
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runStartupCatchup() {
  console.log('\n[startup-catchup] Starting global catch-up...')

  const state = readState()

  // Run all three in parallel — each is independent and idempotent
  const [stripeCount, ghlCount, discordCount] = await Promise.allSettled([
    catchupStripe(state),
    catchupGHL(state),
    catchupDiscord(state)
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : 0))

  // Write state after all sources have updated their timestamps
  writeState(state)

  const total = stripeCount + ghlCount + discordCount
  if (total > 0) {
    console.log(`[startup-catchup] ✅ Catch-up complete — ${stripeCount} Stripe, ${ghlCount} GHL, ${discordCount} Discord events processed`)
    try {
      await postMessage(OPS_CHANNEL_ID,
        `🔄 **Webhook server restarted — catch-up complete**\nProcessed during downtime: ${stripeCount} Stripe payment(s), ${ghlCount} GHL form(s), ${discordCount} Discord join(s)`
      )
    } catch {}
  } else {
    console.log('[startup-catchup] ✅ Catch-up complete — nothing missed')
  }
}
