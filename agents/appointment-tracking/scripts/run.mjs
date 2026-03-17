#!/usr/bin/env node
// Runner for appointment-tracking using the shared Discord fetcher
import fs from 'node:fs'
import path from 'node:path'
import { fetchChannelWindow } from '../../_shared/discord-fetcher/index.mjs'

const CHANNELS = {
  unconfirmed: '1387098677646196887',
  confirmed:   '1332578941407334430'
}

function loadSecrets(repoRoot) {
  try {
    const p = path.join(repoRoot, '.secrets.env')
    const text = fs.readFileSync(p, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) {
        const [, k, v] = m
        if (!process.env[k]) process.env[k] = v
      }
    }
  } catch {}
}

function fmtTimeLocal(isoUtc, tz) {
  const d = new Date(isoUtc)
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d)
  const m = parts.reduce((a,p)=> (a[p.type]=p.value, a), {})
  return `${m.hour}:${m.minute}:${m.second}`
}

const repoRoot = process.cwd()
loadSecrets(repoRoot)

const tz = (()=>{
  try {
    const t = fs.readFileSync(path.join(repoRoot,'SETTINGS.md'),'utf8')
    const m = /value:\s*([^\n]+)/i.exec(t)
    return (m && m[1].trim()) || 'UTC'
  } catch { return 'UTC' }
})()

const dateArg = process.argv.find(a => a.startsWith('--date='))
const date = dateArg ? dateArg.split('=')[1] : (() => {
  // Default to yesterday in the repo timezone
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  return yesterday.toISOString().slice(0, 10)
})()

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }) }

function parseZapierContent(content) {
  const out = {}
  // Name (tolerant to emojis/bullets and with or without **bold** markers)
  let m = content.match(/(?:👤\s*)?(?:\*{0,2})Name:(?:\*{0,2})\s*([^\n\r]+)/i)
  out.name = m ? m[1].trim().replace(/\s+/g,' ') : undefined
  if (out.name) {
    // strip bleed-through into adjacent fields (e.g. blank name followed by Phone on same line)
    out.name = out.name.replace(/\s*[-–]\s*(?:📞|☎️|Phone:|Time:|Calendar:).*/i, '').trim() || undefined
  }
  // Phone (with or without **bold** markers; strip formatting, keep leading +)
  m = content.match(/(?:📞\s*)?(?:\*{0,2})Phone:(?:\*{0,2})\s*([+\d][\d\s()\-]+)/i)
  if (m) {
    const norm = m[1].trim().replace(/[^\d+]/g,'')
    out.phone = norm || undefined
  } else {
    // Fallback: only accept explicit + followed by 10–15 digits to avoid picking up years/times
    const pm = content.match(/(\+\d{10,15})\b/)
    if (pm) out.phone = pm[1]
  }
  // Calendar (confirmed only)
  m = content.match(/(?:\*{0,2})Calendar:(?:\*{0,2})\s*([^\n\r]+)/i)
  out.calendar = m ? m[1].trim() : undefined
  // Time text
  m = content.match(/(?:🕒\s*)?(?:\*{0,2})Time:(?:\*{0,2})\s*([^\n\r]+)/i)
  out.apptTimeText = m ? m[1].trim() : undefined
  // Setter: parse "Created by" / "Created By" field; default Unknown if missing
  // Handle formats like:
  //   "Created by: Randy Nadera"
  //   "**Created By:** Randy Nadera"
  //   "🙋♂️ **Created By** Randy Nadera" (value on same line)
  //   "🙋♂️ **Created By**\n🟨🟨🟨" (no value - next line is emoji border)
  m = content.match(/(?:🙋[‍♂️]*\s*)?(?:\*{0,2})created\s+by(?:\*{0,2})[:\s]*([^\n\r]*)/i)
  if (m) {
    let raw = m[1].trim().replace(/\.*$/, '').trim() // strip trailing period(s)
    // If the captured value is just emojis (borders) or empty, treat as Unknown
    // Check if it's mostly emoji/special chars (more than 50% non-alphanumeric)
    const alphanumeric = raw.replace(/[^a-zA-Z0-9\s]/g, '').trim()
    if (!alphanumeric || alphanumeric.length < raw.length * 0.3) {
      out.setter = 'Unknown'
    } else {
      out.setter = raw || 'Unknown'
    }
  } else {
    out.setter = 'Unknown'
  }
  return out
}

(async () => {
  try {
    const outDir = path.join(repoRoot, 'agents/appointment-tracking/outputs', date)
    ensureDir(outDir)

    // Fetch window for both channels
    const rows = await fetchChannelWindow({
      channelIds: [CHANNELS.unconfirmed, CHANNELS.confirmed],
      date,
      repoRoot,
      // pass guildId if you want permalinks; not strictly needed for now
      guildId: '1164939432722440282'
    })

    // Keep only Zapier author
    const zapier = rows.filter(r => r.author.toLowerCase() === 'zapier')

    // Write raw file (human-audit)
    const rawLines = []
    rawLines.push(`# Appointments Raw — ${date} (Global timezone)\n`)
    rawLines.push('One row per eligible Zapier message within ' + date + ' 00:00:00–23:59:59 (inclusive). Times below are local to the global timezone from SETTINGS.md.')
    rawLines.push('')
    rawLines.push('Columns: [time_local] [channel] [setter] [name] [phone] [message_id]')

    // Build structured rows — classify by channelId (robust to content formatting)
    const structured = []
    for (const r of zapier) {
      const channelType = (r.channelId === CHANNELS.confirmed) ? 'confirmed' : (r.channelId === CHANNELS.unconfirmed ? 'unconfirmed' : undefined)
      if (!channelType) continue
      const parsed = parseZapierContent(r.content)
      structured.push({
        id: r.id,
        addedTsUtc: r.tsUtc,
        channelType,
        setter: parsed.setter || 'Unknown',
        name: parsed.name,
        phone: parsed.phone,
        apptTimeText: parsed.apptTimeText,
        calendar: parsed.calendar,
        permalink: r.permalink
      })
      rawLines.push(`- ${fmtTimeLocal(r.tsUtc, tz)} ${channelType === 'confirmed' ? 'Confirmed' : 'Unconfirmed'} ${parsed.setter||'Unknown'} ${parsed.name||''} ${parsed.phone||''} ${r.id}`)
    }
    fs.writeFileSync(path.join(outDir, 'appointments.raw.md'), rawLines.join('\n'))

    // Cold-SMS lens first: include Unconfirmed always; include Confirmed only if calendar matches Cold SMS
    const isColdCalendar = (cal, content) => {
      const allow = [
        'cold sms evolute solutions - ai growth game plan call',
        'cold sms evolute solutions',
        'cold sms'
      ]
      const c = (cal||'').toLowerCase()
      if (allow.some(a => c.includes(a))) return true
      if (c.includes('cold') && c.includes('sms')) return true
      const body = (content||'').toLowerCase()
      if (body.includes('cold sms')) return true
      return false
    }
    const coldCandidates = structured.filter(r => r.channelType === 'unconfirmed' || (r.channelType === 'confirmed' && isColdCalendar(r.calendar, rows.find(x=>x.id===r.id)?.content)))

    // Collapse by phone only within Cold-SMS lens (latest per phone on the day)
    const byPhone = new Map()
    for (const row of coldCandidates) {
      if (!row.phone) continue // require phone per new rule
      const prev = byPhone.get(row.phone)
      if (!prev || new Date(row.addedTsUtc) > new Date(prev.addedTsUtc)) {
        byPhone.set(row.phone, row)
      }
    }
    const collapsedAll = Array.from(byPhone.values())
    // Cold SMS filter (already applied in lens; collapsedAll is Cold SMS only)
    // Build any-time Cold SMS confirmed map by phone
    const byPhoneAll = new Map()
    for (const row of structured) {
      if (!row.phone) continue
      const arr = byPhoneAll.get(row.phone) || []
      arr.push(row)
      byPhoneAll.set(row.phone, arr)
    }
    function anyTimeColdConfirmed(phone) {
      const arr = byPhoneAll.get(phone) || []
      return arr.some(r => r.channelType === 'confirmed' && isColdCalendar(r.calendar, rows.find(x=>x.id===r.id)?.content))
    }

    const cold = collapsedAll.filter(r => r.channelType === 'unconfirmed' || (r.channelType === 'confirmed' && isColdCalendar(r.calendar, rows.find(x=>x.id===r.id)?.content)))

    // Aggregate (EOD view)
    const totals = { confirmed: 0, unconfirmed: 0 }
    const perSetter = new Map()
    for (const r of cold) {
      totals[r.channelType === 'confirmed' ? 'confirmed' : 'unconfirmed']++
      const s = r.setter||'Unknown'
      const rec = perSetter.get(s) || { setter: s, confirmed: 0, unconfirmed: 0, total: 0 }
      if (r.channelType === 'confirmed') rec.confirmed++; else rec.unconfirmed++
      rec.total++
      perSetter.set(s, rec)
    }
    const perSetterArr = Array.from(perSetter.values()).sort((a,b)=> a.setter.localeCompare(b.setter))

    // Any-time confirmed list (unique phones)
    const anyTimePhones = Array.from(byPhoneAll.keys()).filter(p => anyTimeColdConfirmed(p))
    const anyTimeRows = anyTimePhones.map(p => {
      // pick the earliest confirmed cold row for display
      const arr = byPhoneAll.get(p) || []
      const cands = arr.filter(r => r.channelType==='confirmed' && isColdCalendar(r.calendar, rows.find(x=>x.id===r.id)?.content))
      const pick = cands.sort((a,b)=> new Date(a.addedTsUtc)-new Date(b.addedTsUtc))[0]
      return pick
    }).filter(Boolean).sort((a,b)=> new Date(a.addedTsUtc)-new Date(b.addedTsUtc))

    // Write collapsed table
    function timeCol(r){ return fmtTimeLocal(r.addedTsUtc, tz) }
    function rowLine(r){
      const name = r.name||''
      const phone = r.phone||''
      const link = r.permalink ? `<${r.permalink}>` : ''
      return `| ${timeCol(r)} | ${r.setter||'Unknown'} | ${name} | ${phone} | ${link} |`
    }

    const unconf = cold.filter(r=>r.channelType==='unconfirmed').sort((a,b)=> new Date(a.addedTsUtc)-new Date(b.addedTsUtc))
    const conf = cold.filter(r=>r.channelType==='confirmed').sort((a,b)=> new Date(a.addedTsUtc)-new Date(b.addedTsUtc))

    const collapsedMd = []
    collapsedMd.push(`# Cold SMS Appointments — Collapsed (${new Date(date).toDateString()}, Global timezone)\n`)
    collapsedMd.push('Rule: person_key = (setter, phone or normalized name). Keep only the latest post per person_key; EOD status is the channel of that latest post.')
    collapsedMd.push('Filter: Unconfirmed → include; Confirmed → include only if Calendar contains "cold sms" (case-insensitive).')
    collapsedMd.push('')
    collapsedMd.push('## Confirmed (Cold SMS only)')
    collapsedMd.push('| Time | Setter | Name | Phone | Permalink |')
    collapsedMd.push('|------|--------|------|-------|-----------|')
    for (const r of conf) collapsedMd.push(rowLine(r))
    collapsedMd.push('')
    collapsedMd.push('## Unconfirmed (always Cold SMS; chronological)')
    collapsedMd.push('| Time | Setter | Name | Phone | Permalink |')
    collapsedMd.push('|------|--------|------|-------|-----------|')
    for (const r of unconf) collapsedMd.push(rowLine(r))
    collapsedMd.push('')
    collapsedMd.push('## Totals (Cold SMS only)')
    collapsedMd.push(`- Confirmed: ${totals.confirmed}`)
    collapsedMd.push(`- Unconfirmed: ${totals.unconfirmed}`)
    collapsedMd.push(`- Unique person_keys: ${cold.length}`)
    fs.writeFileSync(path.join(outDir, 'cold-sms.appointments.collapsed.md'), collapsedMd.join('\n'))

    // Final report with tables per SOP
    const reportMd = []
    reportMd.push(`# Cold SMS Appointments Report — ${date} (${tz})\n`)
    reportMd.push('## Totals')
    reportMd.push('| Metric | Count |')
    reportMd.push('|--------|-------|')
    reportMd.push(`| Confirmed | ${totals.confirmed} |`)
    reportMd.push(`| Unconfirmed | ${totals.unconfirmed} |`)
    reportMd.push('')
    reportMd.push('## Setter report')
    reportMd.push('| Setter | Confirmed | Unconfirmed | Total |')
    reportMd.push('|--------|-----------|-------------|-------|')
    for (const s of perSetterArr) reportMd.push(`| ${s.setter} | ${s.confirmed} | ${s.unconfirmed} | ${s.total} |`)
    reportMd.push('')
    reportMd.push('## Collapsed appointments\n')
    reportMd.push('### Unconfirmed (chronological)')
    reportMd.push('| Time | Setter | Name | Phone | Permalink |')
    reportMd.push('|------|--------|------|-------|-----------|')
    for (const r of unconf) reportMd.push(rowLine(r))
    reportMd.push('')
    reportMd.push('### Confirmed (chronological)')
    reportMd.push('| Time | Setter | Name | Phone | Permalink |')
    reportMd.push('|------|--------|------|-------|-----------|')
    for (const r of conf) reportMd.push(rowLine(r))

    fs.writeFileSync(path.join(outDir, 'cold-sms.appointments.report.md'), reportMd.join('\n'))

    // Write structured JSON for formatters
    const reportJson = {
      date,
      timezone: tz,
      generatedAt: new Date().toISOString(),
      totals: {
        confirmed: totals.confirmed,
        unconfirmed: totals.unconfirmed
      },
      byOwner: perSetterArr.map(s => ({
        name: s.setter,
        confirmed: s.confirmed,
        unconfirmed: s.unconfirmed,
        notes: cold.filter(r => r.setter === s.setter).map(r => r.name || r.phone).filter(Boolean)
      })),
      appointments: cold.map(r => ({
        time: fmtTimeLocal(r.addedTsUtc, tz),
        setter: r.setter || 'Unknown',
        name: r.name || '',
        phone: r.phone || '',
        status: r.channelType,
        permalink: r.permalink || ''
      }))
    }
    fs.writeFileSync(path.join(outDir, 'cold-sms.report.json'), JSON.stringify(reportJson, null, 2))

    console.log('WROTE', path.join(outDir, 'appointments.raw.md'))
    console.log('WROTE', path.join(outDir, 'cold-sms.appointments.collapsed.md'))
    console.log('WROTE', path.join(outDir, 'cold-sms.appointments.report.md'))
    console.log('WROTE', path.join(outDir, 'cold-sms.report.json'))
  } catch (e) {
    const outDir = path.join(repoRoot, 'agents/appointment-tracking/outputs', date)
    ensureDir(outDir)
    fs.writeFileSync(path.join(outDir, 'error.log'), String(e.stack || e))
    console.error('ERROR:', e)
    process.exit(1)
  }
})()
