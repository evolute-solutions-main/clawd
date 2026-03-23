#!/usr/bin/env node
/**
 * serve.mjs — Local dashboard server
 *
 * Serves the dashboard on http://localhost:3847 and accepts API requests
 * from the browser to update data/sales_data.json (used by the Needs Review tab).
 *
 * Usage:
 *   node scripts/serve.mjs          (inject data + start server + open browser)
 *   node scripts/serve.mjs --no-open (skip opening browser)
 */

import fs          from 'fs'
import http        from 'http'
import path        from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const root      = path.resolve(fileURLToPath(import.meta.url), '../../')
const dataDir   = path.join(root, 'data')
const htmlFile  = path.join(root, 'sales_tracker.html')
const PORT      = 3847
const noOpen    = process.argv.includes('--no-open')

// ── Inject fresh data into HTML first ────────────────────────────────────────
console.log('Injecting data...')
execSync('node scripts/inject-and-open.mjs', { cwd: root, stdio: 'ignore' })

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadSalesData() {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'sales_data.json'), 'utf8'))
  return Array.isArray(raw) ? { appointments: raw, dials: [] } : raw
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

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST' })
    return res.end()
  }

  // Serve dashboard HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(htmlFile, 'utf8')
    // Patch API base URL into the page so fetch calls use the server
    const patched = html.replace('</head>', '<script>window.API_BASE="http://localhost:'+PORT+'"</script></head>')
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

      const allowed = ['status','source','closer','cashCollected','cashCollectedAfterFirstCall','contractRevenue','followUpBooked','fathomLink','offerMade','excluded']
      const VALID_STATUSES = ['new','confirmed','closed','not_closed','no_show','cancelled']
      const VALID_SOURCES  = ['Cold SMS','Ads','Referral','Organic']
      const NUM_FIELDS     = ['cashCollected','cashCollectedAfterFirstCall','contractRevenue']

      // Field-level validation
      if (fields.status !== undefined && !VALID_STATUSES.includes(fields.status))
        return json(res, 400, { error: `invalid status '${fields.status}' — must be one of: ${VALID_STATUSES.join(', ')}` })
      if (fields.source !== undefined && !VALID_SOURCES.includes(fields.source))
        return json(res, 400, { error: `invalid source '${fields.source}' — must be one of: ${VALID_SOURCES.join(', ')}` })
      for (const f of NUM_FIELDS) {
        if (fields[f] !== undefined && fields[f] !== null && fields[f] !== '') {
          const n = Number(fields[f])
          if (isNaN(n) || n < 0) return json(res, 400, { error: `${f} must be a non-negative number` })
          fields[f] = n  // coerce to number
        }
      }

      // If status is being set to no_show/cancelled but appointment has a fathomLink,
      // flag it — don't block the save, but mark it so it surfaces in Needs Review.
      const appt = data.appointments[idx]
      const newStatus = fields.status ?? appt.status
      if (['no_show','cancelled'].includes(newStatus) && (fields.fathomLink || appt.fathomLink)) {
        console.warn(`  ⚠ ${appt.contactName}: status set to ${newStatus} but fathomLink exists — flagged for review`)
      }

      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) data.appointments[idx][k] = v
      }

      fs.writeFileSync(path.join(dataDir, 'sales_data.json'), JSON.stringify(data, null, 2))
      console.log(`[update] ${data.appointments[idx].contactName} — ${JSON.stringify(fields)}`)
      return json(res, 200, { ok: true, appointment: data.appointments[idx] })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // API: reload HTML with fresh data (call after updates)
  if (req.method === 'POST' && req.url === '/api/reload') {
    try {
      execSync('node scripts/inject-and-open.mjs', { cwd: root, stdio: 'ignore' })
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
      execSync('node scripts/inject-and-open.mjs', { cwd: root, stdio: 'ignore' })
      console.log(`[dials] ${week} → ${dials}`)
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`)
  if (!noOpen) execSync(`open http://localhost:${PORT}`)
})

process.on('SIGINT', () => { server.close(); process.exit() })
