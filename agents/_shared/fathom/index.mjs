#!/usr/bin/env node
/**
 * Fathom (fathom.ai) API client
 * - Loads FATHOM_API_TOKEN or FATHOM_API_KEY from .secrets.env
 * - Provides helpers for common operations
 */

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_BASE = 'https://api.fathom.ai/external/v1'

function loadSecrets(repoRoot = process.cwd()) {
  try {
    const envPath = path.join(repoRoot, '.secrets.env')
    const text = fs.readFileSync(envPath, 'utf8')
    const out = {}
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2]
    }
    return out
  } catch {
    return {}
  }
}

function getConfig(repoRoot = process.cwd()) {
  const env = { ...process.env, ...loadSecrets(repoRoot) }
  const token = env.FATHOM_API_TOKEN || env.FATHOM_API_KEY
  const base = env.FATHOM_API_BASE || DEFAULT_BASE
  if (!token) throw new Error('Missing FATHOM_API_TOKEN in .secrets.env')
  return { token, base }
}

async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body })
  if (res.status === 204) return null
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Fathom API ${method} ${url} failed: ${res.status} ${text}`)
  }
  const json = await res.json()
  return { json, headers: res.headers }
}

/**
 * List meetings with optional cursor pagination.
 * @param {Object} opts
 * @param {number} [opts.limit=50]
 * @param {string} [opts.cursor]
 * @param {string} [opts.repoRoot]
 */
export async function listMeetings({ limit = 50, cursor, repoRoot } = {}) {
  const { token, base } = getConfig(repoRoot)
  const u = new URL(base.replace(/\/$/, '') + '/meetings')
  if (limit) u.searchParams.set('limit', String(limit))
  if (cursor) u.searchParams.set('cursor', cursor)

  const { json, headers } = await fetchJson(u.toString(), {
    headers: { 'X-Api-Key': token }
  })
  return { ...json, rate: extractRate(headers) }
}

/**
 * Get a single meeting by recording_id.
 * @param {number|string} id
 */
export async function getMeeting(id, { repoRoot } = {}) {
  const { token, base } = getConfig(repoRoot)
  const url = base.replace(/\/$/, '') + `/meetings/${id}`
  const { json, headers } = await fetchJson(url, {
    headers: { 'X-Api-Key': token }
  })
  return { ...json, rate: extractRate(headers) }
}

/** Extract basic rate limit headers */
function extractRate(h) {
  return {
    limit: h.get('RateLimit-Limit'),
    remaining: h.get('RateLimit-Remaining'),
    reset: h.get('RateLimit-Reset')
  }
}

/**
 * Paged iterator for meetings
 */
export async function* iterateMeetings({ pageSize = 50, maxPages = 100, repoRoot } = {}) {
  let cursor
  for (let i = 0; i < maxPages; i++) {
    const { items = [], next_cursor } = await listMeetings({ limit: pageSize, cursor, repoRoot })
    for (const it of items) yield it
    if (!next_cursor || items.length === 0) break
    cursor = next_cursor
  }
}

// CLI probe
if (process.argv[1] === import.meta.url.replace('file://', '') || process.argv[1]?.endsWith('index.mjs')) {
  const cmd = process.argv[2]
  if (cmd === 'probe') {
    const { items = [], next_cursor, limit } = await listMeetings({ limit: 5 })
    console.log('limit:', limit, 'items:', items.length, 'next_cursor:', !!next_cursor)
    for (const m of items) {
      console.log('-', m.title || m.meeting_title || '(untitled)', m.url || '', '@', m.created_at)
    }
  }
}
