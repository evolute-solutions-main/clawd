/**
 * env-loader.mjs — SINGLE SOURCE OF TRUTH for environment secrets
 * 
 * This module ALWAYS loads from .secrets.env and OVERWRITES any existing
 * env vars. No more conflicts from systemd, /root/.clawdbot/env, or anywhere else.
 * 
 * Usage: import '/path/to/agents/_shared/env-loader.mjs'
 * 
 * Call this at the TOP of any script that needs secrets.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const SECRETS_FILE = path.join(REPO_ROOT, '.secrets.env')

// ALWAYS load and OVERWRITE - no "if not exists" bullshit
function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) {
    console.error(`FATAL: ${SECRETS_FILE} not found`)
    process.exit(1)
  }

  const text = fs.readFileSync(SECRETS_FILE, 'utf8')
  let loaded = 0

  for (const line of text.split(/\r?\n/)) {
    // Skip comments and empty lines
    if (!line.trim() || line.trim().startsWith('#')) continue
    
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (match) {
      const [, key, value] = match
      // ALWAYS overwrite - this is the fix
      process.env[key] = value
      loaded++
    }
  }

  // Validate critical tokens
  // NOTE: Two Discord bots exist:
  //   DISCORD_BOT_TOKEN = fetcher bot (READ only)
  //   DISCORD_CHAT_BOT_TOKEN = chat bot (READ + WRITE)
  // See CONNECTIONS.md for details
  
  const discordToken = process.env.DISCORD_BOT_TOKEN
  if (!discordToken || discordToken.length < 50 || discordToken.includes('PASTE') || discordToken.includes('YOUR')) {
    console.error(`FATAL: DISCORD_BOT_TOKEN is invalid or placeholder`)
    console.error(`  Length: ${discordToken?.length || 0}`)
    console.error(`  Value preview: ${discordToken?.slice(0, 20)}...`)
    process.exit(1)
  }
  
  const chatToken = process.env.DISCORD_CHAT_BOT_TOKEN
  if (!chatToken || chatToken.length < 50 || chatToken.includes('PASTE') || chatToken.includes('YOUR')) {
    console.error(`FATAL: DISCORD_CHAT_BOT_TOKEN is invalid or placeholder`)
    console.error(`  Length: ${chatToken?.length || 0}`)
    console.error(`  Value preview: ${chatToken?.slice(0, 20)}...`)
    process.exit(1)
  }

  return loaded
}

// Auto-run on import
const count = loadSecrets()
// Silent success - only log on verbose
if (process.env.DEBUG_ENV_LOADER) {
  console.log(`[env-loader] Loaded ${count} vars from ${SECRETS_FILE}`)
}

export { SECRETS_FILE, REPO_ROOT, loadSecrets }
