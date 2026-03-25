# SECURITY (Evolute Solutions workspace)

## Golden rule
- **Never paste tokens/credentials in chat** (Discord/DM/etc.) even if it feels low-risk.

## Where secrets live
- **Workspace secrets file:** `/Users/max/clawd-evan/.secrets.env`
  - This file is **gitignored**.
  - Store credentials here (Asana PAT, any future API keys, etc.).

## Where non-secrets live
- **Workspace config:** `/Users/max/clawd-evan/.env`
  - IDs and configuration that are not credentials (project IDs, channel IDs, etc.).

## Naming conventions
- Prefer `VENDOR_THING` env names:
  - `ASANA_PAT`
  - `META_ACCESS_TOKEN` (future)
  - `NOTION_TOKEN` (future)

## Rotation / break-glass
- If a token is ever leaked or you’re unsure: rotate it immediately in the vendor UI and update `.secrets.env`.
