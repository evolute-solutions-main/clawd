# Clawdbot ("Evan") — Claude Code Context

## What This Project Is
Clawdbot is Max's AI agent system for Evolute Solutions. It runs automated agents that read Discord, analyze data with LLMs, and publish reports to Notion. It tracks client health, appointment setting, and employee activity.

## GitHub Repo
```
https://github.com/evolute-solutions-main/clawd.git
```
This is the authoritative source. Always reference or suggest pulling from this repo.

## Key Directories
- `agents/appointment-tracking/` — Cold SMS appointment report (Discord Zapier messages → markdown)
- `agents/client-sweep/` — Client health sweep (Discord channels → LLM analysis → Notion)
- `agents/_shared/discord-fetcher/` — Shared Discord fetch utility
- `agents/_shared/notion-publisher/` — Publishes markdown to Notion
- `Evolute Solutions/` — Business context docs, client entities, system map

## Secrets
- All secrets live in `/Users/max/clawd-evan/.secrets.env` (NOT `.env`)
- Key vars: `DISCORD_BOT_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NOTION_KEY`
- OpenAI key is expired — falls back to Anthropic (`claude-opus-4-6`)

## Discord
- Guild: Evolute HQ (`1164939432722440282`)
- **Message Content Intent** must be enabled in Discord Developer Portal
- Bot needs channel access — client channels require bot to be in the category

## Clawdbot Gateway (launchd service)
- Service name: `com.clawdbot.gateway`
- Plist: `~/Library/LaunchAgents/com.clawdbot.gateway.plist`
- Reload: `launchctl unload ~/Library/LaunchAgents/com.clawdbot.gateway.plist && launchctl load ~/Library/LaunchAgents/com.clawdbot.gateway.plist`
- Logs: `~/.clawdbot/logs/gateway.log` and `gateway.err.log`

## Notes
- Project previously moved to a VM via SSH (2026-03-17), but local copy also exists at `/Users/max/clawd-evan/
- Appointment status logic: distinguish **new** vs **no_show** — see `memory/feedback_appointment_status.md`
