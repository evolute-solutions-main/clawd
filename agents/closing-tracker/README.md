# Closing Tracker

Tracks sales call show/no-show data by matching GHL calendar appointments against Fathom recordings.

## Usage

```bash
# Run for yesterday (default)
node agents/closing-tracker/scripts/run.mjs

# Run for specific date
node agents/closing-tracker/scripts/run.mjs --date=2026-03-17

# Run for today
node agents/closing-tracker/scripts/run.mjs --date=today
```

## How It Works

1. **Pull appointments** from tracked calendars (Cold SMS, Meta Inbound)
2. **Filter** to non-"new" status (confirmed, showed, noshow, cancelled)
3. **Pull Fathom calls** for the same date
4. **Match** appointments to Fathom calls by title/name
5. **Output** each appointment with showed/no-show status

## Configuration

Edit `lib/get-closing-data.mjs` to add/remove tracked calendars:

```javascript
export const TRACKED_CALENDARS = [
  { id: 'FITm7fIlhVTworbpJArx', name: 'Cold SMS' },
  { id: '8OhPnPLb8e6czA50rozN', name: 'Meta Inbound' },
]
```

## Output

Returns:
- `date` — the date queried
- `appointments[]` — each appointment with:
  - `contactName`, `contactId`
  - `startTime`, `endTime`
  - `ghlStatus` — status in GHL (confirmed, cancelled, etc.)
  - `showStatus` — 'showed' or 'no-show'
  - `matchedFathomCall` — matched Fathom recording info (if showed)
- `fathomCalls[]` — all Fathom calls found for the date
- `summary` — totalScheduled, showed, noShow counts

## Future

- Google Sheets integration (pending OAuth fix)
- Close tracking (manual input from Max)
