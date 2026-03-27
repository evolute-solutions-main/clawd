#!/usr/bin/env node
/**
 * serve.mjs — Local dashboard server
 *
 * Serves the dashboard on http://localhost:3847 and accepts API requests
 * from the browser to update data files.
 *
 * Usage:
 *   node scripts/serve.mjs          (inject data + start server)
 *   node scripts/serve.mjs --no-open (skip opening browser)
 */

import fs          from 'fs'
import http        from 'http'
import path        from 'path'
import crypto      from 'crypto'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { syncAllClients } from '../lib/client-sync.mjs'

const root         = path.resolve(fileURLToPath(import.meta.url), '../../')
const dataDir      = path.join(root, 'data')
const CLIENTS_FILE = path.join(dataDir, 'clients.json')
const SALES_FILE   = path.join(dataDir, 'sales_data.json')
const htmlFile     = path.join(root, 'dashboard.html')
const PORT      = 3847
const noOpen    = process.argv.includes('--no-open')

// ── Auth ──────────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'banana'
const COOKIE_SECRET      = 'ev-dash-2026'
const SESSION_COOKIE     = 'ev_dash_session'

function makeToken() {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(DASHBOARD_PASSWORD).digest('hex')
}

function isAuthed(req) {
  const cookieHeader = req.headers.cookie || ''
  const cookies = Object.fromEntries(
    cookieHeader.split(';')
      .map(c => c.trim().split('='))
      .filter(p => p.length === 2)
      .map(([k, v]) => [k.trim(), decodeURIComponent(v.trim())])
  )
  return cookies[SESSION_COOKIE] === makeToken()
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Evolute Dashboard</title>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#080a12; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; }
.box { background:#0e1018; border:1px solid #1a1d2e; border-radius:14px; padding:40px; width:320px; }
h1 { font-size:1rem; font-weight:700; margin-bottom:4px; }
p { font-size:0.75rem; color:#4a5568; margin-bottom:28px; }
input { background:#080a12; border:1px solid #232640; color:#e2e8f0; padding:11px 14px; border-radius:8px; width:100%; font-size:0.9rem; margin-bottom:12px; outline:none; }
input:focus { border-color:#818cf8; }
input::placeholder { color:#4a5568; }
button { background:#818cf8; border:none; color:#fff; padding:11px; border-radius:8px; width:100%; font-size:0.9rem; font-weight:600; cursor:pointer; }
button:hover { opacity:.9; }
.err { color:#f87171; font-size:0.78rem; margin-bottom:12px; __DISPLAY__ }
</style>
</head>
<body>
<div class="box">
  <h1>Evolute Dashboard</h1>
  <p>Enter password to continue</p>
  <div class="err">Incorrect password</div>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
  </form>
</div>
</body>
</html>`

const LOGIN_PAGE       = LOGIN_HTML.replace('__DISPLAY__', 'display:none')
const LOGIN_PAGE_ERROR = LOGIN_HTML.replace('__DISPLAY__', 'display:block')

// ── Inject fresh data into HTML first ────────────────────────────────────────
console.log('Injecting data...')
execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadSalesData() {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'sales_data.json'), 'utf8'))
  return Array.isArray(raw) ? { appointments: raw, dials: [] } : raw
}

function loadOnboarding() {
  try {
    const clientsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'clients.json'), 'utf8'))
    const alerts      = JSON.parse(fs.readFileSync(path.join(dataDir, 'alerts.json'),  'utf8'))
    const clients = clientsData.clients.map(c => ({
      ...c,
      status:              c.onboarding?.status             ?? null,
      steps:               c.onboarding?.steps              ?? {},
      log:                 c.onboarding?.log                ?? [],
      launchedDate:        c.onboarding?.launchedDate       ?? null,
      campaignsLaunchedAt: c.onboarding?.campaignsLaunchedAt ?? null,
      readyToBookCallAt:   c.onboarding?.readyToBookCallAt  ?? null,
    }))
    return { clients, alerts: alerts.alerts }
  } catch {
    return { clients: [], alerts: [] }
  }
}

function saveOnboarding(data) {
  fs.writeFileSync(path.join(dataDir, 'clients.json'), JSON.stringify({ clients: data.clients }, null, 2))
  fs.writeFileSync(path.join(dataDir, 'alerts.json'),  JSON.stringify({ alerts:  data.alerts  }, null, 2))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end',  ()    => resolve(body))
    req.on('error', reject)
  })
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(obj))
}

// ── SSE reload ────────────────────────────────────────────────────────────────
const sseClients = new Set()
function broadcastReload() {
  for (const client of sseClients) {
    try { client.write('event: reload\ndata: {}\n\n') } catch {}
  }
}
function broadcastOnboardingUpdate() {
  const payload = JSON.stringify(loadOnboarding())
  for (const client of sseClients) {
    try { client.write(`event: onboarding-update\ndata: ${payload}\n\n`) } catch {}
  }
}

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // Login page
  if (req.method === 'GET' && req.url === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(LOGIN_PAGE)
  }

  // Login form submit
  if (req.method === 'POST' && req.url === '/login') {
    const body = await readBody(req)
    const params = new URLSearchParams(body)
    if (params.get('password') === DASHBOARD_PASSWORD) {
      const token = makeToken()
      const maxAge = 30 * 24 * 60 * 60  // 30 days
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
      })
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(LOGIN_PAGE_ERROR)
  }

  // Auth check for all other routes
  if (!isAuthed(req)) {
    res.writeHead(302, { Location: '/login' })
    return res.end()
  }

  // SSE: live reload events
  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    res.write('data: connected\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST' })
    return res.end()
  }

  // Serve dashboard HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(htmlFile, 'utf8')
    const patched = html.replace('</head>',
      `<script>window.API_BASE="";` +
      `(function(){const es=new EventSource("/api/events");` +
      `es.addEventListener("reload",function(){` +
        `try{` +
          `sessionStorage.setItem("__dv",document.body.classList.contains("ops-mode")?"ops":"sales");` +
          `sessionStorage.setItem("__dt",document.querySelector(".tab.on")?.dataset?.tab||"");` +
        `}catch(e){}` +
        `location.reload();` +
      `});` +
      `es.addEventListener("onboarding-update",function(e){` +
        `try{window.ONBOARDING_DATA=JSON.parse(e.data);}catch(err){}` +
      `});` +
      `})()</script></head>`)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(patched)
  }

  // API: update a single appointment's outcome fields
  if (req.method === 'POST' && req.url === '/api/update-appointment') {
    try {
      const body    = JSON.parse(await readBody(req))
      const { id, fields } = body
      if (!id || !fields) return json(res, 400, { error: 'id and fields required' })

      const data   = loadSalesData()
      const idx    = data.appointments.findIndex(a => a.id === id)
      if (idx === -1) return json(res, 404, { error: 'appointment not found' })

      const allowed = ['status','source','closer','cashCollected','cashCollectedAfterFirstCall','contractRevenue','followUpBooked','fathomLink','offerMade','excluded','fathomConflictNote','noFathomNote','contactName','createdBy']
      const VALID_STATUSES = ['new','confirmed','closed','not_closed','no_show','cancelled']
      const VALID_SOURCES  = ['Cold SMS','Ads','Referral','Organic']
      const NUM_FIELDS     = ['cashCollected','cashCollectedAfterFirstCall','contractRevenue']

      if (fields.status !== undefined && !VALID_STATUSES.includes(fields.status))
        return json(res, 400, { error: `invalid status '${fields.status}' — must be one of: ${VALID_STATUSES.join(', ')}` })
      if (fields.source !== undefined && !VALID_SOURCES.includes(fields.source))
        return json(res, 400, { error: `invalid source '${fields.source}' — must be one of: ${VALID_SOURCES.join(', ')}` })
      for (const f of NUM_FIELDS) {
        if (fields[f] !== undefined && fields[f] !== null && fields[f] !== '') {
          const n = Number(fields[f])
          if (isNaN(n) || n < 0) return json(res, 400, { error: `${f} must be a non-negative number` })
          fields[f] = n
        }
      }

      const appt = data.appointments[idx]
      const newStatus = fields.status ?? appt.status
      if (['no_show','cancelled'].includes(newStatus) && (fields.fathomLink || appt.fathomLink)) {
        console.warn(`  ⚠ ${appt.contactName}: status set to ${newStatus} but fathomLink exists — flagged for review`)
      }

      if (fields.status && fields.status !== appt.status) {
        appt.statusHistory = appt.statusHistory || []
        appt.statusHistory.push({ status: fields.status, at: new Date().toISOString(), source: 'manual' })
      }

      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) data.appointments[idx][k] = v
      }

      fs.writeFileSync(path.join(dataDir, 'sales_data.json'), JSON.stringify(data, null, 2))
      console.log(`[update] ${data.appointments[idx].contactName} — ${JSON.stringify(fields)}`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastReload()
      return json(res, 200, { ok: true, appointment: data.appointments[idx] })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: update a single expense (e.g. add missing date)
  if (req.method === 'POST' && req.url === '/api/update-expense') {
    try {
      const body = JSON.parse(await readBody(req))
      const { id, fields } = body
      if (!id || !fields) return json(res, 400, { error: 'id and fields required' })

      const expFile = path.join(dataDir, 'expenses.json')
      const expenses = JSON.parse(fs.readFileSync(expFile, 'utf8'))
      const idx = expenses.findIndex(e => e.id === id)
      if (idx === -1) return json(res, 404, { error: 'expense not found' })

      const allowed = ['date', 'dateFrom']
      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) expenses[idx][k] = v
      }

      fs.writeFileSync(expFile, JSON.stringify(expenses, null, 2))
      console.log(`[expense] ${expenses[idx].vendor || id} — ${JSON.stringify(fields)}`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastReload()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: reload HTML with fresh data
  if (req.method === 'POST' && req.url === '/api/reload') {
    try {
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastReload()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: update dials count for a specific week
  if (req.method === 'POST' && req.url === '/api/update-dials') {
    try {
      const body = JSON.parse(await readBody(req))
      const { week, dials } = body
      if (!week || dials === undefined) return json(res, 400, { error: 'week and dials required' })

      const file = path.join(dataDir, 'weekly_dials.json')
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const idx  = data.findIndex(w => w.week === week)
      if (idx !== -1) {
        data[idx].dials = Number(dials)
      } else {
        data.push({ week, dials: Number(dials) })
        data.sort((a, b) => a.week.localeCompare(b.week))
      }
      fs.writeFileSync(file, JSON.stringify(data, null, 2))
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastReload()
      console.log(`[dials] ${week} → ${dials}`)
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: mark an onboarding step complete
  if (req.method === 'POST' && req.url === '/api/onboarding/mark-done') {
    try {
      const body = JSON.parse(await readBody(req))
      const { clientId, step, deliverable } = body
      if (!clientId || !step) return json(res, 400, { error: 'clientId and step required' })

      const data = loadOnboarding()
      const client = data.clients.find(c => c.id === clientId)
      if (!client) return json(res, 404, { error: 'client not found' })

      const stepObj = client.onboarding.steps[step]
      if (!stepObj) return json(res, 404, { error: 'step not found' })
      if (stepObj.status === 'complete') return json(res, 200, { ok: true, alreadyDone: true })

      const now   = new Date().toISOString()
      const today = now.split('T')[0]

      stepObj.status      = 'complete'
      stepObj.completedAt = today
      if (deliverable) stepObj.deliverable = deliverable

      client.onboarding.log = client.onboarding.log || []
      client.onboarding.log.push({ timestamp: now, event: 'step_completed', step, by: 'dashboard' })

      if (step === 'campaigns_launched') {
        client.onboarding.status             = 'launched'
        client.onboarding.launchedDate       = today
        client.onboarding.campaignsLaunchedAt = now
      }

      saveOnboarding(data)
      console.log(`[onboarding] ${client.companyName} — "${step}" marked done`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: mark all onboarding steps complete (mark client as launched)
  if (req.method === 'POST' && req.url === '/api/onboarding/mark-complete') {
    try {
      const body = JSON.parse(await readBody(req))
      const { clientId } = body
      if (!clientId) return json(res, 400, { error: 'clientId required' })

      const data = loadOnboarding()
      const client = data.clients.find(c => c.id === clientId)
      if (!client) return json(res, 404, { error: 'client not found' })

      const now   = new Date().toISOString()
      const today = now.split('T')[0]

      for (const stepObj of Object.values(client.onboarding.steps)) {
        if (stepObj.status !== 'complete') {
          stepObj.status      = 'complete'
          stepObj.completedAt = today
        }
      }

      client.onboarding.status              = 'launched'
      client.onboarding.launchedDate        = client.onboarding.launchedDate || today
      client.onboarding.campaignsLaunchedAt = client.onboarding.campaignsLaunchedAt || now
      client.onboarding.log = client.onboarding.log || []
      client.onboarding.log.push({ timestamp: now, event: 'onboarding_completed', by: 'dashboard', note: 'Marked complete manually' })

      saveOnboarding(data)
      console.log(`[onboarding] ${client.companyName} — marked fully complete`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: log a follow-up attempt on a client step
  if (req.method === 'POST' && req.url === '/api/onboarding/followed-up') {
    try {
      const body = JSON.parse(await readBody(req))
      const { clientId, step } = body
      if (!clientId || !step) return json(res, 400, { error: 'clientId and step required' })

      const data = loadOnboarding()
      const client = data.clients.find(c => c.id === clientId)
      if (!client) return json(res, 404, { error: 'client not found' })

      const stepObj = client.onboarding.steps[step]
      if (!stepObj) return json(res, 404, { error: 'step not found' })

      const now = new Date().toISOString()
      stepObj.followUpLog = stepObj.followUpLog || []
      stepObj.followUpLog.push({ at: now })

      client.onboarding.log = client.onboarding.log || []
      client.onboarding.log.push({ timestamp: now, event: 'followed_up', step, by: 'dashboard' })

      saveOnboarding(data)
      console.log(`[onboarding] ${client.companyName} — follow-up logged for "${step}"`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: undo a completed onboarding step
  if (req.method === 'POST' && req.url === '/api/onboarding/undo-step') {
    try {
      const body = JSON.parse(await readBody(req))
      const { clientId, step, timestamp } = body
      if (!clientId || !step) return json(res, 400, { error: 'clientId and step required' })

      const data = loadOnboarding()
      const client = data.clients.find(c => c.id === clientId)
      if (!client) return json(res, 404, { error: 'client not found' })

      const stepObj = client.onboarding.steps[step]
      if (!stepObj) return json(res, 404, { error: 'step not found' })

      stepObj.status = 'pending'
      delete stepObj.completedAt
      delete stepObj.deliverable

      // Mark original log entry as undone (preserves audit trail)
      const logEntry = (client.onboarding.log || []).find(e =>
        e.step === step && e.event === 'step_completed' && (!timestamp || e.timestamp === timestamp)
      )
      if (logEntry) logEntry.undone = true

      // Log the undo action
      client.onboarding.log = client.onboarding.log || []
      client.onboarding.log.push({ timestamp: new Date().toISOString(), event: 'step_undone', step, by: 'dashboard' })

      // Revert side-effects from campaigns_launched
      if (step === 'campaigns_launched' && client.onboarding.status === 'launched') {
        client.onboarding.status = 'onboarding'
        delete client.onboarding.launchedDate
        delete client.onboarding.campaignsLaunchedAt
      }

      saveOnboarding(data)
      console.log(`[onboarding] ${client.companyName} — "${step}" undone`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: get current onboarding data
  if (req.method === 'GET' && req.url === '/api/onboarding') {
    return json(res, 200, loadOnboarding())
  }

  // API: update a client record (companyName, email, onboardingStatus)
  if (req.method === 'POST' && req.url === '/api/onboarding/update-client') {
    try {
      const body = JSON.parse(await readBody(req))
      const { clientId, companyName: searchName, fields } = body
      if (!fields) return json(res, 400, { error: 'fields required' })

      const data = loadOnboarding()
      const client = clientId
        ? data.clients.find(c => c.id === clientId)
        : data.clients.find(c => c.companyName === searchName || c.name === searchName)
      if (!client) return json(res, 404, { error: 'client not found' })

      if (fields.companyName != null) client.companyName = fields.companyName
      if (fields.email       != null) client.email       = fields.email
      if (fields.notes       != null) client.notes       = fields.notes

      if (fields.onboardingStatus) {
        const now   = new Date().toISOString()
        const today = now.split('T')[0]
        client.onboarding.status = fields.onboardingStatus
        if (fields.onboardingStatus === 'launched' && !client.onboarding.launchedDate) {
          client.onboarding.launchedDate        = today
          client.onboarding.campaignsLaunchedAt = client.onboarding.campaignsLaunchedAt || now
        }
        client.onboarding.log = client.onboarding.log || []
        client.onboarding.log.push({ timestamp: now, event: 'status_updated', status: fields.onboardingStatus, by: 'dashboard' })
      }

      saveOnboarding(data)
      console.log(`[onboarding] ${client.companyName} — client record updated`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true, clientId: client.id })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: update a sales appointment (contractRevenue, cashCollected)
  if (req.method === 'POST' && req.url === '/api/sales/update-appointment') {
    try {
      const body = JSON.parse(await readBody(req))
      const { appointmentId, fields } = body
      if (!appointmentId || !fields) return json(res, 400, { error: 'appointmentId and fields required' })

      const raw          = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'))
      const appointments = Array.isArray(raw) ? raw : (raw.appointments || [])
      const appt         = appointments.find(a => a.id === appointmentId)
      if (!appt) return json(res, 404, { error: 'appointment not found' })

      if (fields.contractRevenue != null) appt.contractRevenue = Number(fields.contractRevenue)
      if (fields.cashCollected   != null) appt.cashCollected   = Number(fields.cashCollected)
      if (fields.status          != null) appt.status          = fields.status

      const out = Array.isArray(raw) ? appointments : { ...raw, appointments }
      fs.writeFileSync(SALES_FILE, JSON.stringify(out, null, 2))
      console.log(`[sales] Appointment ${appointmentId} updated`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastReload()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: resolve an alert
  if (req.method === 'POST' && req.url === '/api/onboarding/resolve-alert') {
    try {
      const body = JSON.parse(await readBody(req))
      const { alertId } = body
      if (!alertId) return json(res, 400, { error: 'alertId required' })

      const data = loadOnboarding()
      const alertObj = (data.alerts || []).find(a => a.id === alertId)
      if (!alertObj) return json(res, 404, { error: 'alert not found' })

      alertObj.status     = 'resolved'
      alertObj.resolvedAt = new Date().toISOString()

      saveOnboarding(data)
      console.log(`[onboarding] Alert ${alertId} resolved`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: add a new onboarding client (all steps blank/pending)
  if (req.method === 'POST' && req.url === '/api/onboarding/new-client') {
    try {
      const body = JSON.parse(await readBody(req))
      const { name, company, email } = body
      if (!name || !email) return json(res, 400, { error: 'name and email required' })

      const data = loadOnboarding()
      const existingByEmail = data.clients.find(c => c.email === email)
      if (existingByEmail) {
        if (existingByEmail.onboarding?.status === 'launched') {
          return json(res, 409, { error: 'A client with that email has already been launched' })
        }
        // Already in onboarding — match to existing record instead of erroring
        console.log(`[onboarding] Email ${email} matched existing client ${existingByEmail.id} — returning existing record`)
        return json(res, 200, { ok: true, clientId: existingByEmail.id, matched: true })
      }

      const now   = new Date().toISOString()
      const today = now.split('T')[0]
      const companyName = company || name
      const id = 'client_' + companyName.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now()

      const pendingStep = (extra = {}) => ({ status: 'pending', completedAt: null, ...extra })
      const steps = {
        payment_collected:           pendingStep({ autoDetected: true,  trigger: 'manual' }),
        contract_signed:             pendingStep({ autoDetected: false }),
        welcome_email_sent:          pendingStep({ autoDetected: true,  trigger: 'auto' }),
        added_to_daily_sweep:        pendingStep({ autoDetected: true,  trigger: 'auto' }),
        onboarding_form_submitted:   pendingStep({ autoDetected: true,  trigger: 'ghl_webhook',   dependsOn: ['contract_signed'] }),
        client_joined_discord:       pendingStep({ autoDetected: true,  trigger: 'discord_event', dependsOn: ['contract_signed'] }),
        discord_channel_created:     pendingStep({ autoDetected: true,  trigger: 'auto',          dependsOn: ['client_joined_discord'] }),
        ghl_subaccount_configured:   pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['onboarding_form_submitted'] }),
        facebook_access_granted:     pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['onboarding_form_submitted'] }),
        client_media_submitted:      pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['onboarding_form_submitted'] }),
        ad_scripts_written:          pendingStep({ autoDetected: false, owner: 'mediaBuyer',      dependsOn: ['onboarding_form_submitted'] }),
        ad_scripts_sent_to_client:   pendingStep({ autoDetected: false, owner: 'mediaBuyer',      dependsOn: ['ad_scripts_written'] }),
        ad_scripts_approved:         pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['ad_scripts_sent_to_client'] }),
        video_editor_briefed:        pendingStep({ autoDetected: false, owner: 'mediaBuyer',      dependsOn: ['ad_scripts_approved', 'client_media_submitted'] }),
        ad_creatives_produced:       pendingStep({ autoDetected: false, owner: 'videoEditor',     dependsOn: ['video_editor_briefed'] }),
        meta_campaigns_built:        pendingStep({ autoDetected: false, owner: 'mediaBuyer',      dependsOn: ['ad_creatives_produced', 'facebook_access_granted'] }),
        onboarding_call_booked:      pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['ghl_subaccount_configured', 'meta_campaigns_built', 'onboarding_form_submitted', 'client_joined_discord'], readyToBookTrigger: true }),
        onboarding_call_completed:   pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['onboarding_call_booked'], checklist: ['calendar_connected', 'crm_access_granted', 'test_lead_run'] }),
        campaigns_launched:          pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['onboarding_call_completed'] }),
        '48hr_health_check':         pendingStep({ autoDetected: false, owner: 'accountManager',  dependsOn: ['campaigns_launched'], timeGatedHours: 48 }),
        post_launch_checkin_scheduled: pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['campaigns_launched'] }),
      }

      const client = {
        id,
        name,
        companyName,
        email,
        appointmentId: null,
        contractSignedDate: today,
        contractEndDate: null,
        stripeCustomerId: null,
        fathomSalesCallLink: null,
        needsVideoEditor: true,
        discordChannelId: null,
        onboarding: {
          status: 'onboarding',
          launchedDate: null,
          campaignsLaunchedAt: null,
          readyToBookCallAt: null,
          steps,
          log: [{ timestamp: now, event: 'client_created', note: 'Added manually via dashboard.' }]
        }
      }

      data.clients.push(client)
      saveOnboarding(data)

      // Auto-sync: link to closed appointment in sales_data if possible
      const synced = syncAllClients(CLIENTS_FILE, SALES_FILE)
      const link = synced.find(s => s.client.id === id)
      if (link) {
        console.log(`[onboarding] Linked ${companyName} ↔ appointment ${link.appointment.id} (${link.confidence} match)`)
      }

      console.log(`[onboarding] New client added: ${companyName} (${email})`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, {
        ok: true,
        clientId: id,
        appointmentLinked: link ? { id: link.appointment.id, name: link.appointment.contactName, confidence: link.confidence } : null
      })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: save someone as a deposit (not yet a full client)
  if (req.method === 'POST' && req.url === '/api/onboarding/new-deposit') {
    try {
      const body = JSON.parse(await readBody(req))
      const { name, company, email, depositAmount, notes } = body
      if (!name) return json(res, 400, { error: 'name required' })

      const data = loadOnboarding()
      const existing = email ? data.clients.find(c => c.email === email) : null
      if (existing) {
        console.log(`[onboarding] Deposit: email ${email} matched existing client ${existing.id} — skipping`)
        return json(res, 200, { ok: true, clientId: existing.id, matched: true })
      }

      const now         = new Date().toISOString()
      const today       = now.split('T')[0]
      const companyName = company || name
      const id          = 'deposit_' + companyName.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now()

      const client = {
        id,
        name,
        companyName,
        email: email || null,
        depositAmount: depositAmount || null,
        depositDate:   today,
        notes:         notes || null,
        onboarding: {
          status: 'deposit',
          log: [{ timestamp: now, event: 'deposit_saved', note: 'Saved as deposit — not yet fully signed.' }]
        }
      }

      data.clients.push(client)
      saveOnboarding(data)
      console.log(`[onboarding] Deposit saved: ${companyName}`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true, clientId: id })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: convert a deposit record to a full onboarding client
  if (req.method === 'POST' && req.url === '/api/onboarding/convert-deposit') {
    try {
      const body = JSON.parse(await readBody(req))
      const { clientId } = body
      if (!clientId) return json(res, 400, { error: 'clientId required' })

      const data   = loadOnboarding()
      const client = data.clients.find(c => c.id === clientId)
      if (!client) return json(res, 404, { error: 'client not found' })

      const now   = new Date().toISOString()
      const today = now.split('T')[0]

      const pendingStep = (extra = {}) => ({ status: 'pending', completedAt: null, ...extra })
      client.contractSignedDate = client.contractSignedDate || today
      client.onboarding.status  = 'onboarding'
      client.onboarding.steps   = {
        payment_collected:           { ...pendingStep({ autoDetected: true, trigger: 'manual' }), status: 'complete', completedAt: today, note: 'Deposit paid — converted to full client' },
        contract_signed:             pendingStep({ autoDetected: false }),
        welcome_email_sent:          pendingStep({ autoDetected: true, trigger: 'auto' }),
        added_to_daily_sweep:        pendingStep({ autoDetected: true, trigger: 'auto' }),
        onboarding_form_submitted:   pendingStep({ autoDetected: true, trigger: 'ghl_webhook',   dependsOn: ['contract_signed'] }),
        client_joined_discord:       pendingStep({ autoDetected: true, trigger: 'discord_event', dependsOn: ['contract_signed'] }),
        discord_channel_created:     pendingStep({ autoDetected: true, trigger: 'auto',          dependsOn: ['client_joined_discord'] }),
        ghl_subaccount_configured:   pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['onboarding_form_submitted'] }),
        facebook_access_granted:     pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['onboarding_form_submitted'] }),
        client_media_submitted:      pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['onboarding_form_submitted'] }),
        ad_scripts_written:          pendingStep({ autoDetected: false, owner: 'mediaBuyer',     dependsOn: ['onboarding_form_submitted'] }),
        ad_scripts_sent_to_client:   pendingStep({ autoDetected: false, owner: 'mediaBuyer',     dependsOn: ['ad_scripts_written'] }),
        ad_scripts_approved:         pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['ad_scripts_sent_to_client'] }),
        meta_campaigns_built:        pendingStep({ autoDetected: false, owner: 'mediaBuyer',     dependsOn: ['ad_scripts_approved', 'client_media_submitted', 'facebook_access_granted'] }),
        onboarding_call_booked:      pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['ghl_subaccount_configured', 'meta_campaigns_built', 'onboarding_form_submitted', 'client_joined_discord'], readyToBookTrigger: true }),
        onboarding_call_completed:   pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['onboarding_call_booked'], checklist: ['calendar_connected', 'crm_access_granted', 'test_lead_run'] }),
        campaigns_launched:          pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['onboarding_call_completed'] }),
        '48hr_health_check':         pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['campaigns_launched'], timeGatedHours: 48 }),
        post_launch_checkin_scheduled: pendingStep({ autoDetected: false, owner: 'accountManager', dependsOn: ['campaigns_launched'] }),
      }
      client.onboarding.log = client.onboarding.log || []
      client.onboarding.log.push({ timestamp: now, event: 'converted_from_deposit', by: 'dashboard' })

      saveOnboarding(data)
      console.log(`[onboarding] ${client.companyName} converted from deposit to onboarding`)
      execSync('node scripts/inject-and-open.mjs --no-open', { cwd: root, stdio: 'ignore' })
      broadcastOnboardingUpdate()
      return json(res, 200, { ok: true, clientId })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  return json(res, 404, { error: `Route not found: ${req.method} ${req.url}` })
})

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`)
  if (!noOpen) {
    try { execSync(`open http://localhost:${PORT}`) } catch {}
  }
})

process.on('SIGINT', () => { server.close(); process.exit() })
