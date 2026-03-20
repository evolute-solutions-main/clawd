# DATA.md — Evolute Business Data

All business data lives in `/data/`. Three files. Read them directly to answer any question about revenue, expenses, clients, or sales performance. Do not generate your own output files — these are the source of truth.

---

## The Three Databases

### `data/sales_data.json`
GHL appointments + monthly dial counts.

```json
{
  "appointments": [
    {
      "id": "string",
      "contactName": "string",
      "status": "new | confirmed | cancelled | no_show | closed | not_closed",
      "startTime": "2026-01-15T14:00:00-05:00",
      "setter": "Randy Ray Nadera",
      "channel": "ads | cold_sms",
      "closer": "string",
      "cashCollected": 4000,
      "cashCollectedAfterFirstCall": 0,
      "contractRevenue": 12000,
      "followUpBooked": false,
      "fathomLink": "https://..."
    }
  ],
  "dials": [
    { "setter": "Randy Ray Nadera", "date": "2026-01-01", "dials": 1831 }
  ]
}
```

Status lifecycle: `new` → `confirmed` → `showed` → `closed | not_closed`
Cancelled/no-show can happen at any stage.

Show rate = `showed / (showed + no_show + cancelled)` — excludes `new`.

---

### `data/expenses.json`
1,066 business expense entries. Source: unified from bank statements (2022–2026) + manually curated payroll records.

```json
{
  "id": "bank_0001",
  "date": "2026-01-14",
  "vendor": "Meta",
  "description": "Meta ad spend",
  "amount": 1373.99,
  "category": "ad_spend | software | payroll | consulting | refund | other",
  "channel": "ads | cold_sms | fulfillment | null",
  "department": "Setter | Closer | Media Buyer | Growth | null",
  "excludeFromCAC": false,
  "source": "bank | manual"
}
```

`excludeFromCAC: true` = fulfillment/overhead, exclude from acquisition cost math.

Key vendors: Meta (ads), GoHighLevel (software/SMS), Randy Ray Nadera (setter payroll, also appears as "Rrdnadera" in bank entries), Avry Stroeve (growth, excludeFromCAC), Wise Payroll (international setter payroll).

---

### `data/transactions.json`
153 client payment records. Source: Stripe + Fanbasis exports, 2025+.

```json
{
  "email": "client@example.com",
  "name": "Andrew Bursler",
  "amount": 2000,
  "net": 1942,
  "fee": 58,
  "date": "2025-07-29",
  "source": "fanbasis | stripe | manual | venmo"
}
```

To calculate LTV: group by `email`, then merge buckets that share the same normalized name (lowercase, trim) — some clients have multiple emails.

---

## Common Queries

**Closes this month:**
```js
appointments.filter(a => a.status === 'closed' && a.startTime.startsWith('2026-03'))
```

**Total revenue collected (cash in hand):**
```js
appointments.reduce((s, a) => s + (a.cashCollected || 0) + (a.cashCollectedAfterFirstCall || 0), 0)
```

**Ad spend for a period:**
```js
expenses.filter(e => e.category === 'ad_spend' && e.date >= '2026-01-01')
        .reduce((s, e) => s + e.amount, 0)
```

**CAC (cost per acquisition):**
```js
const spend = expenses.filter(e => !e.excludeFromCAC && e.channel === 'ads').reduce(...)
const closes = appointments.filter(a => a.status === 'closed' && !cold(a)).length
const cac = spend / closes
```

**Client LTV:**
```js
transactions.filter(t => t.email === 'client@example.com')
            .reduce((s, t) => s + t.amount, 0)
```

**Monthly P&L:**
```js
const rev = transactions.filter(t => t.date?.startsWith('2026-03')).reduce((s,t) => s+t.amount, 0)
const exp = expenses.filter(e => e.date?.startsWith('2026-03') && e.amount > 0).reduce((s,e) => s+e.amount, 0)
const profit = rev - exp
```

---

## Updating Data

**Always edit the JSON files, not the HTML.** The dashboard overwrites HTML data on every run.

```bash
# After editing any file in data/:
node scripts/inject-and-open.mjs
```

**To update an appointment outcome** (e.g. someone showed and didn't close):
Edit `data/sales_data.json` → find by name/date → set `status: "not_closed"`, add `closer`, `cashCollected`, etc.

**To add an expense:**
Add an entry to `data/expenses.json` with the right `category`, `channel`, and `excludeFromCAC`.

**To add a client payment:**
Add an entry to `data/transactions.json`.

---

## The Dashboard

`sales_tracker.html` — self-contained analytics dashboard. Tabs: Overview, Trends, Acquisition funnel, Revenue, Setters, Pipeline, Appointments, Costs & CAC, Clients, P&L, Raw Data.

Run `node scripts/inject-and-open.mjs` to rebuild it from the JSON files and open it.

---

## What You Can Do Proactively

- Answer any business performance question by reading the JSON files directly
- Update appointment statuses when Max tells you outcomes
- Add expense entries when Max logs new costs
- Compute quick stats (closes, CAC, LTV, show rate, P&L) on demand
- Remind Max to run inject after any data change so the dashboard stays current
