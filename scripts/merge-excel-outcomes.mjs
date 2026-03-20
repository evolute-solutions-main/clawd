import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import XLSXpkg from 'xlsx'
const XLSX = XLSXpkg.default || XLSXpkg

const root = path.resolve(fileURLToPath(import.meta.url), '../../')
const EXCEL_PATH = '/Users/max/Downloads/Y_cleaned_v4.xlsx'
const APPTS_PATH = path.join(root, 'sales_data.json')

// ── helpers ──────────────────────────────────────────────────────────────────

function normName(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
}

function parseExcelDate(v) {
  if (v == null) return null
  if (typeof v === 'number') {
    const ms = Date.UTC(1899, 11, 30) + v * 86400000
    const d = new Date(ms)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
  }
  const s = String(v).trim()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`
  return null
}

// Exact match first, then shortest-contains
function fuzzyMatch(excelName, candidates) {
  const en = normName(excelName)
  if (!en) return null
  const exact = candidates.find(c => normName(c) === en)
  if (exact !== undefined) return exact
  const partial = candidates.filter(c => {
    const cn = normName(c)
    return cn && (cn.includes(en) || en.includes(cn))
  })
  if (partial.length === 0) return null
  return partial.sort((a, b) => normName(a).length - normName(b).length)[0]
}

// Excel Status + Outcome + Cash → unified status
function excelToStatus(excelStatus, outcome, cash, revenue) {
  const s = (excelStatus || '').trim().toLowerCase()
  if (s === 'cancelled/rejected' || s === 'rescheduled') return 'cancelled'
  if (s === 'no-show') return 'no_show'
  if (s === 'showed') {
    const o = (outcome || '').trim().toLowerCase()
    if (o.includes('follow-up') || o.includes('follow up')) return 'not_closed'
    const c = parseFloat(String(cash).replace(/[^0-9.]/g, '')) || 0
    const r = parseFloat(String(revenue).replace(/[^0-9.]/g, '')) || 0
    return (c > 0 || r > 0) ? 'closed' : 'not_closed'
  }
  return null
}

// GHL status → unified status (for appointments not in Excel)
function ghlToStatus(appointmentStatus) {
  switch ((appointmentStatus || '').toLowerCase()) {
    case 'new':       return 'new'
    case 'confirmed': return 'confirmed'
    case 'cancelled': return 'cancelled'
    case 'noshow':    return 'no_show'
    default:          return null
  }
}

function toNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''))
  return isNaN(n) ? null : n
}

function toBool(v) {
  const s = (v || '').toString().trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

// Source → calendarName for synthetic records
function sourceToCalendar(source) {
  const s = (source || '').toLowerCase()
  if (s.includes('cold')) return 'Cold SMS'
  return 'AI Strategy Session (Meta Inbound)'
}

// Deterministic ID for synthetic Excel-only records
function syntheticId(date, name) {
  return 'xl_' + date + '_' + normName(name).replace(/\s+/g, '_').slice(0, 20)
}

// ── manual match overrides (date + excelName → GHL id) ───────────────────────
const MANUAL_MATCHES = {
  '2026-03-09|joe': 'zZ6Xm8DF3yVl5bhQqh6s', // Joe = jcontractor63@gmail.com
}

// Hard-coded overrides for closed deals confirmed by Max but missing from Excel
const MANUAL_CLOSED = [
  {
    id:              'vjaKYpBlY30Fy5UVoZXk', // Jesus, 03/06, Cold SMS
    status:          'closed',
    closer:          'Max',
    cashCollected:   2000,
    contractRevenue: 8000,
    fathomLink:      'https://fathom.video/share/cjzp2QcrxquezX_2Py6VceEjC2ZofvDF',
    followUpBooked:  false,
  },
  {
    id:              'okXIUeB2jYr34FELkxC2', // Mike Baruh, 03/02, Meta Inbound (GHL record)
    status:          'closed',
    closer:          'Max',
    cashCollected:   1000,
    cashCollectedAfterFirstCall: null,
    contractRevenue: 1000,
    fathomLink:      'https://fathom.video/share/wNfmSM5DQxw5K62or9Ga9vEwzBxEjkzs',
    followUpBooked:  false,
  },
]

// GHL record IDs to drop (duplicates / not real sales calls)
const DEDUPE_DROP = new Set([
  'tLFHa2M2TkmNBopYkV2O', // Dan Sullivan 03/02 — exact duplicate, both cancelled
  '4VZYc4Bzq1Fxxo7frz1g', // Jim 03/12 — rebook duplicate, treat as cancelled
  'gCVCtVwVhmRuHSLJHvmg', // 03/11 HighLevel promo event — not a sales call
  'eAAaYtSv5UJ7S1DEEHj8', // 03/05 blank name — not a real record
  'u1CKKVSjRigNhy18AWKR', // 03/09 blank name — not a real record
  'uk6dTZIaRkuctpQ9wKn7', // 03/13 blank name — not a real record
  'p2zG50reiRKDJZTtZpbY', // 03/14 blank name — not a real record
  'fjWuor3SUigRPzdCNJCI', // 01/12 "Mike" — duplicate of xl_manual_mike_webster (Mike Braymiller)
])

// Manual status overrides for GHL appts not in Excel (confirmed by Max)
const MANUAL_STATUS = {
  // ── January 2026 — confirmed by Max ──
  'jaJkn41lru63chhIpSwF': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Lee Group Group 01/08
  'v0Vf1mn7prD1cosKofkB': { status: 'no_show' },                                          // Stephen Villard 01/08
  'GIkcdCa4zUHSy0rztLBy': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Max Contractors 01/16
  'd5OgdTzkDnPLuQKntvDn': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Daniel Fabrication 01/19
  '9FKdliYQC7VivY0Bqdbk': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Andres Flooring 01/20
  'YndEKwd4vnEVP7QFLQi9': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Josh 01/20
  'GtZqT0aPAcZX61I8ukHw': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Joe 01/29
  'iG4JTVvwwhpNj27OTAAM': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Bryan Tnuch 01/29
  // ── showed, not closed ──
  'IqSahY5kLmmRZVZxMqq9': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Skip 03/06
  'QsDCkpffK9pBaSa5Ti9W': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Marcus 03/09
  'KlHCjGuXEkJlGUgsG6vE': { status: 'not_closed', closer: 'Max', followUpBooked: false }, // Tyrone Smith 03/18
  // cancelled (name has "Canceled" in it)
  '8gP12W3nZFEZu1a9RoSo': { status: 'cancelled' }, // Amit Schilgi 03/02
  // no-show (confirmed by Max)
  '1i4Khjr3bck9BWz0gez4': { status: 'no_show' }, // Charles Niesen 03/10 (Excel has 03/12)
  '244OaC8xYxx72D41FOJS': { status: 'no_show' }, // Hugh Elder 03/03
  'RgRRp8I2MpHafMwAKBDV': { status: 'no_show' }, // Michelle Nicholson 03/03
  'xZOEx39K80c5STShGOTm': { status: 'no_show' }, // Jeff Kaemmerer 03/04
  'PVAMjxb7FMD6bXVhnvIw': { status: 'no_show' }, // Ozvaldo 03/04
  'nYKLYtIQBYqmNyxKvzCT': { status: 'no_show' }, // Tim O 03/04
  'Z9IgwGFAsmvXFBj6qY8i': { status: 'no_show' }, // John 03/04
  'dP3N5IP5C5ZjQapJyZSo': { status: 'no_show' }, // Emmanuel Nila 03/04
  'kg4I8hUOUCwD2ImtYWNa': { status: 'no_show' }, // Brandon 03/05
  'MOvMXLJHnvGaC6H7HIUk': { status: 'no_show' }, // Jovarn Shannon 03/06
  'TVjl85uVQlZSPs0rT1ry': { status: 'no_show' }, // Carlos Almeida 03/06
  '0ZmBtf8NuzT4iS6cyBXN': { status: 'no_show' }, // Martin 03/06
  'OcwhpyQVCESEHmYgaNUr': { status: 'no_show' }, // James Hightower 03/06
  'fjHvruvwHLc70AW6MSLx': { status: 'no_show' }, // Sergio 03/07
  '6zvZ21FFklyEojP7vHPR': { status: 'no_show' }, // David Garrett 03/09
  'fitmrq7hDjEepwFeO0rO': { status: 'no_show' }, // Igor Bb 03/09
  'wtSFFkdjLPRdHuToQw7g': { status: 'no_show' }, // Carlos 03/09
  'd6ub7yaLRMLxbVqe8Gcd': { status: 'no_show' }, // Juan 03/10
  '1r3BhpSuvrir1NLkF07Q': { status: 'no_show' }, // Ivan Vucetic 03/10
  'C8EeJzrgn8AX2KqrBORX': { status: 'no_show' }, // Jason 03/10
  'KBaRxBFfLLiAzVozDtTU': { status: 'no_show' }, // Dennis Kohlmeier 03/10
  'aMgPOxnjIZEFt8yZfqmo': { status: 'no_show' }, // Ron 03/13
  'ZnQ9dpYj2d8aZAGvUcbt': { status: 'no_show' }, // AJ 03/14
  'NrPfknrKAqLtZ3eq7UEy': { status: 'no_show' }, // Shaun 03/16
  'SNeCjAOZ76QF4qipMaSj': { status: 'no_show' }, // Adam Hutchins 03/16
  'kPVTnG8y1iQGunWOh1iF': { status: 'no_show' }, // Erlis Vushaj 03/16
  'nuwMz0NQRH8Rf5IfNkZX': { status: 'no_show' }, // Jay Hudson 03/16
  'NfmhCW8cfMYZMPYF2wZ5': { status: 'no_show' }, // Bob 03/17
  'KerOOFU2tcAdElYKPMqq': { status: 'no_show' }, // Kenneth Schwartz 03/17
  'y7273AnpYEntm0RFtOC2': { status: 'no_show' }, // Tracy 03/17
  'HgSKgEneQwXkvGlyLZfo': { status: 'no_show' }, // Steve Nelson 03/18
  'YylFDXke2M2yVvSWVwOY': { status: 'no_show' }, // BD Nickerson 03/18
  'S18Ap7GzfzIjtXej21Au': { status: 'no_show' }, // Raad 03/18
  'foc5heQ4JnB9x9KfQma3': { status: 'no_show' }, // Dani Naor 03/18
  'X1zAySUoAmY899Rv5tI5': { status: 'no_show' }, // Brian 03/18
}

// Field-level corrections to synthetic (Excel-sourced) records, keyed by synthetic id
// Use when Stripe data reveals the Excel cashCollected was wrong
const FIELD_CORRECTIONS = {
  'xl_2026-02-16_mullineaux_glenn': {
    cashCollected:               1200, // first call only (02/17 Stripe)
    cashCollectedAfterFirstCall: 2400, // 03/03 $1200 + 03/10 $1200
  },
  'xl_2026-02-14_kenneth_hewitt': {
    cashCollected:               1300, // first call (02/19 fourseasonsdesignbuild Stripe)
    cashCollectedAfterFirstCall: 2700, // 03/06 $1600 + $1100
  },
}

// Fully manual synthetic records — confirmed closes with no GHL or Excel entry
const MANUAL_SYNTHETIC = [
  {
    id:                          'xl_manual_mike_aiello',
    contactName:                 'Mike Aiello',
    calendarName:                'Cold SMS',
    startTime:                   '2026-02-02T09:00:00-05:00',
    timeCreated:                 null,
    appointmentStatus:           'showed',
    createdBy:                   '',
    phone:                       '',
    email:                       'mike@prestigehomeremodeling.com',
    statusHistory:               [],
    status:                      'closed',
    closer:                      'Max',
    cashCollected:               2000,
    cashCollectedAfterFirstCall: 500,
    contractRevenue:             4000,
    offerMade:                   null,
    followUpBooked:              false,
    fathomLink:                  'https://fathom.video/share/LCkk45kjSAond8o45MbDUF3_61a-EZF2',
  },
  {
    id:                          'xl_manual_sean_youn',
    contactName:                 'Sean Youn',
    calendarName:                'Cold SMS',
    startTime:                   '2026-02-24T09:00:00-05:00',
    timeCreated:                 null,
    appointmentStatus:           'showed',
    createdBy:                   '',
    phone:                       '',
    email:                       'info@clevelandpropainters.com',
    statusHistory:               [],
    status:                      'closed',
    closer:                      'Max',
    cashCollected:               1000,
    cashCollectedAfterFirstCall: null,
    contractRevenue:             4800,
    offerMade:                   null,
    followUpBooked:              false,
    fathomLink:                  'https://fathom.video/share/cJPmyXrcqSgy_5tGojszCHi4-7kSt3xk',
  },
  {
    id:                          'xl_manual_mike_webster',
    contactName:                 'Mike Webster',
    calendarName:                'Cold SMS',
    startTime:                   '2026-01-12T09:00:00-05:00',
    timeCreated:                 null,
    appointmentStatus:           'showed',
    createdBy:                   '',
    phone:                       '',
    email:                       'mikewebster@braymillerbuilders.com',
    statusHistory:               [],
    status:                      'closed',
    closer:                      'Max',
    cashCollected:               2000,
    cashCollectedAfterFirstCall: 2000,
    contractRevenue:             4000,
    offerMade:                   null,
    followUpBooked:              false,
    fathomLink:                  'https://fathom.video/share/kAjrnq4M2x1zgj_WBSVZtmUhxHB51ig3',
  },
  {
    id:                          'xl_manual_jake_eco_concrete',
    contactName:                 'Jake',
    calendarName:                'Cold SMS',
    startTime:                   '2026-01-14T09:00:00-05:00',
    timeCreated:                 null,
    appointmentStatus:           'showed',
    createdBy:                   '',
    phone:                       '',
    email:                       'Ecoconcretedesign@gmail.com',
    statusHistory:               [],
    status:                      'closed',
    closer:                      'Max',
    cashCollected:               500,
    cashCollectedAfterFirstCall: 500,
    contractRevenue:             1000,
    offerMade:                   null,
    followUpBooked:              false,
    fathomLink:                  'https://fathom.video/share/diGfqm3EYizskoqTn4-5kNrRSUshT_tX',
  },
]

// ── load data ─────────────────────────────────────────────────────────────────

const wb = XLSX.readFile(EXCEL_PATH)
const ws = wb.Sheets['All Booked Calls']
if (!ws) throw new Error('Sheet "All Booked Calls" not found in ' + EXCEL_PATH)

const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false })
const excelRows = aoa.slice(1) // drop header

const appts = JSON.parse(fs.readFileSync(APPTS_PATH, 'utf8'))

// ── reset merged fields + remove previous synthetic records (idempotent) ──────

const MERGED_FIELDS = ['status','closer','cashCollected','cashCollectedAfterFirstCall','contractRevenue','offerMade','followUpBooked','fathomLink']
const manualIds = new Set(MANUAL_SYNTHETIC.map(r => r.id))
const ghlAppts = appts.filter(a => !a.id.startsWith('xl_') && !manualIds.has(a.id) && !DEDUPE_DROP.has(a.id))
for (const a of ghlAppts) { for (const f of MERGED_FIELDS) delete a[f] }

// ── build date → appt[] index ─────────────────────────────────────────────────

const byDate = new Map()
for (const a of ghlAppts) {
  const date = a.startTime.slice(0, 10)
  if (!byDate.has(date)) byDate.set(date, [])
  byDate.get(date).push(a)
}

const byId = new Map(ghlAppts.map(a => [a.id, a]))

// ── match & merge all Excel rows ──────────────────────────────────────────────

let matched = 0
let synthetic = 0
const unmatchedShowed = []
const syntheticRecords = []

for (const row of excelRows) {
  const date        = parseExcelDate(row[0])
  if (!date) continue
  const excelName   = row[2]
  const excelStatus = row[6]
  const cash        = row[9]
  const revenue     = row[10]

  const group = byDate.get(date) || []
  const matchedName = fuzzyMatch(excelName, group.map(a => a.contactName))
  const manualId    = MANUAL_MATCHES[`${date}|${normName(excelName)}`]

  let appt = null
  if (matchedName !== null) {
    appt = group.find(a => normName(a.contactName) === normName(matchedName))
      ?? group.find(a => {
        const cn = normName(a.contactName), en = normName(excelName)
        return cn && (cn.includes(en) || en.includes(cn))
      })
  }
  if (!appt && manualId) appt = byId.get(manualId) ?? null

  // followUpBooked: explicit col 11 OR outcome = "Follow-up required"
  const followUpCol = (row[11] || '').toString().trim().toLowerCase()
  const outcome     = (row[7] || '').toString().trim().toLowerCase()
  const followUpBooked = followUpCol === 'true' || followUpCol === '1' || followUpCol === 'yes'
    || outcome.includes('follow-up') || outcome.includes('follow up')

  const mergedFields = {
    status:                     excelToStatus(excelStatus, row[7], cash, revenue),
    closer:                     row[8]  || null,
    cashCollected:              toNum(cash),
    cashCollectedAfterFirstCall: null,
    contractRevenue:            toNum(revenue),
    offerMade:                  row[12] != null && row[12] !== '' ? row[12] : null,
    followUpBooked,
    fathomLink:                 row[14] || null,
  }

  if (appt) {
    // Fix empty name from manual match
    if (!appt.contactName && manualId) appt.contactName = excelName
    Object.assign(appt, mergedFields)
    matched++
  } else {
    // No GHL record — create synthetic entry from Excel data
    const id = syntheticId(date, excelName)
    const calendarName = sourceToCalendar(row[4])
    syntheticRecords.push({
      id,
      contactName:       excelName || '',
      calendarName,
      startTime:         date + 'T09:00:00-05:00', // no time in Excel, default to 9am
      timeCreated:       null,
      appointmentStatus: excelStatus || '',
      createdBy:         row[5] || '',
      phone:             '',
      email:             '',
      statusHistory:     [],
      ...mergedFields,
    })
    synthetic++
  }
}

// ── apply manual closed overrides ────────────────────────────────────────────

for (const override of MANUAL_CLOSED) {
  const appt = byId.get(override.id)
  if (!appt) { console.warn('MANUAL_CLOSED: id not found:', override.id); continue }
  const { id: _, ...fields } = override
  Object.assign(appt, { cashCollectedAfterFirstCall: null, offerMade: null, ...fields })
}

// ── assign status to GHL appts with no Excel match ────────────────────────────

for (const a of ghlAppts) {
  if (a.status !== undefined) continue
  const s = ghlToStatus(a.appointmentStatus)
  if (s !== null) {
    a.status = s
  } else {
    unmatchedShowed.push({ id: a.id, name: a.contactName, date: a.startTime.slice(0, 10) })
    a.status = 'showed'
  }
}

// ── apply manual status overrides (GHL appts not in Excel) ───────────────────

for (const [id, fields] of Object.entries(MANUAL_STATUS)) {
  const appt = byId.get(id)
  if (!appt) { console.warn('MANUAL_STATUS: id not found:', id); continue }
  Object.assign(appt, fields)
}

// ── apply field corrections to synthetic records ──────────────────────────────

for (const [id, corrections] of Object.entries(FIELD_CORRECTIONS)) {
  const rec = syntheticRecords.find(r => r.id === id)
  if (!rec) { console.warn('FIELD_CORRECTIONS: id not found:', id); continue }
  Object.assign(rec, corrections)
}

// ── write back ────────────────────────────────────────────────────────────────

// Sort all records by startTime
const allAppts = [
  ...ghlAppts,
  ...syntheticRecords,
  ...MANUAL_SYNTHETIC,
].sort((a, b) => a.startTime.localeCompare(b.startTime))

fs.writeFileSync(APPTS_PATH, JSON.stringify(allAppts, null, 2))

// ── summary ───────────────────────────────────────────────────────────────────

const statusBreakdown = {}
for (const a of allAppts) statusBreakdown[a.status] = (statusBreakdown[a.status] || 0) + 1

const totalCash = allAppts.reduce((s, a) => s + (a.cashCollected || 0), 0)
const totalRev  = allAppts.reduce((s, a) => s + (a.contractRevenue || 0), 0)

console.log(JSON.stringify({
  excelRowsTotal: excelRows.length,
  matchedToGHL: matched,
  syntheticAdded: synthetic,
  unmatchedShowedGHL: unmatchedShowed,
  statusBreakdown,
  totalCashCollected: totalCash,
  totalContractRevenue: totalRev,
}, null, 2))
