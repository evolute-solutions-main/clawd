/**
 * Stripe Webhook Handler
 *
 * Handles inbound webhooks from Stripe.
 * Currently handles:
 *   - payment_intent.succeeded → mark payment_collected, create client record if needed
 *   - customer.created         → log new customer for cross-referencing
 *
 * Set up in Stripe: Developers → Webhooks → Add endpoint
 * URL: https://[your-server]/webhooks/stripe
 * Events: payment_intent.succeeded, customer.created
 *
 * Add STRIPE_WEBHOOK_SECRET to .secrets.env (from Stripe webhook dashboard)
 * Add STRIPE_SECRET_KEY to .secrets.env
 */

import Stripe from 'stripe'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import { postMessage } from '../../_shared/discord/index.mjs'
import { findAppointmentMatch, findUnclaimedAppointment } from '../../../lib/client-sync.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT    = path.resolve(__dirname, '../../..')
const CLIENTS_FILE = path.join(REPO_ROOT, 'data/clients.json')
const SALES_FILE   = path.join(REPO_ROOT, 'data/sales_data.json')
const ALERTS_FILE  = path.join(REPO_ROOT, 'data/alerts.json')
const STATE_FILE   = path.join(REPO_ROOT, 'state/catchup-state.json')

function advanceStripeCheckpoint() {
  try {
    let state = {}
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch {}
    state.stripe = { lastCheckedAt: new Date().toISOString() }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (err) {
    console.warn('[stripe-webhook] Could not advance catchup checkpoint:', err.message)
  }
}

const OPS_CHANNEL_ID = process.env.DISCORD_OPS_CHANNEL_ID || '1475336170916544524'

function saveAlert(type, message, payload) {
  const data = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'))
  data.alerts.push({
    id:         `alert_${Date.now()}`,
    type,
    status:     'pending',
    message,
    receivedAt: new Date().toISOString(),
    resolvedAt: null,
    payload
  })
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2))
  console.warn(`[stripe-webhook] Alert saved — type: ${type}`)
}

async function alertOps(message) {
  try {
    await postMessage(OPS_CHANNEL_ID, `⚠️ **Stripe Payment — needs manual review**\n${message}`)
  } catch (err) {
    console.error('[stripe-webhook] Failed to post Discord alert:', err.message)
  }
}

// Lazy init — Stripe key may not be set yet
let _stripe = null
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set in .secrets.env')
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  }
  return _stripe
}

// Exported for startup-catchup.mjs — process a payment intent directly without HTTP context
export async function processPaymentIntent(paymentIntent) {
  await handlePaymentSucceeded(paymentIntent)
}

export async function handleStripeWebhook(req, res) {
  const sig     = req.headers['stripe-signature']
  const secret  = process.env.STRIPE_WEBHOOK_SECRET

  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — cannot verify signature')
    return res.status(500).json({ error: 'Webhook secret not configured' })
  }

  let event
  try {
    // req.rawBody is set by the server for Stripe signature verification
    event = getStripe().webhooks.constructEvent(req.rawBody, sig, secret)
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err.message)
    return res.status(400).json({ error: `Webhook signature invalid: ${err.message}` })
  }

  console.log(`[stripe-webhook] Received: ${event.type}`)

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(event.data.object)
        break
      case 'customer.created':
        handleCustomerCreated(event.data.object)
        break
      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type} — ignoring`)
    }
    // Advance catch-up checkpoint so next restart knows we were alive at this moment
    advanceStripeCheckpoint()
    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[stripe-webhook] Error handling event:', err)
    return res.status(500).json({ error: err.message })
  }
}

async function handlePaymentSucceeded(paymentIntent) {
  let email      = paymentIntent.receipt_email?.toLowerCase()?.trim()
  const amount   = paymentIntent.amount / 100  // Stripe amounts are in cents
  const stripeId = paymentIntent.customer

  // Fallback: receipt_email is often null for manual/terminal payments.
  // Always fetch the charge to get billing_details (email + name) as a fallback.
  let billingName = null
  if (!email || !stripeId) {
    try {
      const charges = await getStripe().charges.list({ payment_intent: paymentIntent.id, limit: 1 })
      const charge  = charges.data[0]
      if (!email) {
        const billingEmail = charge?.billing_details?.email?.toLowerCase()?.trim()
        if (billingEmail) {
          email = billingEmail
          console.log(`[stripe-webhook] receipt_email was null — using charge billing_details.email: ${email}`)
        }
      }
      // Always capture billing name as a fallback for auto-create
      billingName = charge?.billing_details?.name?.trim() || null
    } catch (err) {
      console.warn('[stripe-webhook] Could not fetch charge billing_details:', err.message)
    }
  }

  console.log(`[stripe-webhook] Payment succeeded: $${amount} from ${email || 'unknown'}`)

  if (!email) {
    const msg = `Payment of $${amount} received but no email on the payment intent or charge. Stripe customer: ${stripeId || 'unknown'}`
    saveAlert('payment_no_email', msg, { amount, stripeId })
    await alertOps(`${msg}\n\nResolve: link manually via \`mark-done.mjs\` once you identify the client.`)
    return
  }

  const data   = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
  const client = data.clients.find(c =>
    c.onboarding?.status === 'onboarding' &&
    c.email?.toLowerCase() === email
  )

  if (!client) {
    await autoCreateClientFromPayment({ email, amount, stripeId, billingName })
    return
  }

  // Attach Stripe customer ID if we don't have it yet
  if (!client.stripeCustomerId && stripeId) {
    client.stripeCustomerId = stripeId
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2))
    console.log(`[stripe-webhook] Linked Stripe customer ${stripeId} to ${client.companyName}`)
  }

  // Mark payment collected
  if (client.onboarding.steps.payment_collected?.status !== 'complete') {
    execFileSync('node', [
      path.join(REPO_ROOT, 'scripts/mark-done.mjs'),
      '--client', client.companyName,
      '--step',   'payment_collected',
      '--by',     'stripe_webhook'
    ], { encoding: 'utf8' })
    console.log(`[stripe-webhook] ✅ Marked payment_collected for ${client.companyName}`)
  }
}

/**
 * Auto-create a new client record from an unmatched Stripe payment.
 * Matches to a closed appointment if possible, stamps cashCollected,
 * and posts to Discord asking for contract revenue.
 */
async function autoCreateClientFromPayment({ email, amount, stripeId, billingName = null }) {
  console.log(`[stripe-webhook] No existing client for ${email} — attempting auto-create`)

  // Fetch customer name from Stripe customer record, then fall back to charge billing_details.name
  let name = null
  let company = null
  if (stripeId) {
    try {
      const customer = await getStripe().customers.retrieve(stripeId)
      name    = customer.name?.trim() || null
      company = customer.description?.trim() || null
    } catch (err) {
      console.warn(`[stripe-webhook] Could not fetch Stripe customer ${stripeId}:`, err.message)
    }
  }

  // Fall back to charge billing_details.name (available for manual/terminal payments)
  if (!name && billingName) {
    name = billingName
    console.log(`[stripe-webhook] No Stripe customer name — using charge billing_details.name: ${name}`)
  }

  if (!name) {
    // Still no name — save alert for manual review
    const msg = `Payment of $${amount} from \`${email}\` (Stripe: ${stripeId || 'unknown'}) — no customer name available anywhere, cannot auto-create. Please add manually.`
    saveAlert('payment_no_name', msg, { amount, email, stripeId })
    await alertOps(msg)
    return
  }

  const today = new Date().toISOString().split('T')[0]

  // Create the client via new-client.mjs
  try {
    const newClientArgs = [
      path.join(REPO_ROOT, 'scripts/new-client.mjs'),
      '--name',   name,
      '--email',  email,
      '--signed', today,
    ]
    if (company) newClientArgs.push('--company', company)
    if (stripeId) newClientArgs.push('--stripe', stripeId)

    execFileSync('node', newClientArgs, { encoding: 'utf8' })
    console.log(`[stripe-webhook] ✅ Auto-created client: ${name}`)
  } catch (err) {
    const msg = `Payment of $${amount} from \`${email}\` — tried to auto-create client "${name}" but failed: ${err.message}`
    saveAlert('payment_auto_create_failed', msg, { amount, email, stripeId, name })
    await alertOps(msg)
    return
  }

  // Re-read to get the newly created client
  const data = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
  const newClient = data.clients.find(c => c.email?.toLowerCase() === email)

  // Try to stamp cashCollected on matched appointment
  let appointmentNote = 'No matching sales appointment found yet — will link when synced.'

  if (newClient?.appointmentId) {
    // Client was already linked to a closed appointment by syncAllClients
    try {
      const salesData = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'))
      const appointments = salesData.appointments || salesData
      const appt = appointments.find(a => a.id === newClient.appointmentId)
      if (appt) {
        if (!appt.cashCollected) {
          appt.cashCollected = amount
          fs.writeFileSync(SALES_FILE, JSON.stringify(salesData, null, 2))
          appointmentNote = `Matched to closed appointment: ${appt.contactName} (${appt.startTime?.slice(0,10)}). cashCollected set to $${amount}.`
        } else {
          appointmentNote = `Matched to closed appointment: ${appt.contactName}. cashCollected already set ($${appt.cashCollected}) — not overwritten.`
        }
      }
    } catch (err) {
      console.warn('[stripe-webhook] Could not update appointment cashCollected:', err.message)
    }
  } else {
    // No closed appointment found — search all appointments regardless of status
    // (payment may have arrived before the deal was marked closed in our system)
    try {
      const salesData = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'))
      const appointments = salesData.appointments || salesData
      const result = findUnclaimedAppointment(newClient, appointments)

      if (result) {
        const { appointment: appt, confidence } = result

        if (confidence === 'email') {
          // 100% sure — auto-close the appointment and link
          appt.status               = 'closed'
          appt.closer               = appt.closer || 'Max'
          appt.cashCollected        = appt.cashCollected || amount
          appt.onboardingClientId   = newClient.id
          newClient.appointmentId   = appt.id

          fs.writeFileSync(SALES_FILE, JSON.stringify(salesData, null, 2))
          fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2))

          appointmentNote = `Auto-closed appointment (email match): ${appt.contactName} (${appt.startTime?.slice(0,10)}). cashCollected set to $${amount}. ✅`
          console.log(`[stripe-webhook] ✅ Auto-closed appointment ${appt.id} for ${name} (email match)`)
        } else {
          // Name match only — not confident enough to auto-close; ask Max
          const msg = `New client **${name}** paid $${amount} via Stripe.\nFound a possible appointment match (name only — not confirmed): **${appt.contactName}** on ${appt.startTime?.slice(0,10)}.\n\n**Is this the same person?**\nIf yes, mark their appointment closed in the dashboard and it will link automatically.`
          saveAlert('appointment_match_uncertain', msg, {
            amount, email, name,
            candidateAppointmentId: appt.id,
            candidateName: appt.contactName,
            confidence: 'name'
          })
          await alertOps(msg)
          appointmentNote = `Possible appointment match (name only): ${appt.contactName} (${appt.startTime?.slice(0,10)}) — **needs your confirmation before closing.** Check Discord.`
        }
      }
    } catch (err) {
      console.warn('[stripe-webhook] Could not search for unclaimed appointment:', err.message)
    }
  }

  await postMessage(
    process.env.DISCORD_OPS_CHANNEL_ID || '1475336170916544524',
    `✅ **New client auto-created from Stripe payment**\n**${name}** — $${amount} via Stripe\nEmail: \`${email}\`\n${appointmentNote}\n\n⚠️ Contract revenue not set — please update in the dashboard.`
  )
}

function handleCustomerCreated(customer) {
  const email    = customer.email?.toLowerCase()?.trim()
  const stripeId = customer.id
  const name     = customer.name

  console.log(`[stripe-webhook] New Stripe customer: ${name} (${email}) — ${stripeId}`)

  if (!email) return

  // Attach Stripe ID to matching onboarding client if found
  const data   = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
  const client = data.clients.find(c =>
    c.onboarding?.status === 'onboarding' &&
    c.email?.toLowerCase() === email
  )

  if (client && !client.stripeCustomerId) {
    client.stripeCustomerId = stripeId
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(data, null, 2))
    console.log(`[stripe-webhook] Linked Stripe customer ${stripeId} to ${client.companyName}`)
  }
}
