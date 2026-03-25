// Shared Discord fetcher (minimal, generic)
// - Reads DISCORD_BOT_TOKEN from process.env (ensure env-loader.mjs is imported first)
// - Timezone read from SETTINGS.md (repo root)
// - Exposes:
//     fetchChannelWindow({ channelIds, date, filters?, guildId?, repoRoot? })
//     smoke({ channelIds, repoRoot? })
// - Not tied to any business logic; callers filter/map as needed.

import fs from 'node:fs'
import path from 'node:path'

function readTimezone(repoRoot) {
  try {
    const p = path.join(repoRoot, 'SETTINGS.md')
    const text = fs.readFileSync(p, 'utf8')
    const m = /value:\s*([^\n]+)/i.exec(text)
    return (m && m[1].trim()) || 'UTC'
  } catch {
    return 'UTC'
  }
}

function toLocalDateISO(isoUtc, tz) {
  // Returns YYYY-MM-DD of the timestamp in the provided timezone
  const d = new Date(isoUtc)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = fmt.formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {})
  return `${parts.year}-${parts.month}-${parts.day}`
}

async function discordRequest(pathname, { token, query } = {}) {
  const url = new URL(`https://discord.com/api/v10${pathname}`)
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)))
  // Build token list to try: primary first, then DISCORD_CHAT_BOT_TOKEN as fallback on 401
  const chatToken = process.env.DISCORD_CHAT_BOT_TOKEN
  const tokensToTry = [token]
  if (chatToken && chatToken !== token) tokensToTry.push(chatToken)
  let lastErr
  for (const t of tokensToTry) {
    while (true) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bot ${t}`,
          'User-Agent': 'EvanFetcher/1.0 (+https://evolute.local)'
        }
      })
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after')) || 1
        await new Promise(r => setTimeout(r, (retry + 0.25) * 1000))
        continue
      }
      if (res.status === 401) {
        // Token expired/invalid — try next token
        lastErr = new Error(`Discord API ${url.pathname} failed: 401 Unauthorized`)
        break
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Discord API ${url.pathname} failed: ${res.status} ${res.statusText} ${text}`)
      }
      return res.json()
    }
  }
  throw lastErr
}

function buildPermalink({ guildId, channelId, messageId }) {
  if (!guildId) return undefined
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

export async function listGuildChannels({ guildId, token }) {
  if (!token) token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_CHAT_BOT_TOKEN
  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN or DISCORD_CHAT_BOT_TOKEN for listGuildChannels')
  if (!guildId) throw new Error('listGuildChannels requires guildId')
  return await discordRequest(`/guilds/${guildId}/channels`, { token })
}

export async function fetchRecentChannel({ channelId, limit = 50, token }) {
  if (!token) token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_CHAT_BOT_TOKEN
  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN or DISCORD_CHAT_BOT_TOKEN for fetchRecentChannel')
  if (!channelId) throw new Error('fetchRecentChannel requires channelId')
  const capped = Math.max(1, Math.min(100, limit))
  const res = await discordRequest(`/channels/${channelId}/messages`, { token, query: { limit: capped } })
  return Array.isArray(res) ? res : []
}

export async function fetchChannelWindow({
  channelIds = [],
  date, // YYYY-MM-DD (window: inclusive [00:00:00 – 23:59:59] in repo timezone)
  filters = {}, // { authorEquals?: string, contentIncludes?: string|string[] }
  guildId,
  repoRoot = process.cwd()
} = {}) {
  const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_CHAT_BOT_TOKEN
  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN or DISCORD_CHAT_BOT_TOKEN in environment')
  if (!date) throw new Error('fetchChannelWindow requires date=YYYY-MM-DD')
  if (!Array.isArray(channelIds) || channelIds.length === 0) throw new Error('channelIds[] required')
  const tz = readTimezone(repoRoot)
  const includeList = Array.isArray(filters.contentIncludes) ? filters.contentIncludes : (filters.contentIncludes ? [filters.contentIncludes] : [])
  const authorEquals = filters.authorEquals && String(filters.authorEquals).toLowerCase()

  const rows = []
  for (const channelId of channelIds) {
    let before // message id for pagination
    let keepGoing = true
    while (keepGoing) {
      const page = await discordRequest(`/channels/${channelId}/messages`, { token, query: { limit: 100, ...(before ? { before } : {}) } })
      if (!Array.isArray(page) || page.length === 0) break
      for (const m of page) {
        const localDate = toLocalDateISO(m.timestamp, tz)
        if (localDate < date) { // older than window → we can stop paginating this channel
          keepGoing = false
          break
        }
        if (localDate > date) {
          // newer than window → just skip this message but continue paging
          before = m.id
          continue
        }
        // now m is within the local date window
        if (authorEquals && (!m.author || String(m.author.username).toLowerCase() !== authorEquals)) {
          before = m.id
          continue
        }
        if (includeList.length) {
          const contentLc = (m.content || '').toLowerCase()
          const pass = includeList.some(sub => contentLc.includes(String(sub).toLowerCase()))
          if (!pass) { before = m.id; continue }
        }
        rows.push({
          id: m.id,
          channelId,
          author: m.author?.username || 'Unknown',
          content: m.content || '',
          tsUtc: m.timestamp,
          tsLocal: localDate,
          permalink: buildPermalink({ guildId, channelId, messageId: m.id })
        })
        before = m.id
      }
      if (keepGoing && page.length < 100) break // no more pages
    }
  }
  return rows
}

export async function smoke({ channelIds = [], repoRoot = process.cwd() } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) return { ok: false, reason: 'Missing DISCORD_BOT_TOKEN' }
  if (!Array.isArray(channelIds) || channelIds.length === 0) return { ok: false, reason: 'No channels provided' }
  try {
    const sample = await discordRequest(`/channels/${channelIds[0]}/messages`, { token, query: { limit: 1 } })
    const tz = readTimezone(repoRoot)
    const rows = (sample || []).map(m => ({ id: m.id, channelId: channelIds[0], author: m.author?.username || 'Unknown', tsUtc: m.timestamp, tsLocal: toLocalDateISO(m.timestamp, tz) }))
    return { ok: true, samples: rows }
  } catch (e) {
    return { ok: false, reason: String(e.message || e) }
  }
}
