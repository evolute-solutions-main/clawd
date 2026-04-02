/**
 * Stripe Webhook Handler
 *
 * Handles inbound webhooks from Stripe.
 * Currently handles:
 *   - payment_intent.succeeded → mark payment_collected, create client record if needed
 *   - customer.created         → log new customer for cross-referencing
 *
 * Data written directly to Supabase (same DB as evolute-dashboard).
 */

import Stripe from 'stripe'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'url'
import { findUnclaimedAppointment } from '../../../lib/client-sync.mjs'
import {
  getClients, updateClient, upsertClient,
  upsertAlert, getAppointments, updateAppointment,
} from '../../_shared/db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = path.resolve(__dirname, '../../..')
const STATE_FILE = path.join(REPO_ROOT, 'state/catchup-state.json')

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

async function saveAlert(type, message, payload) {
  await upsertAlert({
    id:         `alert_${Date.now()}`,
    type,
    status:     'open',
    message,
    receivedAt: new Date().toISOString(),
    resolvedAt: null,
    payload
  })
  console.warn(`[stripe-webhook] Alert saved — type: ${type}`)
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
        await handleCustomerCreated(event.data.object)
        break
      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type} — ignoring`)
    }
    advanceStripeCheckpoint()
    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[stripe-webhook] Error handling event:', err)
    return res.status(500).json({ error: err.message })
  }
}

async function handlePaymentSucceeded(paymentIntent) {
  let email      = paymentIntent.receipt_email?.toLowerCase()?.trim()
  const amount   = paymentIntent.amount / 100
  const stripeId = paymentIntent.customer

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
      billingName = charge?.billing_details?.name?.trim() || null
    } catch (err) {
      console.warn('[stripe-webhook] Could not fetch charge billing_details:', err.message)
    }
  }

  console.log(`[stripe-webhook] Payment succeeded: $${amount} from ${email || 'unknown'}`)

  if (!email) {
    await saveAlert('payment_no_email',
      `Payment of $${amount} received but no email on the payment intent or charge. Stripe customer: ${stripeId || 'unknown'}`,
      { amount, stripeId }
    )
    return
  }

  const clients = await getClients()
  const client  = clients.find(c =>
    c.onboarding?.status === 'onboarding' &&
    c.email?.toLowerCase() === email
  )

  if (!client) {
    await autoCreateClientFromPayment({ email, amount, stripeId, billingName })
    return
  }

  // Attach Stripe customer ID if we don't have it yet
  if (!client.stripeCustomerId && stripeId) {
    await updateClient(client.id, { stripeCustomerId: stripeId })
    client.stripeCustomerId = stripeId
    console.log(`[stripe-webhook] Linked Stripe customer ${stripeId} to ${client.companyName}`)
  }

  // Mark payment collected
  if (client.onboarding.steps?.payment_collected?.status !== 'complete') {
    await markStepComplete(client, 'payment_collected', 'stripe_webhook')
    console.log(`[stripe-webhook] ✅ Marked payment_collected for ${client.companyName}`)
  }

  // Sync appointment
  await syncAppointmentForExistingClient(client, amount)
}

async function markStepComplete(client, stepKey, actor) {
  const onboarding = client.onboarding
  const step = onboarding.steps?.[stepKey]
  if (!step || step.status === 'complete') return

  const now   = new Date().toISOString()
  const today = now.split('T')[0]

  step.status      = 'complete'
  step.completedAt = today

  onboarding.log = onboarding.log || []
  onboarding.log.push({ timestamp: now, event: 'step_completed', step: stepKey, by: actor })

  if (stepKey === 'campaigns_launched') {
    onboarding.status             = 'launched'
    onboarding.launchedDate       = today
    onboarding.campaignsLaunchedAt = now
  }

  await updateClient(client.id, { onboarding })
}

async function syncAppointmentForExistingClient(client, amount) {
  const appointments = await getAppointments()

  if (!client.appointmentId) {
    const result = findUnclaimedAppointment(client, appointments)

    if (result) {
      const { appointment, confidence } = result

      if (confidence === 'email') {
        const updates = { onboardingClientId: client.id }

        if (appointment.status !== 'closed') {
          updates.status = 'closed'
          updates.closer = appointment.closer || 'Max'
          console.log(`[stripe-webhook] ✅ Auto-closed appointment ${appointment.id} for ${client.companyName}`)
        }

        if (!appointment.cashCollected) {
          updates.cashCollected = amount
        } else if (appointment.cashCollected !== amount) {
          await saveAlert('payment_amount_conflict',
            `**${client.companyName}** paid $${amount} via Stripe but the matched appointment (${appointment.contactName}, ${appointment.startTime?.slice(0,10)}) already has $${appointment.cashCollected} recorded. Please verify which is correct.`,
            { clientId: client.id, appointmentId: appointment.id, stripeAmount: amount, appointmentAmount: appointment.cashCollected }
          )
        }

        await updateAppointment(appointment.id, updates)
        await updateClient(client.id, { appointmentId: appointment.id })
        console.log(`[stripe-webhook] ✅ Linked appointment ${appointment.id} ↔ ${client.companyName} (email match)`)

      } else {
        await saveAlert('appointment_match_uncertain',
          `Stripe payment of $${amount} received for **${client.companyName}**.\nPossible appointment match (name only — not confirmed): **${appointment.contactName}** on ${appointment.startTime?.slice(0,10)}.\n\nIf correct, link it in the dashboard.`,
          { clientId: client.id, candidateAppointmentId: appointment.id, candidateName: appointment.contactName, amount, confidence: 'name' }
        )
      }
    }

  } else {
    const appt = appointments.find(a => a.id === client.appointmentId)
    if (appt) {
      if (!appt.cashCollected) {
        await updateAppointment(appt.id, { cashCollected: amount })
        console.log(`[stripe-webhook] ✅ Set cashCollected $${amount} on appointment for ${client.companyName}`)
      } else if (appt.cashCollected !== amount) {
        await saveAlert('payment_amount_conflict',
          `Stripe payment of $${amount} for **${client.companyName}** doesn't match the appointment's recorded cashCollected ($${appt.cashCollected}). Please verify which is correct.`,
          { clientId: client.id, appointmentId: appt.id, stripeAmount: amount, appointmentAmount: appt.cashCollected }
        )
      }
    }
  }
}

async function autoCreateClientFromPayment({ email, amount, stripeId, billingName = null }) {
  console.log(`[stripe-webhook] No existing client for ${email} — attempting auto-create`)

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

  if (!name && billingName) {
    name = billingName
    console.log(`[stripe-webhook] No Stripe customer name — using charge billing_details.name: ${name}`)
  }

  if (!name) {
    await saveAlert('payment_no_name',
      `Payment of $${amount} from \`${email}\` (Stripe: ${stripeId || 'unknown'}) — no customer name found, cannot auto-create. Please add manually.`,
      { amount, email, stripeId }
    )
    return
  }

  // Check for duplicate
  const existing = await getClients()
  const dupe = existing.find(c => c.email?.toLowerCase() === email)
  if (dupe) {
    if (dupe.onboarding?.status === 'launched') {
      console.warn(`[stripe-webhook] ⚠️ Client ${email} already exists and is launched — skipping auto-create`)
      return
    }
    console.log(`[stripe-webhook] Client ${email} already exists as ${dupe.companyName} — skipping auto-create`)
    return
  }

  const today = new Date().toISOString().split('T')[0]
  const now   = new Date().toISOString()
  const id    = 'client_' + (company || name).toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now()

  const newClient = {
    id,
    name,
    companyName:         company || name,
    email,
    appointmentId:       null,
    contractSignedDate:  today,
    contractEndDate:     null,
    stripeCustomerId:    stripeId || null,
    fathomSalesCallLink: null,
    discordChannelId:    null,
    clientStatus:        'onboarding',
    onboarding: {
      status:             'onboarding',
      launchedDate:       null,
      campaignsLaunchedAt: null,
      readyToBookCallAt:  null,
      steps:              makeOnboardingSteps(false),
      log: [{ timestamp: now, event: 'client_created', note: 'Auto-created via Stripe payment webhook.' }]
    }
  }

  // Mark payment_collected already done since the payment just came in
  newClient.onboarding.steps.payment_collected.status      = 'complete'
  newClient.onboarding.steps.payment_collected.completedAt = today

  try {
    await upsertClient(newClient)
    console.log(`[stripe-webhook] ✅ Auto-created client: ${name}`)
  } catch (err) {
    await saveAlert('payment_auto_create_failed',
      `Payment of $${amount} from \`${email}\` — tried to auto-create client "${name}" but failed: ${err.message}`,
      { amount, email, stripeId, name }
    )
    return
  }

  // Try to link to an appointment
  const appointments = await getAppointments()
  const result = findUnclaimedAppointment(newClient, appointments)
  let appointmentNote = 'No matching sales appointment found yet.'

  if (result) {
    const { appointment: appt, confidence } = result

    if (confidence === 'email') {
      const updates = {
        status:             'closed',
        closer:             appt.closer || 'Max',
        cashCollected:      appt.cashCollected || amount,
        onboardingClientId: id,
      }
      await updateAppointment(appt.id, updates)
      await updateClient(id, { appointmentId: appt.id })
      appointmentNote = `Auto-closed appointment (email match): ${appt.contactName} (${appt.startTime?.slice(0,10)}). cashCollected set to $${amount}. ✅`
      console.log(`[stripe-webhook] ✅ Auto-closed appointment ${appt.id} for ${name} (email match)`)
    } else {
      await saveAlert('appointment_match_uncertain',
        `New client **${name}** paid $${amount} via Stripe.\nPossible appointment match (name only — not confirmed): **${appt.contactName}** on ${appt.startTime?.slice(0,10)}.\n\nIf correct, mark their appointment closed in the dashboard.`,
        { amount, email, name, candidateAppointmentId: appt.id, candidateName: appt.contactName, confidence: 'name' }
      )
      appointmentNote = `Possible appointment match (name only): ${appt.contactName} (${appt.startTime?.slice(0,10)}) — confirm in the dashboard.`
    }
  }

  console.log(`[stripe-webhook] ✅ Auto-created client ${name} — ${appointmentNote}`)
}

async function handleCustomerCreated(customer) {
  const email    = customer.email?.toLowerCase()?.trim()
  const stripeId = customer.id
  const name     = customer.name

  console.log(`[stripe-webhook] New Stripe customer: ${name} (${email}) — ${stripeId}`)

  if (!email) return

  const clients = await getClients()
  const client  = clients.find(c =>
    c.onboarding?.status === 'onboarding' &&
    c.email?.toLowerCase() === email
  )

  if (client && !client.stripeCustomerId) {
    await updateClient(client.id, { stripeCustomerId: stripeId })
    console.log(`[stripe-webhook] Linked Stripe customer ${stripeId} to ${client.companyName}`)
  }
}

// Canonical onboarding step template (no video editor path by default for auto-create)
function makeOnboardingSteps(needsVideoEditor) {
  const steps = {
    payment_collected: {
      status: 'pending', completedAt: null,
      autoDetected: true, trigger: 'manual',
      note: 'Collected on closing call'
    },
    contract_signed: {
      status: 'complete', completedAt: new Date().toISOString().split('T')[0],
      autoDetected: false, trigger: 'manual'
    },
    welcome_email_sent: {
      status: 'complete', completedAt: new Date().toISOString().split('T')[0],
      autoDetected: true, trigger: 'auto'
    },
    added_to_daily_sweep: {
      status: 'complete', completedAt: new Date().toISOString().split('T')[0],
      autoDetected: true, trigger: 'auto'
    },
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
      autoDetected: false, owner: 'accountManager', priority: 1,
      dependsOn: ['client_joined_discord'],
      note: 'Create private Discord channel for client'
    },
    ghl_subaccount_configured: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'accountManager', priority: 2,
      dependsOn: ['onboarding_form_submitted'],
      note: 'Create GHL sub-account and configure settings'
    },
    facebook_access_granted: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'accountManager',
      dependsOn: ['onboarding_form_submitted'],
      note: 'Client grants access to Meta Business Manager'
    },
    client_media_submitted: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'accountManager',
      dependsOn: ['onboarding_form_submitted'],
      note: 'Client sends photos/videos via Discord or onboarding funnel'
    },
    ad_scripts_written: {
      status: 'pending', completedAt: null,
      autoDetected: false, owner: 'mediaBuyer',
      dependsOn: ['onboarding_form_submitted'],
      note: 'Media buyer writes ad scripts'
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
      note: 'Client reviews and approves. Mark done when final approval received.'
    },
  }

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

  steps.onboarding_call_booked = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['ghl_subaccount_configured', 'meta_campaigns_built', 'onboarding_form_submitted', 'client_joined_discord'],
    note: 'Send booking link to client in their Discord channel.',
    readyToBookTrigger: true
  }
  steps.onboarding_call_completed = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['onboarding_call_booked'],
    note: 'Mark done after the call.'
  }
  steps.campaigns_launched = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['onboarding_call_completed', 'facebook_access_granted'],
    note: 'Account manager flips campaigns on in Meta Ads Manager.'
  }
  steps['48hr_health_check'] = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['campaigns_launched'],
    timeGatedHours: 48,
    note: 'Verify leads are coming in and everything is running correctly.'
  }
  steps.post_launch_checkin_scheduled = {
    status: 'pending', completedAt: null,
    autoDetected: false, owner: 'accountManager',
    dependsOn: ['campaigns_launched'],
    note: '~2 week performance review'
  }

  return steps
}
