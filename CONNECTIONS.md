# CONNECTIONS.md — Source of Truth for Integrations

Purpose: eliminate "forgetting connections." Every specialist preflights against this file before running. Keep it accurate.

Last updated: 2026-03-17

## Messaging / Channels

### Discord
- Enabled: true
- Guilds:
  - Home (1475336170048065538)
    - Allowed channel(s):
      - 1475336170916544524 (reports / sweeps)
  - Evolute HQ (1164939432722440282)
    - Selected channels (requireMention: true):
      - 1459289532372357253 — team-davi
      - 1386770338448277524 — general (no mention required)
      - 1468661549194281144 —
      - 1468303418018893935 —
      - 1394239403366285382 —
      - 1460345897832681543 —
      - 1448030024593834106 —
      - 1473371247537557525 —
      - 1474420680123744537 —
      - 1400236255370936490 —
      - 1442535792428716123 —
      - 1471221296330178802 —
      - 1469111055534915625 —
      - 1474386422705164379 —
      - 1438722016772620339 —
      - 1432777540166090875 —
      - 1410653307227213914 —
      - 1403092736055447672 —
      - 1469355379166019760 —
      - 1475571185671733248 —
      - 1402266658592002139 —
      - 1402336866438479873 —
      - 1465092557062144102 —
      - 1465092630479114446 —
      - 1469019592302006426 — team-bilal
      - 1475477552712908882 —
      - 1475477863435079720 —
      - 1475534293273935962 —
- Token: configured (see gateway config)
- Quick probe: post a short test to 1475336170916544524 (reports channel)

## Model Providers

### OpenAI
- Default profile: openai/gpt-5 (primary)
- Status: previously hit quota errors from cron; monitor before heavy runs.
- Quick probe: run a trivial completion locally; or check for recent cron quota failures.
- Timezone standard for all jobs: America/Sao_Paulo (BRT)

### Anthropic
- Alias: opus → anthropic/claude-opus-4-5
- Mode: OAuth via anthropic:claude-cli profile
- Quick probe: spawn a short isolated session using model alias "opus".

## Project/Work Tools

### Asana
- Projects referenced in jobs:
  - Client Hub: 1213220062504456
  - CSM/Ops Task Management: 1212818114959823
  - Media: 1212871372765494
- Auth: configured previously (per your note). Action: enforce preflight hard-fail if missing.
- Quick probe: list a project by id (1213220062504456). If probe fails → Blocker: Asana auth.

### Notion
- Client Sweeps DB id: 0dc56df6-24ea-4cc1-b4ea-a7b88f874da8 (from TOOLS.md)
- Parent page: https://www.notion.so/evolutesolutionsio/Client-Sweeps-31050a671a8f80bb80ebdc5d9c59f646
- Auth: configured previously (per your note). Action: enforce preflight hard-fail if missing.
- Quick probe: fetch a known page or DB properties. If probe fails → Blocker: Notion auth.

## Webhooks / External APIs

### Fathom
- Enabled: true
- Base URL: https://api.fathom.ai/external/v1
- Auth: X-Api-Key header — secret stored in .secrets.env as FATHOM_API_KEY (or FATHOM_API_TOKEN)
- Shared client: agents/_shared/fathom/index.mjs
- Agent scripts: agents/fathom/scripts/probe.mjs, run.mjs
- Rate limit: 60 req/min
- Quick probe: node agents/fathom/scripts/probe.mjs
- Note: fathom.video domain no longer resolves; all calls must go to fathom.ai

## Discord Tokens (IMPORTANT — TWO BOTS)

**There are TWO Discord bots with different permissions:**

| Token | Bot | Permissions | Use For |
|-------|-----|-------------|---------|
| `DISCORD_BOT_TOKEN` | Fetcher bot | READ only | Fetching channel history, listing channels |
| `DISCORD_CHAT_BOT_TOKEN` | Chat bot (Evan) | READ + WRITE | Posting messages to Discord |

**Rules:**
- For READING (fetchers, sweeps): use `DISCORD_BOT_TOKEN`
- For POSTING (cron notifications, alerts): use `DISCORD_CHAT_BOT_TOKEN`
- Clawdbot gateway uses its own token in config (`channels.discord.token`) for message routing

**If you get 403 Missing Access when posting:** You're using the wrong token. Switch to `DISCORD_CHAT_BOT_TOKEN`.

## Preflight Policy (applies to all specialists)
- Read this file.
- For each required dependency for the run, do a quick probe (non-destructive):
  - Channels: check post permission (dry-run or capability check when supported)
  - Provider quota: if recent quota errors (<24h), classify as soft-fail
  - App APIs (Asana/Notion): minimal list/fetch
- If any probe fails → post minimal blocker to the publishing channel and exit.

## Ownership
- Maintainer: Evan (orchestrator)
- Update cadence: when channels/projects change; quarterly cleanup.
