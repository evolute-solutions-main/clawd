#!/usr/bin/env node
// Runner for appointment-tracking using the shared Discord fetcher
import fs from 'node:fs'
import path from 'node:path'
import { fetchChannelWindow } from '../../_shared/discord-fetcher/index.mjs'
import { appointmentsDailyReport, CHANNELS } from './appointmentsDailyReport.mjs'

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
const date = dateArg ? dateArg.split('=')[1] : null
if (!date) {
  console.error('Usage: node agents/appointment-tracking/scripts/run.mjs --date=YYYY-MM-DD')
  process.exit(1)
}

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }) }

function parseZapierContent(content) {
  const out = {}
  // Name
  let m = content.match(/\*\*Name:\*\*\s*([^\n\r]+)/i)
  if (!m) m = content.match(/👤\s*\*\*Name:\*\*\s*([^\n\r]+)/i)
  out.name = m ? m[1].trim().replace(/\s+/g,' ') : undefined
  // Phone
  m = content.match(/\*\*Phone:\*\*\s*([+\d][\d\s()-]+)/i)
  out.phone = m ? m[1].trim().replace(/\s+/g,'') : undefined
  // Calendar (confirmed only)
  m = content.match(/\*\*Calendar:\*\*\s*([^\n\r]+)/i)
  out.calendar = m ? m[1].trim() : undefined
  // Time text
  m = content.match(/\*\*Time:\*\*\s*([^\n\r]+)/i)
  out.apptTimeText = m ? m[1].trim() : undefined
  // Setter: Zapier payload sometimes lacks Created by; default Unknown
  out.setter = 'Unknown'
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

    // Collapse per SOP with Cold SMS filter
    function normName(n){ return (n||'MISSING_NAME').replace(/\s+/g,' ').toLowerCase() }
    const byKey = new Map()
    for (const row of structured) {
      const key = `${row.setter||'Unknown'}||${row.phone ? row.phone : 'name:'+normName(row.name)}`
      const prev = byKey.get(key)
      if (!prev || new Date(row.addedTsUtc) > new Date(prev.addedTsUtc)) {
        byKey.set(key, row)
      }
    }
    const collapsedAll = Array.from(byKey.values())
    // Cold SMS filter
    const cold = collapsedAll.filter(r => r.channelType === 'unconfirmed' || (r.channelType === 'confirmed' && /cold\s*sms/i.test(r.calendar||'')))

    // Aggregate
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

    console.log('WROTE', path.join(outDir, 'appointments.raw.md'))
    console.log('WROTE', path.join(outDir, 'cold-sms.appointments.collapsed.md'))
    console.log('WROTE', path.join(outDir, 'cold-sms.appointments.report.md'))
  } catch (e) {
    const outDir = path.join(repoRoot, 'agents/appointment-tracking/outputs', date)
    ensureDir(outDir)
    fs.writeFileSync(path.join(outDir, 'error.log'), String(e.stack || e))
    console.error('ERROR:', e)
    process.exit(1)
  }
})()
