/**
 * GHL Webhook Handler
 *
 * Handles inbound webhooks from GoHighLevel.
 * Currently handles: form submissions (onboarding form completed)
 *
 * GHL webhook payload for form submission:
 * {
 *   type: "FormSubmitted",
 *   locationId: "Fv38qyVITGwToy2uDZgc",
 *   contactId: "abc123",
 *   formId: "xxx",
 *   email: "client@example.com",
 *   name: "John Smith",
 *   phone: "...",
 *   customData: { ... }  // form fields
 * }
 *
 * Set up in GHL: Settings → Integrations → Webhooks → Add Webhook
 * URL: https://[your-server]/webhooks/ghl
 * Events: Form Submitted
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import { postMessage } from '../../_shared/discord/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = path.resolve(__dirname, '../../..')
const CLIENTS_FILE = path.join(REPO_ROOT, 'data/clients.json')
const ALERTS_FILE  = path.join(REPO_ROOT, 'data/alerts.json')

// The form ID of the onboarding form in GHL
// Set GHL_ONBOARDING_FORM_ID in .secrets.env once you have it
const ONBOARDING_FORM_ID = process.env.GHL_ONBOARDING_FORM_ID || null
const OPS_CHANNEL_ID     = process.env.DISCORD_OPS_CHANNEL_ID || '1475336170916544524'

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
  console.warn(`[ghl-webhook] Alert saved — type: ${type}`)
}

async function alertOps(message) {
  try {
    await postMessage(OPS_CHANNEL_ID, `⚠️ **GHL Onboarding Form — needs manual review**\n${message}`)
  } catch (err) {
    console.error('[ghl-webhook] Failed to post Discord alert:', err.message)
  }
}

// Exported for startup-catchup.mjs — process a form submission directly without HTTP context
export async function processFormSubmission(payload) {
  await handleFormSubmitted(payload)
}

export async function handleGHLWebhook(req, res) {
  const payload = req.body
  const type    = payload?.type || payload?.event_type

  console.log(`[ghl-webhook] Received full payload:`, JSON.stringify(payload, null, 2))

  try {
    // GHL native webhooks send { type: "FormSubmitted", email, ... }
    // GHL automation webhooks send flat contact+form fields with no type field
    const isFormSubmission = (
      type === 'FormSubmitted' ||
      type === 'form_submitted' ||
      (!type && (payload.email || payload.Email))  // automation format
    )

    if (isFormSubmission) {
      await handleFormSubmitted(payload)
      return res.status(200).json({ ok: true })
    }

    // Unhandled event type — log and ack
    console.log(`[ghl-webhook] Unhandled event type: ${type} — ignoring`)
    return res.status(200).json({ ok: true, ignored: true })

  } catch (err) {
    console.error('[ghl-webhook] Error handling webhook:', err)
    return res.status(500).json({ error: err.message })
  }
}

async function handleFormSubmitted(payload) {
  const email  = (payload.email || payload.Email || payload.contact_email || '').toLowerCase().trim()
  const name   = payload.name || payload.full_name || payload.Name || '(no name)'
  const formId = payload.formId || payload.form_id

  // If a specific form ID is configured, only process that form
  // (silent ignore — other GHL forms shouldn't trigger onboarding)
  if (ONBOARDING_FORM_ID && formId && formId !== ONBOARDING_FORM_ID) {
    console.log(`[ghl-webhook] Form ${formId} is not the onboarding form — ignoring`)
    return
  }

  if (!email) {
    const msg = `Form submitted with no email. Name: ${name} | Form ID: ${formId || 'unknown'}`
    saveAlert('form_no_email', msg, payload)
    await alertOps(`${msg}\n\nResolve: add client with \`new-client.mjs\` then run \`mark-done.mjs\` manually.`)
    return
  }

  // Find matching onboarding client by email
  const data   = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))
  const client = data.clients.find(c =>
    c.onboarding?.status === 'onboarding' &&
    c.email?.toLowerCase() === email
  )

  if (!client) {
    const msg = `Form submitted but no onboarding client matched email \`${email}\`. Name on form: ${name}`
    saveAlert('form_no_client_match', msg, payload)
    await alertOps(`${msg}\n\nPossible causes: email mismatch, client not yet added, or wrong email used.\nResolve with: \`node scripts/mark-done.mjs --client "Company Name" --step onboarding_form_submitted\``)
    return
  }

  if (client.onboarding.steps.onboarding_form_submitted?.status === 'complete') {
    console.log(`[ghl-webhook] Onboarding form already marked complete for ${client.companyName} — skipping`)
    return
  }

  // Mark step done
  const result = execFileSync('node', [
    path.join(REPO_ROOT, 'scripts/mark-done.mjs'),
    '--client', client.companyName,
    '--step',   'onboarding_form_submitted',
    '--by',     'ghl_webhook'
  ], { encoding: 'utf8' })

  console.log(`[ghl-webhook] ✅ Marked onboarding_form_submitted for ${client.companyName}`)
  console.log(result)
}
