#!/usr/bin/env node
/**
 * Client Sweep - Loop Runner (Gateway-backed Orchestrator)
 *
 * ⚠️  DEPRECATED — superseded by run-pipeline.mjs
 *
 * This file is kept for rollback comparison only. Do not extend it.
 * New runs should use: node scripts/run-pipeline.mjs
 *
 * Differences vs run-pipeline.mjs:
 *   - This spawns one `clawdbot agent` LLM process per client; the LLM
 *     does its own retrieval + formatting, which produces output drift.
 *   - run-pipeline.mjs fetches data in code, LLM only does interpretation,
 *     and assembles the report deterministically.
 *
 * Scheduled for removal after run-pipeline.mjs has been validated in prod.
 */

// MUST be first import - loads and validates all secrets
import '../../_shared/env-loader.mjs'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listGuildChannels } from '../../_shared/discord-fetcher/index.mjs'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_ROOT = path.join(__dirname, '..')
const REPO_ROOT = path.join(AGENT_ROOT, '../..')
const OUTPUTS_DIR = path.join(AGENT_ROOT, 'outputs')

// Load secrets
function loadSecrets() {
  try {
    const p = path.join(REPO_ROOT, '.secrets.env')
    const text = fs.readFileSync(p, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {}
}
loadSecrets()

// Config
const DISCORD = {
  guildId: '1164939432722440282',
  categories: {
    activeClients: '1334610131647987742',
    onboardingInProgress: '1478798565810770104'
  },
  teamChats: {
    davi: '1459289532372357253',
    bilal: '1469019592302006426',
    markz: '1402266658592002139'
  }
}

// Notion parent page (Client Sweeps page)
const NOTION_PARENT_PAGE_ID = '31050a67-1a8f-80bb-80eb-dc5d9c59f646'

// Build client list from live Discord roster (Active + Onboarding categories)
async function loadClientsFromDiscord() {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN')
  const channels = await listGuildChannels({ guildId: DISCORD.guildId, token })
  const active = (channels || []).filter(ch => ch && String(ch.parent_id) === String(DISCORD.categories.activeClients))
  const onboard = (channels || []).filter(ch => ch && String(ch.parent_id) === String(DISCORD.categories.onboardingInProgress))
  const clientChans = [...active, ...onboard]
  return {
    clients: clientChans.map(ch => ({
      name: ch.name,
      channelName: ch.name,
      channelId: ch.id,
      parentId: ch.parent_id
    })),
    counts: { active: active.length, onboarding: onboard.length, total: clientChans.length }
  }
}

// Build task for a single client (compact; instruct model to read SOP files)
function buildClientTask(client) {
  return `You are running a single-client sweep.\n\nFirst, read these files using the read tool:\n- /Users/max/clawd-evan/agents/client-sweep/training/single-client-sweep.md\n- /Users/max/clawd-evan/agents/client-sweep/DECISION-RULES.md\n\nThen execute the sweep for THIS client only:\n\n**Client:** ${client.name}\n**Discord Channel ID:** ${client.channelId}\n**Guild ID:** ${DISCORD.guildId}\n\nTeam chats for enrichment:\n- Davi: ${DISCORD.teamChats.davi}\n- Bilal: ${DISCORD.teamChats.bilal}\n- Markz: ${DISCORD.teamChats.markz}\n\nInstructions:\n1) Read last 30–50 messages in the client channel\n2) Apply SOP + Decision Rules\n3) Include ONLY relevant sections (no empty buckets)\n\nOutput ONLY the sweep block:\n## ${client.name}\n- **Context (recent):** 1–2 bullets\n- **Status:** narrative line\n- **Next:** owner → action\n(If relevant) - **Team chatter:** / - **Asana:** / - **Risk:**\n`
}

// Get today's date
function getToday() {
  return new Date().toISOString().split('T')[0]
}

// Main
async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const skipNotion = args.includes('--skip-notion')
  const clientFilter = args.find((_, i, arr) => arr[i-1] === '--client')

  console.log('🔄 Client Sweep - Loop Runner (Gateway Orchestrator)')
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)

  let { clients, counts } = await loadClientsFromDiscord()
  console.log(`Found ${counts.total} clients (Active + Onboarding)`) 
  if (counts.active === 0 || counts.onboarding === 0) {
    console.warn('no access to this channel, please update this')
    process.exit(1)
  }

  if (clientFilter) {
    clients = clients.filter(c => c.name.toLowerCase().includes(clientFilter.toLowerCase()))
    console.log(`Filtered to: ${clients.map(c => c.name).join(', ')}`)
  }

  if (dryRun) {
    console.log('\n--- Would process these clients ---')
    for (const client of clients) {
      console.log(`  • ${client.name} (${client.channelId})`)
    }
    return
  }

  const today = getToday()

  // Prepare output directory
  const outputDir = path.join(OUTPUTS_DIR, today)
  fs.mkdirSync(outputDir, { recursive: true })

  // Build tasks in-memory
  const tasks = clients.map(client => ({
    client: client.name,
    channelId: client.channelId,
    task: buildClientTask(client)
  }))

  const sweepPath = path.join(outputDir, 'sweep.md')

  // Orchestrate per-client runs via gateway-backed CLI
  const concurrency = Number(process.env.SWEEP_CONCURRENCY || 4)
  const queue = [...tasks]
  const results = []

  async function runOne(t) {
    const args = [
      'agent',
      '--session-id', `sweep-${t.channelId}`,
      '--message', t.task,
      '--json',
      '--timeout', '600'
    ]
    const { stdout } = await execFileAsync('clawdbot', args, { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 })
    const parsed = JSON.parse(stdout)
    const text = parsed?.result?.payloads?.[0]?.text?.trim()
    if (!text) throw new Error(`Empty response for ${t.client}`)
    results.push({ client: t.client, text })
  }

  async function worker() {
    while (queue.length) {
      const t = queue.shift()
      await runOne(t)
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  // Sort by urgency (simple heuristic)
  function score(text) {
    const t = text.toLowerCase()
    if (/(urgent|blocked|blocker|paused|pause|cancel|cancell)/.test(t)) return 0
    if (/(awaiting|follow up|follow-up|waiting|needs response|action required)/.test(t)) return 1
    if (/(stable|live|running|launched)/.test(t)) return 3
    return 2
  }
  results.sort((a, b) => score(a.text) - score(b.text))

  const header = `# Daily Client Sweep — ${today}\nSorted by urgency (highest → lowest).\n\n---\n\n`
  const body = results.map(r => r.text).join('\n\n')
  fs.writeFileSync(sweepPath, header + body + '\n')
  console.log(`WROTE ${sweepPath}`)

  if (!skipNotion) {
    const publishArgs = [
      path.join(REPO_ROOT, 'agents/_shared/notion-publisher/publish.mjs'),
      '--mode=page',
      `--parentPageId=${NOTION_PARENT_PAGE_ID}`,
      '--type=client_sweep',
      `--date=${today}`,
      '--status=success',
      `--sources=${sweepPath}`
    ]
    const { stdout: pubOut } = await execFileAsync('node', publishArgs, { maxBuffer: 10 * 1024 * 1024 })
    console.log(pubOut.trim())
  }
}

main().catch(console.error)
