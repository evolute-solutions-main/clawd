/**
 * agents/_shared/db.mjs — Supabase data access layer for clawd-evan
 *
 * Same Supabase project as evolute-dashboard — both repos read/write the same DB.
 * Add SUPABASE_URL and SUPABASE_SERVICE_KEY to .secrets.env on the VM.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

let _client = null

export function db() {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set in .secrets.env')
    _client = createClient(SUPABASE_URL, SUPABASE_KEY)
  }
  return _client
}

// ── Clients ───────────────────────────────────────────────────────────────────

export async function getClients() {
  const { data, error } = await db().from('clients').select('*')
  if (error) throw error
  return data.map(dbToClient)
}

export async function upsertClient(client) {
  const { error } = await db().from('clients').upsert(clientToDb(client), { onConflict: 'id' })
  if (error) throw error
}

export async function updateClient(id, fields) {
  const row = {}
  if (fields.name !== undefined)              row.name = fields.name
  if (fields.companyName !== undefined)       row.company_name = fields.companyName
  if (fields.email !== undefined)             row.email = fields.email
  if (fields.phone !== undefined)             row.phone = fields.phone
  if (fields.clientStatus !== undefined)      row.client_status = fields.clientStatus
  if (fields.contractSignedDate !== undefined) row.contract_signed_date = fields.contractSignedDate || null
  if (fields.contractEndDate !== undefined)   row.contract_end_date = fields.contractEndDate || null
  if (fields.stripeCustomerId !== undefined)  row.stripe_customer_id = fields.stripeCustomerId
  if (fields.discordChannelId !== undefined)  row.discord_channel_id = fields.discordChannelId
  if (fields.appointmentId !== undefined)     row.appointment_id = fields.appointmentId
  if (fields.onboarding !== undefined)        row.onboarding = fields.onboarding
  const { error } = await db().from('clients').update(row).eq('id', id)
  if (error) throw error
}

// ── Alerts ────────────────────────────────────────────────────────────────────

export async function upsertAlert(alert) {
  const { error } = await db().from('alerts').upsert(alertToDb(alert), { onConflict: 'id' })
  if (error) throw error
}

// ── Appointments ──────────────────────────────────────────────────────────────

async function fetchAll(table, orderCol, mapper) {
  const PAGE = 1000
  let all = [], from = 0
  while (true) {
    const { data, error } = await db().from(table).select('*').order(orderCol, { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw error
    all = all.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all.map(mapper)
}

export async function getAppointments() {
  return fetchAll('appointments', 'start_time', dbToAppt)
}

export async function updateAppointment(id, fields) {
  const row = {}
  const map = {
    contactName: 'contact_name', contactId: 'contact_id', calendarName: 'calendar_name',
    startTime: 'start_time', timeCreated: 'time_created', appointmentStatus: 'appointment_status',
    createdBy: 'created_by', phone: 'phone', email: 'email', status: 'status',
    source: 'source', excluded: 'excluded', closer: 'closer',
    cashCollected: 'cash_collected', cashCollectedAfterFirstCall: 'cash_collected_after_first_call',
    contractRevenue: 'contract_revenue', followUpBooked: 'follow_up_booked',
    fathomLink: 'fathom_link', offerMade: 'offer_made',
    fathomConflictNote: 'fathom_conflict_note', noFathomNote: 'no_fathom_note',
    statusHistory: 'status_history', onboardingClientId: 'onboarding_client_id',
  }
  for (const [k, v] of Object.entries(fields)) {
    if (map[k] !== undefined) row[map[k]] = v
  }
  const { error } = await db().from('appointments').update(row).eq('id', id)
  if (error) throw error
}

// ── Field mapping ─────────────────────────────────────────────────────────────

function clientToDb(c) {
  return {
    id:                   c.id,
    name:                 c.name || '',
    company_name:         c.companyName || '',
    email:                c.email || '',
    phone:                c.phone || null,
    appointment_id:       c.appointmentId || null,
    contract_signed_date: c.contractSignedDate || null,
    contract_end_date:    c.contractEndDate || null,
    stripe_customer_id:   c.stripeCustomerId || null,
    client_status:        c.clientStatus || 'onboarding',
    fathom_sales_call_link: c.fathomSalesCallLink || null,
    discord_channel_id:   c.discordChannelId || null,
    onboarding:           c.onboarding || {},
  }
}

function dbToClient(r) {
  return {
    id:                   r.id,
    name:                 r.name,
    companyName:          r.company_name,
    email:                r.email,
    phone:                r.phone,
    appointmentId:        r.appointment_id,
    contractSignedDate:   r.contract_signed_date,
    contractEndDate:      r.contract_end_date,
    stripeCustomerId:     r.stripe_customer_id,
    clientStatus:         r.client_status,
    fathomSalesCallLink:  r.fathom_sales_call_link,
    discordChannelId:     r.discord_channel_id,
    onboarding:           r.onboarding || {},
  }
}

function alertToDb(a) {
  return {
    id:          a.id,
    type:        a.type,
    status:      a.status || 'open',
    message:     a.message || '',
    received_at: a.receivedAt || new Date().toISOString(),
    resolved_at: a.resolvedAt || null,
    payload:     a.payload || {},
  }
}

function dbToAppt(r) {
  return {
    id:                r.id,
    contactId:         r.contact_id,
    contactName:       r.contact_name,
    calendarName:      r.calendar_name,
    startTime:         r.start_time,
    timeCreated:       r.time_created,
    appointmentStatus: r.appointment_status,
    createdBy:         r.created_by,
    phone:             r.phone,
    email:             r.email,
    status:            r.status,
    onboardingClientId: r.onboarding_client_id,
    ...(r.source           != null && { source:          r.source }),
    ...(r.excluded         != null && { excluded:        r.excluded }),
    ...(r.closer           != null && { closer:          r.closer }),
    ...(r.cash_collected   != null && { cashCollected:   r.cash_collected }),
    ...(r.cash_collected_after_first_call != null && { cashCollectedAfterFirstCall: r.cash_collected_after_first_call }),
    ...(r.contract_revenue != null && { contractRevenue: r.contract_revenue }),
    ...(r.follow_up_booked != null && { followUpBooked:  r.follow_up_booked }),
    ...(r.fathom_link      != null && { fathomLink:      r.fathom_link }),
    ...(r.offer_made       != null && { offerMade:       r.offer_made }),
    statusHistory:     r.status_history || [],
  }
}
