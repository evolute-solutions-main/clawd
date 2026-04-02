/**
 * GHL Webhook Handler
 *
 * Handles inbound webhooks from GoHighLevel.
 * Currently handles: form submissions (onboarding form completed)
 *
 * Data written directly to Supabase (same DB as evolute-dashboard).
 */

import { getClients, updateClient, upsertAlert } from '../../_shared/db.mjs'

// The form ID of the onboarding form in GHL
// Set GHL_ONBOARDING_FORM_ID in .secrets.env once you have it
const ONBOARDING_FORM_ID = process.env.GHL_ONBOARDING_FORM_ID || null

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
  console.warn(`[ghl-webhook] Alert saved — type: ${type}`)
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
    const isFormSubmission = (
      type === 'FormSubmitted' ||
      type === 'form_submitted' ||
      (!type && (payload.email || payload.Email))
    )

    if (isFormSubmission) {
      await handleFormSubmitted(payload)
      return res.status(200).json({ ok: true })
    }

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

  if (ONBOARDING_FORM_ID && formId && formId !== ONBOARDING_FORM_ID) {
    console.log(`[ghl-webhook] Form ${formId} is not the onboarding form — ignoring`)
    return
  }

  if (!email) {
    await saveAlert('form_no_email', `Form submitted with no email. Name: ${name} | Form ID: ${formId || 'unknown'}`, payload)
    return
  }

  const clients = await getClients()
  const client  = clients.find(c =>
    c.onboarding?.status === 'onboarding' &&
    c.email?.toLowerCase() === email
  )

  if (!client) {
    await saveAlert('form_no_client_match',
      `Onboarding form submitted but no client matched email \`${email}\`. Name on form: ${name}. Possible causes: email mismatch, client not yet added, or wrong email used.`,
      payload
    )
    return
  }

  if (client.onboarding.steps?.onboarding_form_submitted?.status === 'complete') {
    console.log(`[ghl-webhook] Onboarding form already marked complete for ${client.companyName} — skipping`)
    return
  }

  // Mark step done directly in Supabase
  const onboarding = client.onboarding
  const step = onboarding.steps?.onboarding_form_submitted
  if (step) {
    const now   = new Date().toISOString()
    const today = now.split('T')[0]

    step.status      = 'complete'
    step.completedAt = today

    onboarding.log = onboarding.log || []
    onboarding.log.push({ timestamp: now, event: 'step_completed', step: 'onboarding_form_submitted', by: 'ghl_webhook' })

    await updateClient(client.id, { onboarding })
    console.log(`[ghl-webhook] ✅ Marked onboarding_form_submitted for ${client.companyName}`)
  }
}
