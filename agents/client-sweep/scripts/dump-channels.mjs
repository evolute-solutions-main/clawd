#!/usr/bin/env node
// MUST be first import - loads and validates all secrets
import '../../_shared/env-loader.mjs'

import { listGuildChannels } from '../../_shared/discord-fetcher/index.mjs'

const DISCORD = {
  guildId: '1164939432722440282'
}

// Secrets already loaded and validated by env-loader.mjs
const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_CHAT_BOT_TOKEN
if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN and DISCORD_CHAT_BOT_TOKEN')
  process.exit(1)
}

const guildId = DISCORD.guildId
const channels = await listGuildChannels({ guildId, token })
for (const ch of channels) {
  console.log(JSON.stringify({ id: ch.id, name: ch.name, parent_id: ch.parent_id }))
}
