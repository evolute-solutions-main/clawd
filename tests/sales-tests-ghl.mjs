// sales-tests-ghl.mjs — Read-only test runner for 6 GHL-backed checks
// Usage examples (do NOT write to any sheets; prints JSON summaries):
//   node tests/sales-tests-ghl.mjs --from 2026-03-10 --to 2026-03-18
//   node tests/sales-tests-ghl.mjs --from 2026-02-01 --to 2026-03-18
//
// Requirements:
// - .secrets.env configured (GHL token + Google OAuth) — already set in this repo
// - Uses shared clients: agents/_shared/ghl/index.mjs and google-sheets/index.mjs
//
// Tests produced (read-only; no writes):
// 1) ghl_cancelled_updates_status           → want: "Cancelled/Rejected"
// 2) createdBy_setter_full_range            → all known setters across full date range
// 3) source_setter_consistency              → Cold SMS source cannot have Ads setter
// 4) showed_fathom_link                     → Showed status must have Fathom link
// 5) calendar_to_source_mapping_consistency → family vs sheet.Source
// 6) status_parity_with_ghl                 → included statuses parity

import '../agents/_shared/env-loader.mjs'
import { readSheet } from '../agents/_shared/google-sheets/index.mjs'
import * as GHL from '../agents/_shared/ghl/index.mjs'
import { SETTER_MAP } from '../agents/closing-tracker/lib/row-builder.mjs'

// Config
const SHEET_ID = '1lZzukpw0VTm-TZDBPzzNUW2hYK69nWlx1JsmF_BZ_yI'
const TAB_RANGE = "'All Booked Calls Data'!A1:R4000"

// CLI args
const argv = Object.fromEntries(process.argv.slice(2).map(s=>{
  const m = s.match(/^--([^=]+)=(.*)$/); if(m) return [m[1], m[2]]; return [s.replace(/^--/,''), true]
}))
const FROM = (typeof argv.from === 'string' ? argv.from : (typeof argv.f === 'string' ? argv.f : '2026-03-10'))
const TO   = (typeof argv.to   === 'string' ? argv.to   : (typeof argv.t === 'string' ? argv.t : '2026-03-18'))

// Helpers
function norm(s){ return (s||'').toString().trim().toLowerCase().replace(/\s+/g,' ') }
function mmddyyyy(ms){ const d=new Date(ms); const mm=String(d.getUTCMonth()+1).padStart(2,'0'); const dd=String(d.getUTCDate()).padStart(2,'0'); return `${mm}/${dd}/${d.getUTCFullYear()}` }
function yyyymmdd(ms){ const d=new Date(ms); const mm=String(d.getUTCMonth()+1).padStart(2,'0'); const dd=String(d.getUTCDate()).padStart(2,'0'); return `${d.getUTCFullYear()}-${mm}-${dd}` }
function parseUS(s){ if(!s) return null; const m=String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(!m) return null; const mm=m[1].padStart(2,'0'), dd=m[2].padStart(2,'0'), yyyy=m[3]; return `${mm}/${dd}/${yyyy}` }
function inWindowUS(usDate, fromIso, toIso){
  const [fm,fd,fy] = [fromIso.slice(5,7),fromIso.slice(8,10),fromIso.slice(0,4)]
  const [tm,td,ty] = [toIso.slice(5,7),toIso.slice(8,10),toIso.slice(0,4)]
  const f = Date.UTC(+fy,+fm-1,+fd)
  const t = Date.UTC(+ty,+tm-1,+td,23,59,59)
  if(!usDate) return false
  const [mm,dd,yyyy] = [usDate.slice(0,2), usDate.slice(3,5), usDate.slice(6,10)]
  const d = Date.UTC(+yyyy, +mm-1, +dd)
  return d>=f && d<=t
}
function mapFamilyToSource(fam){ return fam==='cold' ? 'cold sms' : 'ads' }

// Load sheet once
async function loadSheet(){
  const res = await readSheet({ spreadsheetId: SHEET_ID, range: TAB_RANGE })
  const rows = res.values||[]
  const header = rows[0]||[]
  const data = rows.slice(1).map((r,i)=>({ idx:i+2, r }))
  const headMap = Object.fromEntries(header.map((h,i)=>[h,i]))
  return { header, headMap, rows: data }
}

// Pull GHL in a day-loop (keeps code simple and reliable)
function* daysIter(fromIso,toIso){
  const f = Date.UTC(+fromIso.slice(0,4), +fromIso.slice(5,7)-1, +fromIso.slice(8,10))
  const t = Date.UTC(+toIso.slice(0,4), +toIso.slice(5,7)-1, +toIso.slice(8,10))
  for(let ms=f; ms<=t; ms+=86400000){ yield yyyymmdd(ms) }
}
async function loadGHLRange(fromIso,toIso){
  const calMap = { cold: GHL.CALENDARS.COLD_SMS, meta: GHL.CALENDARS.META_INBOUND }
  const out = []
  for (const day of daysIter(fromIso,toIso)){
    for (const [family, calId] of Object.entries(calMap)){
      const r = await GHL.getCalendarAppointments(calId, day)
      for (const a of r.appointments){
        out.push({
          family,
          day,                                  // YYYY-MM-DD
          dayUS: mmddyyyy(Date.parse(a.startTime)), // MM/DD/YYYY
          name: a.contactName||'',
          status: (a.status||'').toLowerCase(), // new/confirmed/showed/noshow/cancelled
          createdBy: (a.createdBy?.userId||'') || '',
          createdBySrc: a.createdBy?.source||''
        })
      }
    }
  }
  return out
}

// Find a matching row in the sheet by (date, family, lead fuzzy)
function findSheetRow(sheet, gh){
  return sheet.rows.find(x=>{
    const d = parseUS(x.r[0])
    if(!d || d!==gh.dayUS) return false
    // Accept any source if the row exists; mapping test checks source separately
    return norm(x.r[2]).includes(norm(gh.name))
  })
}

// Tests
async function t_cancelled(sheet, ghl){
  const targetLabel = 'Cancelled/Rejected'
  const cancelled = ghl.filter(a=>a.status==='cancelled')
  const issues=[]
  for(const a of cancelled){
    if(!inWindowUS(a.dayUS, FROM, TO)) continue
    const hit = findSheetRow(sheet, a)
    if(!hit){
      issues.push({ type:'missing_row', date:a.dayUS, name:a.name, source: mapFamilyToSource(a.family) })
    } else {
      const have = (hit.r[5]||'').toString()
      if(have.toLowerCase()!==targetLabel.toLowerCase()){
        issues.push({ type:'status_mismatch', row:hit.idx, date:hit.r[0], name:hit.r[2], have, want: targetLabel })
      }
    }
  }
  return { name:'ghl_cancelled_updates_status', total: cancelled.length, issues }
}

async function t_createdBy_setter(sheet, ghl){
  const issues=[]
  for(const a of ghl){
    if(!inWindowUS(a.dayUS, FROM, TO)) continue
    const expectedSetter = SETTER_MAP[a.createdBy]
    if(!expectedSetter) continue  // unknown userId, no assertion possible
    const hit = findSheetRow(sheet, a)
    if(!hit) continue
    const actual = (hit.r[4]||'').toString().trim()
    if(!actual){
      issues.push({ type:'blank_setter', row: hit.idx, date: hit.r[0], name: hit.r[2], want: expectedSetter, createdBy: a.createdBy })
    } else if(norm(actual) !== norm(expectedSetter)){
      issues.push({ type:'wrong_setter', row: hit.idx, date: hit.r[0], name: hit.r[2], have: actual, want: expectedSetter, createdBy: a.createdBy })
    }
  }
  return { name:'createdBy_setter_full_range', issues }
}

async function t_source_setter_consistency(sheet){
  const issues=[]
  for(const { idx, r } of sheet.rows){
    if(!inWindowUS(r[0], FROM, TO)) continue
    const src = norm(r[3])
    const setter = norm(r[4])
    if(src.includes('cold') && setter.includes('ads')){
      issues.push({ row: idx, date: r[0], name: r[2], source: r[3], setter: r[4] })
    }
  }
  return { name:'source_setter_consistency', issues }
}

async function t_showed_fathom_link(sheet){
  const issues=[]
  for(const { idx, r } of sheet.rows){
    if(!inWindowUS(r[0], FROM, TO)) continue
    const status = norm(r[5])
    const fathomLink = (r[13]||'').trim()
    if(status === 'showed' && !fathomLink){
      issues.push({ row: idx, date: r[0], name: r[2] })
    }
  }
  return { name:'showed_fathom_link', issues }
}

async function t_calendar_source_mapping(sheet, ghl){
  // GHL calendar names written to sheet are 'Cold SMS' (cold) and 'Meta Inbound' (meta),
  // but some rows were manually entered with 'Ads' for meta. Check by key term presence:
  // cold family → source must contain 'cold'; meta family → source must NOT contain 'cold'.
  const issues=[]
  for(const a of ghl){
    if(!inWindowUS(a.dayUS, FROM, TO)) continue
    const hit = findSheetRow(sheet, a)
    if(hit){
      const have = (hit.r[3]||'').toString()
      if(!have) continue
      const n = norm(have)
      const isColdSource = n.includes('cold')
      if(a.family === 'cold' && !isColdSource){
        issues.push({ row: hit.idx, date: hit.r[0], name: hit.r[2], have, want: 'Cold SMS', family: a.family })
      } else if(a.family === 'meta' && isColdSource){
        issues.push({ row: hit.idx, date: hit.r[0], name: hit.r[2], have, want: 'Meta Inbound', family: a.family })
      }
    }
  }
  return { name:'calendar_to_source_mapping_consistency', issues }
}

async function t_status_parity(sheet, ghl){
  const include = new Map([
    ['showed','Showed'],
    ['noshow','No-Show'],
    ['cancelled','Cancelled/Rejected'],
    ['rescheduled','Rescheduled']
  ])
  const findings=[]
  for(const a of ghl){
    if(!inWindowUS(a.dayUS, FROM, TO)) continue
    const want = include.get(a.status)
    if(!want) continue
    const hit = findSheetRow(sheet, a)
    if(hit){
      const have = (hit.r[5]||'').toString()
      if(norm(have)!==norm(want)){
        findings.push({ row: hit.idx, date: hit.r[0], name: hit.r[2], have, want })
      }
    }
  }
  return { name:'status_parity_with_ghl', issues: findings }
}

async function main(){
  const sheet = await loadSheet()
  const ghl = await loadGHLRange(FROM, TO)
  const out = []
  out.push(await t_cancelled(sheet, ghl))
  out.push(await t_createdBy_setter(sheet, ghl))
  out.push(await t_source_setter_consistency(sheet))
  out.push(await t_showed_fathom_link(sheet))
  out.push(await t_calendar_source_mapping(sheet, ghl))
  out.push(await t_status_parity(sheet, ghl))
  console.log(JSON.stringify({ ok:true, window:{ from:FROM, to:TO }, results: out }, null, 2))
}

main().catch(e=>{ console.error(JSON.stringify({ ok:false, error:e.message||String(e) })); process.exit(1) })
