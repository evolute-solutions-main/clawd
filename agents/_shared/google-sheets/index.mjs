#!/usr/bin/env node
/**
 * Google Sheets helper using OAuth refresh token
 * Requires: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 */

import fs from 'node:fs'
import path from 'node:path'

function loadSecrets(repoRoot) {
  const secrets = {}
  try {
    const p = path.join(repoRoot, '.secrets.env')
    const text = fs.readFileSync(p, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) secrets[m[1]] = m[2]
    }
  } catch {}
  return secrets
}

async function getAccessToken(secrets) {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = secrets
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error('Missing Google OAuth credentials in .secrets.env')
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to refresh token: ${res.status} ${text}`)
  }

  const data = await res.json()
  return data.access_token
}

/**
 * Append rows to a Google Sheet
 * @param {Object} opts
 * @param {string} opts.spreadsheetId - The spreadsheet ID from the URL
 * @param {string} opts.range - Sheet range like "Sheet1!A:F" or just "Sheet1"
 * @param {Array<Array<any>>} opts.values - 2D array of row values
 * @param {string} [opts.repoRoot] - Path to repo root for loading secrets
 */
export async function appendRows({ spreadsheetId, range, values, repoRoot = process.cwd() }) {
  const secrets = loadSecrets(repoRoot)
  const accessToken = await getAccessToken(secrets)

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to append rows: ${res.status} ${text}`)
  }

  return res.json()
}

/**
 * Read values from a Google Sheet
 * @param {Object} opts
 * @param {string} opts.spreadsheetId
 * @param {string} opts.range
 * @param {string} [opts.repoRoot]
 */
export async function readSheet({ spreadsheetId, range, repoRoot = process.cwd() }) {
  const secrets = loadSecrets(repoRoot)
  const accessToken = await getAccessToken(secrets)

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to read sheet: ${res.status} ${text}`)
  }

  return res.json()
}

/**
 * Update values in a Google Sheet (overwrite existing)
 * @param {Object} opts
 * @param {string} opts.spreadsheetId
 * @param {string} opts.range
 * @param {Array<Array<any>>} opts.values
 * @param {string} [opts.repoRoot]
 */
export async function updateRange({ spreadsheetId, range, values, repoRoot = process.cwd() }) {
  const secrets = loadSecrets(repoRoot)
  const accessToken = await getAccessToken(secrets)

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to update range: ${res.status} ${text}`)
  }

  return res.json()
}

/**
 * Get spreadsheet metadata (sheet names, etc.)
 * @param {Object} opts
 * @param {string} opts.spreadsheetId
 * @param {string} [opts.repoRoot]
 */
export async function getSpreadsheetInfo({ spreadsheetId, repoRoot = process.cwd() }) {
  const secrets = loadSecrets(repoRoot)
  const accessToken = await getAccessToken(secrets)

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get spreadsheet info: ${res.status} ${text}`)
  }

  return res.json()
}

// CLI test
if (process.argv[1] === import.meta.url.replace('file://', '') || process.argv[1]?.endsWith('index.mjs')) {
  const [,, cmd, ...args] = process.argv
  if (cmd === 'test') {
    const spreadsheetId = args[0] || '1lZzukpw0VTm-TZDBPzzNUW2hYK69nWlx1JsmF_BZ_yI'
    getSpreadsheetInfo({ spreadsheetId })
      .then(info => {
        console.log('Sheets:', info.sheets?.map(s => s.properties?.title))
      })
      .catch(e => console.error('Error:', e.message))
  }
}
