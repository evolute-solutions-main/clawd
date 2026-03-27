#!/usr/bin/env node
/**
 * Webhook Server — Evolute Solutions
 *
 * Receives inbound webhooks from GHL and Stripe.
 * Runs as a persistent service on the VM.
 *
 * Usage:
 *   node agents/webhooks/server.mjs
 *
 * Port: WEBHOOK_PORT in .secrets.env (default: 3001)
 *
 * Endpoints:
 *   POST /webhooks/ghl      — GoHighLevel events (form submissions)
 *   POST /webhooks/stripe   — Stripe events (payments, new customers)
 *   GET  /health            — health check
 *
 * To expose publicly on the VM:
 *   - nginx reverse proxy: proxy_pass http://localhost:3001
 *   - Or use Caddy for automatic HTTPS
 *   - Then point GHL + Stripe webhook URLs to https://your-domain/webhooks/ghl etc.
 *
 * To run as a service (on VM):
 *   pm2 start agents/webhooks/server.mjs --name webhook-server
 */

import '../_shared/env-loader.mjs'

import express    from 'express'
import { handleGHLWebhook }    from './handlers/ghl.mjs'
import { handleStripeWebhook } from './handlers/stripe.mjs'
import { runStartupCatchup }   from './startup-catchup.mjs'

const app  = express()
const PORT = process.env.WEBHOOK_PORT || 3001

// ── Middleware ────────────────────────────────────────────────────────────────

// For Stripe: we need the raw body to verify signatures
// Must come before express.json()
app.use((req, res, next) => {
  if (req.path === '/webhooks/stripe') {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      req.rawBody = raw
      try { req.body = JSON.parse(raw) } catch { req.body = {} }
      next()
    })
  } else {
    next()
  }
})

app.use(express.json())

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() })
})

app.post('/webhooks/ghl', (req, res) => {
  console.log(`[webhook-server] GHL event received`)
  handleGHLWebhook(req, res)
})

app.post('/webhooks/stripe', (req, res) => {
  console.log(`[webhook-server] Stripe event received`)
  handleStripeWebhook(req, res)
})

// Catch-all for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅ Webhook server running on port ${PORT}`)
  console.log(`   GHL endpoint:    POST http://localhost:${PORT}/webhooks/ghl`)
  console.log(`   Stripe endpoint: POST http://localhost:${PORT}/webhooks/stripe`)
  console.log(`   Health check:    GET  http://localhost:${PORT}/health`)
  console.log(`\n⚠️  Remember: this server needs to be publicly accessible for webhooks to reach it.`)
  console.log(`   On the VM, set up nginx or Caddy to proxy to this port.`)

  // Run global catch-up after server is accepting requests
  // Finds anything missed while the server was down (Stripe, GHL, Discord)
  runStartupCatchup().catch(err => {
    console.error('[startup-catchup] Uncaught error:', err.message)
  })
})

process.on('unhandledRejection', (err) => {
  console.error('[webhook-server] Unhandled rejection:', err)
})
