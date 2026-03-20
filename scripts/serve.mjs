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

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`)
  if (!noOpen) execSync(`open http://localhost:${PORT}`)
})

process.on('SIGINT', () => { server.close(); process.exit() })
