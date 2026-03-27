# Clawdbot ("Evan") — Claude Code Context

## What This Project Is
Clawdbot is Max's AI agent system for Evolute Solutions. It runs automated agents that read Discord, analyze data with LLMs, and post reports to Discord/Notion. Goal: every business function systematized in AI — Max reviews and decides, doesn't execute.

## GitHub Repo
```
https://github.com/evolute-solutions-main/clawd-evan.git
```

## Environment
- **Only working directory: `/root/clawd-evan`** — do not create or edit `/root/clawd` or any other path
- **Primary dev environment: VM** — `/root/clawd-evan` on DigitalOcean (134.209.34.97)
- Local copy at `/Users/max/clawd-evan` exists but VM is authoritative
- Secrets: `/root/clawd-evan/.secrets.env` on VM (NOT `.env`)
- Key vars: `DISCORD_BOT_TOKEN`, `DISCORD_CHAT_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `NOTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

## Key Directories
- `agents/appointment-tracking/` — Cold SMS appointment report
- `agents/client-sweep/` — Daily client health sweep (Discord → LLM → Notion)
- `agents/onboarding/` — Onboarding briefing agent (reads `data/clients.json`, outputs per-role action lists)
- `agents/webhooks/` — HTTP webhook server (Stripe, GHL) running on port 3001
- `agents/_shared/` — Shared utilities (env-loader, discord-fetcher, notion-publisher)
- `scripts/` — One-off scripts: `new-client.mjs`, `mark-done.mjs`, etc.
- `data/` — All data: `clients.json`, `alerts.json`, `sales_data.json`, `expenses.json`, etc.

## Services on VM (systemd)
- `clawdbot-gateway` — Discord gateway bot (reads messages, triggers agents)
- `webhook-server` — Express HTTP server on port 3001, proxied via Caddy
- Logs: `/root/.clawdbot/logs/`
- Caddy proxies `https://webhooks.evolutesolutions.io` → port 3001

## Discord
- Guild: Evolute HQ (`1164939432722440282`)
- Two bots: `DISCORD_BOT_TOKEN` (read-only fetcher), `DISCORD_CHAT_BOT_TOKEN` (read+write chat bot)
- Message Content Intent must be enabled in Discord Developer Portal

## Client & Onboarding System (built 2026-03-25, restructured 2026-03-26)
- Data: `data/clients.json` — canonical client store; each client has an `onboarding` object with `status`, `steps`, `log`, and timing fields
- Data: `data/alerts.json` — unmatched webhook events (payment/form/Discord join with no client match); separate from client records
- Client shape: top-level fields (`id`, `name`, `companyName`, `email`, `appointmentId`, `contractSignedDate`, `stripeCustomerId`, etc.) + nested `onboarding: { status, steps, log, launchedDate, campaignsLaunchedAt, readyToBookCallAt }`
- `appointmentId` links a client back to their closed appointment in `sales_data.json`
- `scripts/new-client.mjs` — create client record when Max signs (supports `--appointment-id`)
- `scripts/mark-done.mjs` — mark a step complete (fuzzy matches client + step, writes to `client.onboarding.steps`)
- `scripts/resolve-alert.mjs` — resolve alerts in `data/alerts.json`
- `agents/onboarding/scripts/run.mjs` — daily briefing, walks dependency graph, outputs per-role action lists
- Webhook auto-detection: Stripe payment → marks `payment_collected`; GHL form → marks `onboarding_form_submitted`; Discord join → marks `client_joined_discord`

**Still to build:**
- Dashboard onboarding tab
- Link new clients to closed appointments in sales_data (stamp `onboardingClientId` on appointment when client created)

## AGENTS.md Routing Rules
When Max says "just signed [client]" → run `new-client.mjs`
When team says "[step] done for [client]" → run `mark-done.mjs`
"onboarding status" → run `run.mjs`

## Key Decisions & Principles
- **UI is Discord or dashboard only** — no CLI for end users, no one needs to know how it works under the hood
- **AI acts as ops manager** — pushes Account Manager/CSM and Media Buyer; does NOT communicate directly with clients
- **Role-based ownership** — steps assigned to roles (accountManager, mediaBuyer, videoEditor), not people by name
- **Data lives in `data/*.json`** — single source of truth, human-readable
- **Max reviews, doesn't execute** — agents surface actions, Max approves or ignores

## Appointment Status Logic
- `status: 'new'` = tentative/unconfirmed. NOT a no-show. Never include in show rate denominators.
- `status: 'no_show'` = was confirmed, didn't show. Only these count.
- Show rate denominator: `showed + no_show + cancelled` only.

## Build Roadmap
See `MASTERPLAN.md` for full plan. See `TODO.md` for phased task list.

Phase 1 (Foundation): Onboarding tracker ✅ (built, needs Discord + cron), Collections tracker, Payroll calculator
Phase 2 (Intelligence): Morning briefing agent, CSM knowledge base, Dashboard ops tabs
Phase 3 (Integrations): GHL webhooks (replace polling), Meta ads API
Phase 4 (Automation): Auto-follow-up drafting, Fathom follow-up agent
