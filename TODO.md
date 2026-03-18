# TODO

Work tasks for Evolute Solutions. Updated 2026-03-18.

## Active

### High Priority
- [ ] **Fix Google OAuth** — refresh token expired/revoked; re-auth needed for Sheets integration
- [ ] **Fathom → Sales Tracking pipeline** — detect sales calls from Fathom, log to Google Sheet
- [ ] **Data dashboard** — unified view of appointments, sales calls, client metrics

### Medium Priority
- [ ] **GHL Calendar appointments** — pull scheduled appointments by date (source of truth for *who should show*)
- [ ] **Show rate calculation** — match GHL scheduled appointments against Fathom recordings (Fathom = source of truth for *who actually showed*)
- [ ] **Meta CPL integration** — pull cost-per-lead data per client for reporting

### Lower Priority / Ideas
- [ ] Asana visibility — surface overdue/stalled tasks in sweeps
- [ ] Calendar proactive alerts — flag upcoming meetings, prep reminders

## Completed

_(move items here when done)_

---

## Architecture Notes

**Appointments & Show Rates:**
- GHL Calendar = scheduled appointments (who was supposed to show)
- Fathom = actual shows (recording exists → they showed)
- Pipeline: GHL appointments for date → Fathom calls for date → match → show rate

**Existing agents:**
- `client-sweep` — daily sweep, runs 06:00 BRT, posts to Discord
- `appointment-tracking` — cold SMS appointment reports
- `fathom` — Fathom API client + scripts

**Blocked:**
- Google Sheets export requires OAuth fix first
- Sales tracking pipeline depends on Sheets
