/**
 * lib/metrics.mjs — Evolute canonical metrics library
 *
 * Pure functions only. No Node.js deps. Works in both Node (imported by query.mjs)
 * and browser (inlined by inject-and-open.mjs).
 *
 * All functions accept raw arrays + opts and return plain objects.
 * Nothing here reads files or touches the DOM.
 */

// ── Source detection ──────────────────────────────────────────────────────────
// appt.source (manually set) takes priority over calendarName inference.
// Valid source values: 'Cold SMS', 'Ads', 'Referral', 'Organic'
export function isColdSMS(appt) {
  if (appt.source) return appt.source === 'Cold SMS'
  return !!(appt.calendarName?.toLowerCase().includes('cold'))
}
export function isAds(appt) {
  if (appt.source) return appt.source === 'Ads'
  return !!(appt.calendarName && !appt.calendarName.toLowerCase().includes('cold'))
}

// ── Date helpers ──────────────────────────────────────────────────────────────
export function parseDate(s) {
  if (!s) return null
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  return null
}

export function inWindow(dateStr, from, to) {
  const d = parseDate(dateStr)
  if (!d) return false
  if (from && d < from) return false
  if (to   && d > to)   return false
  return true
}

// ── Array filters ─────────────────────────────────────────────────────────────
export function filterAppts(appointments, { from, to, source } = {}) {
  return appointments.filter(a => {
    if (!inWindow(a.startTime, from, to)) return false
    if (!source) return true
    const s = source.toLowerCase()
    if (s === 'ads' || s === 'ad') return isAds(a)
    if (s === 'cold sms' || s === 'sms' || s === 'cold_sms') return isColdSMS(a)
    return true
  })
}

export function filterExpenses(expenses, { from, to, source, excludeCAC = false } = {}) {
  return expenses.filter(e => {
    const d = e.date || e.dateFrom || ''
    if (!inWindow(d, from, to)) return false
    if (excludeCAC && e.excludeFromCAC) return false
    if (e.amount <= 0) return false
    if (!source) return true
    const s = source.toLowerCase()
    if (s === 'ads' || s === 'ad') return e.channel === 'ads'
    if (s === 'cold sms' || s === 'sms' || s === 'cold_sms') return e.channel === 'cold_sms'
    return true
  })
}

// ── Metric: revenue ───────────────────────────────────────────────────────────
export function computeRevenue(appointments, { from, to, source } = {}) {
  const appts     = filterAppts(appointments, { from, to, source })
  const closed    = appts.filter(a => a.status === 'closed')
  const showed    = appts.filter(a => ['showed','closed','not_closed'].includes(a.status))
  const noShow    = appts.filter(a => a.status === 'no_show')
  const cancelled = appts.filter(a => a.status === 'cancelled')

  const cashCollected    = closed.reduce((s,a) => s + (a.cashCollected||0), 0)
  const cashAfter        = closed.reduce((s,a) => s + (a.cashCollectedAfterFirstCall||0), 0)
  const totalCash        = cashCollected + cashAfter
  const contractRevenue  = closed.reduce((s,a) => s + (a.contractRevenue||0), 0)

  const byMonth = {}
  for (const a of closed) {
    const m = a.startTime.slice(0,7)
    if (!byMonth[m]) byMonth[m] = { cash: 0, contractRevenue: 0, closes: 0 }
    byMonth[m].cash             += (a.cashCollected||0) + (a.cashCollectedAfterFirstCall||0)
    byMonth[m].contractRevenue  += (a.contractRevenue||0)
    byMonth[m].closes++
  }

  const sc = [...closed].sort((a,b) => a.startTime.localeCompare(b.startTime))
  let cum = 0
  const cumulative = sc.map(a => {
    cum += (a.cashCollected||0) + (a.cashCollectedAfterFirstCall||0)
    return { date: a.startTime.slice(0,10), cash: cum, name: a.contactName }
  })

  return {
    metric: 'revenue',
    window: { from, to, source: source || 'all' },
    booked:    appts.length,
    showed:    showed.length,
    closed:    closed.length,
    noShow:    noShow.length,
    cancelled: cancelled.length,
    cashCollected:   Math.round(cashCollected   * 100) / 100,
    cashAfter:       Math.round(cashAfter        * 100) / 100,
    totalCash:       Math.round(totalCash        * 100) / 100,
    contractRevenue: Math.round(contractRevenue  * 100) / 100,
    avgDeal:         closed.length ? Math.round(contractRevenue / closed.length) : 0,
    avgCashPerClose: closed.length ? Math.round(totalCash / closed.length) : 0,
    collectionRate:  contractRevenue > 0 ? totalCash / contractRevenue : 0,
    byMonth,
    cumulative,
  }
}

// ── Metric: show-rate ─────────────────────────────────────────────────────────
export function computeShowRate(appointments, { from, to, source } = {}) {
  const appts     = filterAppts(appointments, { from, to, source })
  const showed    = appts.filter(a => ['showed','closed','not_closed'].includes(a.status))
  const noShow    = appts.filter(a => a.status === 'no_show')
  const cancelled = appts.filter(a => a.status === 'cancelled')
  const denom     = showed.length + noShow.length + cancelled.length
  const showRate  = denom ? showed.length / denom : null

  // by setter
  const setters = {}
  for (const a of appts) {
    const setter = a.createdBy || 'Unknown'
    if (!setters[setter]) setters[setter] = { booked: 0, showed: 0, noShow: 0, cancelled: 0 }
    setters[setter].booked++
    if (['showed','closed','not_closed'].includes(a.status)) setters[setter].showed++
    if (a.status === 'no_show')   setters[setter].noShow++
    if (a.status === 'cancelled') setters[setter].cancelled++
  }
  const bySetter = Object.entries(setters).map(([setter, s]) => {
    const d = s.showed + s.noShow + s.cancelled
    return { setter, booked: s.booked, showed: s.showed, noShow: s.noShow, cancelled: s.cancelled,
             showRate: d ? +(s.showed/d).toFixed(3) : null }
  }).sort((a,b) => (b.showed||0) - (a.showed||0))

  return {
    metric: 'show-rate',
    window: { from, to, source: source || 'all' },
    showed: showed.length, noShow: noShow.length, cancelled: cancelled.length, denom,
    showRate:    showRate !== null ? +showRate.toFixed(3) : null,
    showRatePct: showRate !== null ? +(showRate * 100).toFixed(1) + '%' : null,
    bySetter,
  }
}

// ── Metric: CAC ───────────────────────────────────────────────────────────────
export function computeCAC(appointments, expenses, { from, to, source } = {}) {
  const appts  = filterAppts(appointments, { from, to, source })
  const closed = appts.filter(a => a.status === 'closed').length
  const spend  = filterExpenses(expenses, { from, to, source, excludeCAC: true })
    .reduce((s,e) => s + e.amount, 0)

  return {
    metric: 'cac',
    window: { from, to, source: source || 'all' },
    closes: closed,
    spend:  Math.round(spend * 100) / 100,
    cac:    closed ? Math.round(spend / closed * 100) / 100 : null,
  }
}

// ── Metric: ROAS ──────────────────────────────────────────────────────────────
export function computeROAS(appointments, expenses, { from, to, source } = {}) {
  const appts = filterAppts(appointments, { from, to, source })
  const cash  = appts.filter(a => a.status === 'closed')
    .reduce((s,a) => s + (a.cashCollected||0) + (a.cashCollectedAfterFirstCall||0), 0)
  const spend = filterExpenses(expenses, { from, to, source, excludeCAC: true })
    .reduce((s,e) => s + e.amount, 0)
  const roas  = spend ? cash / spend : null

  return {
    metric: 'roas',
    window: { from, to, source: source || 'all' },
    cashCollected: Math.round(cash  * 100) / 100,
    spend:         Math.round(spend * 100) / 100,
    roas:  roas !== null ? +roas.toFixed(3) : null,
    roasX: roas !== null ? +roas.toFixed(2) + 'x' : null,
  }
}

// ── Metric: P&L ───────────────────────────────────────────────────────────────
export function computePL(transactions, expenses, { from, to } = {}) {
  const txns = transactions.filter(t => t.date && inWindow(t.date, from, to))
  const exps = expenses.filter(e => {
    const d = e.date || e.dateFrom || ''
    return d && inWindow(d, from, to) && e.amount > 0
  })

  const revenue  = txns.reduce((s,t)  => s + (parseFloat(String(t.amount).replace(/[$,]/g,''))||0), 0)
  const totalExp = exps.reduce((s,e)  => s + e.amount, 0)
  const profit   = revenue - totalExp

  const months = {}
  for (const t of txns) {
    const m = t.date.slice(0,7)
    if (!months[m]) months[m] = { month: m, revenue: 0, expenses: 0 }
    months[m].revenue += parseFloat(String(t.amount).replace(/[$,]/g,''))||0
  }
  for (const e of exps) {
    const d = e.date || e.dateFrom || ''
    const m = d.slice(0,7)
    if (!months[m]) months[m] = { month: m, revenue: 0, expenses: 0 }
    months[m].expenses += e.amount
  }
  const byMonth = Object.values(months)
    .map(m => ({ ...m,
      revenue:  +m.revenue.toFixed(2),
      expenses: +m.expenses.toFixed(2),
      profit:   +(m.revenue - m.expenses).toFixed(2),
    }))
    .sort((a,b) => a.month.localeCompare(b.month))

  return {
    metric:   'p&l',
    window:   { from, to },
    revenue:  +revenue.toFixed(2),
    expenses: +totalExp.toFixed(2),
    profit:   +profit.toFixed(2),
    margin:   revenue ? +(profit/revenue*100).toFixed(1) + '%' : null,
    byMonth,
  }
}

// ── Metric: LTV ───────────────────────────────────────────────────────────────
export function computeLTV(transactions) {
  const buckets = {}
  for (const t of transactions) {
    const key = (t.name || t.email || '').toLowerCase().trim()
    if (!key) continue
    if (!buckets[key]) buckets[key] = { name: t.name || t.email, emails: new Set(), total: 0, payments: 0 }
    buckets[key].total    += parseFloat(String(t.amount).replace(/[$,]/g,''))||0
    buckets[key].payments += 1
    if (t.email) buckets[key].emails.add(t.email.toLowerCase())
  }
  const clients = Object.values(buckets)
    .map(b => ({ name: b.name, emails: [...b.emails], total: +b.total.toFixed(2), payments: b.payments }))
    .sort((a,b) => b.total - a.total)
  const totalRevenue = clients.reduce((s,c) => s + c.total, 0)

  return {
    metric: 'ltv',
    clientCount:  clients.length,
    totalRevenue: +totalRevenue.toFixed(2),
    avgLTV:       clients.length ? +(totalRevenue / clients.length).toFixed(2) : 0,
    clients,
  }
}

// ── Metric: funnel (per channel) ──────────────────────────────────────────────
export function computeFunnel(appointments, expenses, dials, { from, to, source } = {}) {
  const appts     = filterAppts(appointments, { from, to, source })
  const confirmed = appts.filter(a => a.status !== 'new')
  const showed    = appts.filter(a => ['closed','not_closed','showed'].includes(a.status))
  const noShowed  = appts.filter(a => a.status === 'no_show')
  const cancelled = appts.filter(a => a.status === 'cancelled')
  const closed    = appts.filter(a => a.status === 'closed')

  const showDenom = showed.length + noShowed.length + cancelled.length
  const showRate  = showDenom  > 0 ? showed.length  / showDenom      : 0
  const confRate  = appts.length  > 0 ? confirmed.length / appts.length : 0
  const closeRate = showed.length > 0 ? closed.length    / showed.length : 0

  const totalCash = closed.reduce((s,a) => s + (a.cashCollected||0) + (a.cashCollectedAfterFirstCall||0), 0)
  const avgCC     = closed.length > 0 ? closed.reduce((s,a) => s + (a.cashCollected||0), 0) / closed.length : 0
  const avgLTV    = closed.length > 0 ? totalCash / closed.length : 0

  const spend = filterExpenses(expenses, { from, to, source, excludeCAC: true })
    .reduce((s,e) => s + e.amount, 0)

  const cpB    = appts.length    > 0 ? spend / appts.length    : 0
  const cpCo   = confirmed.length > 0 ? spend / confirmed.length : 0
  const cpS    = showed.length    > 0 ? spend / showed.length    : 0
  const cac    = closed.length    > 0 ? spend / closed.length    : 0
  const ltv    = cac > 0 ? avgLTV / cac : 0
  const roi    = spend > 0 ? totalCash / spend : 0

  // dials (Cold SMS only)
  const src = (source||'').toLowerCase()
  const isSMS = src === 'cold sms' || src === 'sms' || src === 'cold_sms'
  const totalDials = isSMS ? dials.filter(d => inWindow(d.date, from, to))
    .reduce((s,d) => s + (d.dials||0), 0) : null
  const cpDial = (totalDials && totalDials > 0 && spend > 0) ? spend / totalDials : 0

  return {
    source:    source || 'all',
    booked:    appts.length,
    confirmed: confirmed.length,
    showed:    showed.length,
    noShow:    noShowed.length,
    cancelled: cancelled.length,
    closed:    closed.length,
    confRate, showRate, closeRate,
    totalCash: Math.round(totalCash), spend: Math.round(spend),
    avgCC:  Math.round(avgCC),  avgLTV: Math.round(avgLTV),
    cpB:    Math.round(cpB),    cpCo:   Math.round(cpCo),
    cpS:    Math.round(cpS),    cac:    Math.round(cac),
    ltv:    +ltv.toFixed(2),    roi:    +roi.toFixed(2),
    dials:  totalDials,         cpDial: Math.round(cpDial),
  }
}

// ── Metric: setters ───────────────────────────────────────────────────────────
const SETTER_NAME_MAP = {
  'Randy':  ['Randy Ray Nadera','RANDY RAY DOLON NADERA'],
  'Eddie':  ['Eddie Stiwar Murillo Becerra'],
  'Daniel': ['Daniel Franco'],
}

export function computeSetters(appointments, expenses, dials, { from, to } = {}) {
  const appts = filterAppts(appointments, { from, to })
  const data  = {}

  for (const a of appts) {
    const s = (a.createdBy||'').trim()
    if (!s || s.toLowerCase().includes('ads') || s.toLowerCase().includes('no setter') || s === 'Max') continue
    if (!data[s]) data[s] = { booked:0, called:0, noShow:0, closed:0, cancelled:0, confirmed:0, unconfirmed:0, spend:0, cash:0, contractRevenue:0, dials:0 }
    data[s].booked++
    if (['closed','not_closed','showed'].includes(a.status)) data[s].called++
    if (a.status === 'no_show')   data[s].noShow++
    if (a.status === 'cancelled') data[s].cancelled++
    if (a.status !== 'new')       data[s].confirmed++
    if (a.status === 'new')       data[s].unconfirmed++
    if (a.status === 'closed') {
      data[s].closed++
      data[s].cash            += (a.cashCollected||0) + (a.cashCollectedAfterFirstCall||0)
      data[s].contractRevenue += (a.contractRevenue||0)
    }
  }

  // wire in setter spend from expenses
  for (const [shortName, fullNames] of Object.entries(SETTER_NAME_MAP)) {
    if (!data[shortName]) continue
    data[shortName].spend = expenses
      .filter(e => fullNames.includes(e.vendor) && e.department === 'Setter')
      .filter(e => inWindow(e.date || e.dateFrom || '', from, to))
      .reduce((s,e) => s + (e.amount||0), 0)
  }

  // wire in dials
  for (const d of dials) {
    if (!inWindow(d.date, from, to)) continue
    const matchKey = Object.keys(data).find(k => {
      const map = SETTER_NAME_MAP[k]
      return (Array.isArray(map) ? map.includes(d.setter) : map === d.setter) || k === d.setter
    })
    if (matchKey) data[matchKey].dials += (d.dials||0)
  }

  const setters = Object.entries(data).map(([name, s]) => {
    const showDenom = s.called + s.noShow + s.cancelled
    return {
      name,
      booked:         s.booked,
      called:         s.called,
      noShow:         s.noShow,
      closed:         s.closed,
      cancelled:      s.cancelled,
      confirmed:      s.confirmed,
      unconfirmed:    s.unconfirmed,
      spend:          Math.round(s.spend),
      cash:           Math.round(s.cash),
      contractRevenue: Math.round(s.contractRevenue),
      dials:          s.dials,
      showRate:       showDenom > 0 ? +(s.called / showDenom).toFixed(3) : null,
      closeRate:      s.called  > 0 ? +(s.closed / s.called).toFixed(3)  : null,
      roi:            s.spend   > 0 ? +(s.cash   / s.spend).toFixed(2)   : null,
    }
  }).sort((a,b) => b.booked - a.booked)

  return { setters }
}

// ── Metric: setter trends (week or month granularity) ────────────────────────
export function computeSetterTrends(appointments, { setter, granularity = 'month', from, to } = {}) {
  const appts = filterAppts(appointments, { from, to })
    .filter(a => (a.createdBy||'').trim() === setter)

  // Group by period key
  function periodKey(dateStr) {
    if (!dateStr) return null
    if (granularity === 'week') {
      const d = new Date(dateStr + 'T12:00:00Z')
      // ISO week: shift to Monday
      const day = d.getUTCDay() || 7
      const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - day + 1)
      return mon.toISOString().slice(0, 10)
    }
    return dateStr.slice(0, 7) // YYYY-MM
  }

  const periods = {}
  for (const a of appts) {
    const key = periodKey(a.startTime?.slice(0, 10))
    if (!key) continue
    if (!periods[key]) periods[key] = { period: key, booked: 0, called: 0, noShow: 0, cancelled: 0, closed: 0 }
    periods[key].booked++
    if (['closed','not_closed','showed'].includes(a.status)) periods[key].called++
    if (a.status === 'no_show')   periods[key].noShow++
    if (a.status === 'cancelled') periods[key].cancelled++
    if (a.status === 'closed')    periods[key].closed++
  }

  const rows = Object.values(periods).sort((a,b) => a.period.localeCompare(b.period)).map(p => {
    const showDenom  = p.called + p.noShow + p.cancelled
    const showRate   = showDenom > 0 ? +(p.called / showDenom).toFixed(3) : null
    const closeRate  = p.called  > 0 ? +(p.closed / p.called).toFixed(3)  : null
    return { ...p, showRate, closeRate }
  })

  return { setter, granularity, rows }
}

// ── Metric: monthly trends ────────────────────────────────────────────────────
export function computeMonthlyTrends(appointments, expenses, { from, to } = {}) {
  const allMonths = [...new Set([
    ...appointments.map(a => a.startTime?.slice(0,7)).filter(Boolean),
    ...expenses.map(e => (e.date||e.dateFrom||'').slice(0,7)).filter(Boolean),
  ])].sort()

  const months = allMonths.map(m => {
    const mAppts    = appointments.filter(a => a.startTime?.slice(0,7) === m)
    const mClosed   = mAppts.filter(a => a.status === 'closed')
    const mHadCall  = mAppts.filter(a => ['closed','not_closed','showed'].includes(a.status))
    const mNoShow   = mAppts.filter(a => a.status === 'no_show').length
    const mCanc     = mAppts.filter(a => a.status === 'cancelled').length
    const showDenom = mHadCall.length + mNoShow + mCanc
    const mExp      = expenses.filter(e => {
      const d = (e.date||e.dateFrom||'').slice(0,7)
      return d === m && !e.excludeFromCAC
    })

    const mCash     = mClosed.reduce((s,a) => s + (a.cashCollected||0) + (a.cashCollectedAfterFirstCall||0), 0)
    const mRev      = mClosed.reduce((s,a) => s + (a.contractRevenue||0), 0)
    const mSpend    = mExp.reduce((s,e) => s + (e.amount||0), 0)
    const mAdsSpend = mExp.filter(e => e.channel === 'ads').reduce((s,e) => s + (e.amount||0), 0)
    const mSmsSpend = mExp.filter(e => e.channel === 'cold_sms').reduce((s,e) => s + (e.amount||0), 0)

    return {
      month:     m,
      booked:    mAppts.length,
      hadCall:   mHadCall.length,
      closed:    mClosed.length,
      noShow:    mNoShow,
      cancelled: mCanc,
      showRate:  showDenom > 0 ? Math.round(mHadCall.length / showDenom * 100) : 0,
      closeRate: mHadCall.length > 0 ? Math.round(mClosed.length / mHadCall.length * 100) : 0,
      cash:      Math.round(mCash),
      contractRevenue: Math.round(mRev),
      avgDeal:   mClosed.length > 0 ? Math.round(mRev / mClosed.length) : 0,
      adsClosed: mClosed.filter(a => isAds(a)).length,
      smsClosed: mClosed.filter(a => isColdSMS(a)).length,
      spend:     Math.round(mSpend),
      adsSpend:  Math.round(mAdsSpend),
      smsSpend:  Math.round(mSmsSpend),
      cac:       mClosed.length > 0 ? Math.round(mSpend / mClosed.length) : 0,
      roas:      mSpend > 0 ? +(mCash / mSpend).toFixed(2) : 0,
    }
  })

  return { months }
}

// ── Metric: pipeline ──────────────────────────────────────────────────────────
export function computePipeline(appointments, { from, to } = {}) {
  const today    = new Date().toISOString().slice(0,10)
  const appts    = filterAppts(appointments, { from, to })
  const hadCall  = appts.filter(a => ['closed','not_closed','showed'].includes(a.status))
  const closed   = appts.filter(a => a.status === 'closed')
  const totalRev = closed.reduce((s,a) => s + (a.contractRevenue||0), 0)
  const avgDeal  = closed.length ? Math.round(totalRev / closed.length) : 0
  const closeRate = hadCall.length > 0 ? closed.length / hadCall.length : 0

  const upcoming = appointments.filter(a => a.status === 'confirmed' && (a.startTime?.slice(0,10)||'') >= today)
  const followUps = appointments.filter(a => a.status === 'not_closed' && a.followUpBooked)
  const unresolved = appts.filter(a => a.status === 'showed')

  return {
    upcomingCount:  upcoming.length,
    followUpCount:  followUps.length,
    unresolvedCount: unresolved.length,
    closeRate:       +closeRate.toFixed(3),
    avgDeal,
    projectedValue:  Math.round(upcoming.length * closeRate * avgDeal),
    upcoming,
    followUps,
    unresolved,
  }
}
