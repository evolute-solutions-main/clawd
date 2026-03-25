# System Map (Evolute Solutions)

This file documents what exists, why it exists, and what the AI should treat as source-of-truth.

## Source of truth (current)
- **Client entity database (this repo):** `Evolute Solutions/client-entities.json` (canonical)
- **Asana:** execution + status surfaces (mirrors canonical IDs/fields; may be updated by automations later)
- **Discord:** client communication surface

## Systems

### Discord (Client Comms)
- Purpose: client communication + requests + approvals.
- Server (guild) id: `1164939432722440282`
- Active Clients category id: `1334610131647987742`
- Sweep output channel id: `1475336170916544524`

### Asana (Task + Client Hub)
- Purpose: delivery task management + client hub fields.
- Workspace gid: `1212775946298840`
- Client Hub 3.0 project gid: `1213220062504456`
- CSM/Ops Task Management project gid: `1212818114959823`
  - Contract Expire section gid: `1212993046885632`

### Notion (SOPs/Docs)
- Purpose: SOPs and knowledge base (TBD what is canonical vs reference).
- Status: documented in `TOOLS.md` and here when needed.

### Meta (Ads)
- Purpose: ad performance + CPL.
- Status: not yet connected for API reporting.

## Auth locations
- Credentials: `/Users/max/clawd-evan/.secrets.env`
- Non-secret IDs/config: `/Users/max/clawd-evan/.env`
- Clawdbot provider auth store (internal): `/Users/max/.clawdbot/agents/main/agent/auth-profiles.json`
