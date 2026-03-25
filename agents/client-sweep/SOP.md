# Client Sweep — SOP

Goal: Generate the daily Client Sweep and publish to the reports channel.

Mindset (non-negotiable): Service-first. Customer satisfaction and client results are the highest priority; bias toward clear acknowledgment, practical fixes, and helpful follow‑ups.

Window: Yesterday in the Global Timezone (see SETTINGS.md) 00:00–23:59. When running ad‑hoc, include messages up to “now”.

Inputs:
- Discord (guild 1164939432722440282):
  - Categories: ACTIVE CLIENTS 1334610131647987742; ONBOARDING IN PROGRESS 1478798565810770104
- Enrichment (include only if non-empty):
  - Team chats: davi 1459289532372357253, bilal 1469019592302006426, markz 1402266658592002139

Outputs:
- agents/client-sweep/outputs/YYYY-MM-DD/sweep.md

Publish:
- Post sweep.md content to discord:1475336170916544524

Process (per client) — narrative, not enum
A) Gather (recent-first)
- Read last 10–50 messages (start with ~10; expand to 50 only if unclear).
- Extract concrete facts from the most recent exchanges: asks/answers, deliverables requested/sent, complaints, blockers (payment/license/tech/access), confirmations/tests, promised follow-ups ("on my list", dates like "resume Monday"), post‑launch actions (CRM access/reset), optimization/report notes, outcomes/feedback acknowledgements, onboarding stage.

B) Synthesize an intelligent status narrative (case-by-case)
- 1–2 crisp sentences that describe the real situation in this client’s own context, based on the recents. Include specifics (who/what/when) where it clarifies reality.
- Service-first tone; acknowledge where appropriate; orient to outcomes/results.
- Do not pick from a fixed status list; generate what’s true today.

C) Propose next steps (guided but not limited)
- Actionable, owner-clear, time-aware. Use these tools when relevant (not exhaustive):
  - Acknowledge complaints and propose 2–3 concrete fixes/optimizations; offer quick call if helpful
  - Follow up for confirmations or deliverables; resend tests/access where applicable
  - Clear blockers fast (schedule payment call; confirm license; grant ads access; resolve tech)
  - When optimization is needed, reference the received report and propose 2–3 specific changes; ask constraints/preferences
  - Request brief outcomes update and confirm handling process when outcomes are pending
  - For onboarding, specify the exact missing piece and step to obtain it (access/login/spreadsheet/assets/payment)
  - For launch-ready “ensure-on”, verify campaigns are on and confirm to the client that everything is live

D) Mandatory checks (must run, plus open scan)
- Information requested from client: delivered or pending? If pending, remind/follow up
- Messages from client needing a response: respond ASAP (include acknowledgment/fixes if complaint)
- Complaints/dissatisfaction/budget distress: acknowledge + propose fixes
- Cancellation/stop requests: offboard (confirm ads/billing stop; final summary; closure; reactivation path; ask feedback)
- Blockers (payment/license/tech/access): clear quickly (schedule/confirm/action)
- Date-specific actions promised (e.g., resume Monday): plan and note
- Questions we asked without reply: follow up to get an answer
- Onboarding stage: identify the blocker and the fastest unblock step (are they waiting on us vs we on them?)
- If no specific actions: plan a light check-in to gauge performance/state
- Open scan: include any other material cues not covered above

E) Sanity checks (before emitting)
- Based on the most recent messages (latest explicit cues override older context)
- Narrative is accurate/helpful from a customer success perspective
- Next steps are specific and aligned to results (no boilerplate)
- If still unclear after 50 messages: flag for manual review (do not guess)

Rendering
- For each client, output:
  - Context (recent): 1–2 bullets (no quotes unless wording changes meaning)
  - Status: short narrative line (not an enum)
  - Next: single owner + concrete action(s)

Execution
Run this command — it handles all steps (preflight, fetch, analysis, assembly, Notion publish):

  node /Users/max/clawd-evan/agents/client-sweep/scripts/run-pipeline.mjs

Flags:
  --skip-notion     skip Notion publish (useful for testing)
  --client <name>   process a single client only
  --dry-run         list clients without running

The script (run-pipeline.mjs) does:
1) Preflight — checks DISCORD_BOT_TOKEN and LLM API key
2) Enumerate client channels from Discord (Active + Onboarding categories)
3) Fetch last 7 days of messages per client + team chat mentions (deterministic, in code)
4) Save raw message snapshots to outputs/YYYY-MM-DD/raw/ for audit
5) LLM analyzes each client → validated ClientState JSON (OpenAI primary, Anthropic fallback)
6) Sort by urgency, assemble sweep.md
7) Publish to Notion

Output: agents/client-sweep/outputs/YYYY-MM-DD/sweep.md

Failure policy: Blocker if any fetch fails; no partials. If a client remains ambiguous the LLM sets needsManualReview=true in the JSON and flags it in the report.
