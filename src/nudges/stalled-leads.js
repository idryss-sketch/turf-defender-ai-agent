// Stalled-lead nudge — finds conversations that got quoted but didn't book,
// then sends a friendly AI-generated follow-up after 24 hours.
//
// Triggered automatically by a setInterval in server.js (runs every 30
// minutes), or manually via POST /api/nudges/run.
//
// Safety gates respected (same as the main webhook handler):
//   • Kill switch (data/.kill file)
//   • Whitelist (ALLOWED_CONTACTS or ALLOW_ALL_CONTACTS)
//   • DRY_RUN (defaults to true — won't actually send unless DRY_RUN=false)
//
// Each conversation is nudged AT MOST ONCE — we set state.nudged=true after
// firing, so repeat scheduler runs skip already-nudged conversations.

import { existsSync } from 'node:fs';
import { allConversations, updateState } from '../storage/conversations.js';
import * as ghl from '../integrations/ghl.js';
import { quote } from '../conversation/pricing.js';

const KILL_SWITCH_PATH = new URL('../../data/.kill', import.meta.url);

// Tunables
const NUDGE_AFTER_HOURS = 24;       // fire after the convo has been quiet this long
const NUDGE_WINDOW_HOURS = 6;       // and within this window (so a missed run still catches it)
const ACTIVE_START_HOUR_AZ = 9;     // 9 AM Arizona — don't wake anyone up
const ACTIVE_END_HOUR_AZ = 19;      // 7 PM Arizona — late but acceptable

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * Arizona is UTC-7 year-round (no DST). Return true if the current AZ hour
 * is between 9 AM and 7 PM.
 */
function isWithinActiveHours() {
  const now = new Date();
  const azHour = (now.getUTCHours() - 7 + 24) % 24;
  return azHour >= ACTIVE_START_HOUR_AZ && azHour < ACTIVE_END_HOUR_AZ;
}

function isKillSwitchActive() {
  return existsSync(KILL_SWITCH_PATH);
}

function isContactAllowed(contactId) {
  if (process.env.ALLOW_ALL_CONTACTS === 'true') return true;
  const whitelist = (process.env.ALLOWED_CONTACTS || '').trim();
  if (!whitelist) return false;
  return whitelist.split(',').map((s) => s.trim()).includes(contactId);
}

/**
 * A conversation is "stalled" (eligible for a nudge) if:
 *   • Customer was quoted (we know sqft).
 *   • They DID NOT book through our AI flow.
 *   • The conversation is NOT escalated, NOT handed off, NOT already nudged.
 *   • There's a way to reach them (phone or email).
 *   • Last activity was 24-30 hours ago.
 *
 * Note: this is the FAST cache-only check. The async hasFreshGhlActivity()
 * check below is the second gate — it pulls live GHL data to make sure no
 * human (Dave, Dalis) has touched the conversation since our last record.
 * That's what protects against nudging customers who booked offline.
 */
function isStalled(state) {
  if (!state) return false;
  if (!state.sqft) return false;          // never got a quote → no nudge
  if (state.booked) return false;
  if (state.escalated) return false;
  if (state.handedOff) return false;
  if (state.nudged) return false;
  const phone = state.contact?.phone;
  const email = state.contact?.email;
  if (!phone && !email) return false;
  if (!state.lastUpdated) return false;

  const ageHours = (Date.now() - new Date(state.lastUpdated).getTime()) / (1000 * 60 * 60);
  return ageHours >= NUDGE_AFTER_HOURS && ageHours < NUDGE_AFTER_HOURS + NUDGE_WINDOW_HOURS;
}

/**
 * Live check against GHL: has anyone (customer OR human teammate) touched
 * this conversation since our state was last updated? If yes, it's NOT
 * truly stalled — someone's working it offline. Skip the nudge.
 *
 * This protects against the most common false-positive: customer got a
 * quote from the AI, then called/texted Dave directly to book. Our state
 * still shows booked=false but the conversation is clearly being handled.
 *
 * Returns true if there's been activity since state.lastUpdated (skip nudge).
 * Returns false if our record is up-to-date with GHL (safe to nudge).
 * Returns true (skip) on any error — fail safe, never nudge if unsure.
 */
async function hasFreshGhlActivity(state, conversationId) {
  if (!conversationId) return true; // no convo id → can't verify, skip
  try {
    const messages = await ghl.getMessages(conversationId, 20);
    if (!Array.isArray(messages) || messages.length === 0) return true;
    const ourLastUpdate = new Date(state.lastUpdated).getTime();
    // Look for ANY message newer than our last state update. That message
    // is something we didn't process (customer reply OR human teammate's
    // direct response) — either way, the conversation isn't truly stalled.
    for (const m of messages) {
      const ts = new Date(m.dateAdded || m.dateCreated || 0).getTime();
      if (ts > ourLastUpdate + 60_000) {
        // 60s buffer to avoid race with our own writes
        return true;
      }
    }
    return false;
  } catch (e) {
    console.warn(`💌  ↳ GHL freshness check failed (${e.message}) — skipping nudge to be safe`);
    return true;
  }
}

/**
 * Pick the channel for the nudge:
 *   • If we have a phone AND the original channel was SMS-ish → SMS
 *   • Else if we have email → Email
 *   • Else → null (caller will skip)
 */
function pickChannel(state) {
  const phone = state.contact?.phone;
  const email = state.contact?.email;
  const orig = state.channel || 'SMS';
  // SMS preferred when phone exists and original wasn't email
  if (phone && orig !== 'Email') return 'SMS';
  if (email) return 'Email';
  if (phone) return 'SMS';
  return null;
}

/**
 * Ask Claude for a nudge message in SCT brand voice.
 * Short, friendly, no pressure, no date confirmation, no emojis.
 */
async function generateNudge(state, channel) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const customerName = state.customerName || 'there';
  const sqft = state.sqft;

  // Pull the most-current quote so the nudge price matches what we'd quote
  // today (in case prices changed since the original quote).
  let pricingContext = '';
  if (sqft) {
    try {
      const khloeQ = quote('khloe', sqft, true);
      const karlQ = quote('karl', sqft, true);
      pricingContext = `Their yard is ${sqft} sq ft. The deep clean (with the 15% special) comes out to $${khloeQ.firstTime}, and the extraction service comes out to $${karlQ.firstTime}.`;
    } catch (e) {
      // pricing failure shouldn't block the nudge — just go without prices
    }
  }

  const formatRules = channel === 'Email'
    ? `This is an EMAIL. Open with "Hi ${customerName}," and end with "Talk soon,\nSqueaky Clean Turf Team". Use 2-3 short sentences in between.`
    : `This is an SMS. No greeting line, no signoff. Just 1-2 short sentences.`;

  const prompt = `You are writing a brief, friendly follow-up message for Squeaky Clean Turf (artificial turf cleaning, Phoenix AZ).

The customer ${customerName} reached out yesterday for a quote but hasn't responded since. Send a low-pressure check-in.

${pricingContext}

Write the message following these RULES:
- Open warmly with their name (no judgment about why they didn't reply).
- Ask if they have any questions or want to lock it in.
- Optionally remind them of the quoted price.
- ${formatRules}
- BRAND VOICE: NO emojis. Don't say "first time customer" — say "the 15% special". Don't say "coordinator" — if you reference the booking handler, say "Dave". Don't confirm any date or imply we're holding a slot.
- Be short. 1-3 sentences for SMS, 3-4 for email max.
- Don't sound like a chatbot or sales pitch. Sound like a friendly local business checking in.

Output the message text only. No explanations, no markers, no quotes around the output.`;

  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();
}

/**
 * Main entry point — find all stalled conversations and nudge each one.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.force]  If true, skip the active-hours gate (for manual runs).
 * @returns {Promise<{count, results, skipped, reason}>}
 */
export async function runStalledLeadNudges({ force = false } = {}) {
  // Kill switch always wins
  if (isKillSwitchActive()) {
    console.log('💤 Nudge run skipped — kill switch active.');
    return { skipped: true, reason: 'kill_switch' };
  }

  // Active-hours gate — don't ping customers at 3 AM
  if (!force && !isWithinActiveHours()) {
    return { skipped: true, reason: 'outside_active_hours' };
  }

  const dryRun = process.env.DRY_RUN !== 'false';

  // Find candidates
  const all = allConversations();
  const candidates = [];
  for (const [conversationId, state] of Object.entries(all)) {
    if (isStalled(state)) candidates.push({ conversationId, state });
  }

  if (candidates.length === 0) {
    return { count: 0, results: [], dryRun };
  }

  console.log(`💌 Stalled-lead nudge: ${candidates.length} candidate(s) (dryRun=${dryRun})`);

  const results = [];
  for (const { conversationId, state } of candidates) {
    // Whitelist gate per contact (same rules as main handler)
    if (!isContactAllowed(state.contactId)) {
      console.log(`💌  ↳ skip ${conversationId} — contact not in whitelist`);
      results.push({ conversationId, status: 'skipped', reason: 'not_whitelisted' });
      continue;
    }

    // LIVE FRESHNESS CHECK: pull GHL conversation to see if anyone has
    // touched it since our last state update. Customer replied? Dave
    // texted them back? Booking was made offline? Any of those = NOT
    // stalled, skip the nudge. This is the primary protection against
    // following up with already-booked customers.
    const isStillStalled = !(await hasFreshGhlActivity(state, conversationId));
    if (!isStillStalled) {
      console.log(`💌  ↳ skip ${conversationId} (${state.customerName}) — fresh GHL activity since our last record, conversation is being handled`);
      // Mark as nudged so we don't keep checking it every 30 min.
      updateState(conversationId, {
        nudged: true,
        nudgedAt: new Date().toISOString(),
        nudgeSkipReason: 'fresh_ghl_activity',
      });
      results.push({ conversationId, status: 'skipped', reason: 'fresh_ghl_activity' });
      continue;
    }

    const channel = pickChannel(state);
    if (!channel) {
      results.push({ conversationId, status: 'skipped', reason: 'no_channel' });
      continue;
    }

    try {
      const message = await generateNudge(state, channel);

      if (dryRun) {
        console.log(`💌  ↳ [DRY RUN] ${state.customerName} via ${channel}: "${message.slice(0, 100)}..."`);
        results.push({ conversationId, status: 'dry_run', channel, preview: message });
        // Don't mark as nudged in dry run — let the user see it and decide
        continue;
      }

      await ghl.sendMessage({
        contactId: state.contactId,
        message,
        type: channel,
        conversationId,
      });

      updateState(conversationId, {
        nudged: true,
        nudgedAt: new Date().toISOString(),
        nudgeMessage: message,
        nudgeChannel: channel,
      });

      console.log(`💌  ↳ Nudged ${state.customerName} (${conversationId}) via ${channel}`);
      results.push({ conversationId, status: 'sent', channel });
    } catch (e) {
      console.error(`❌ Nudge failed for ${conversationId}: ${e.message}`);
      results.push({ conversationId, status: 'failed', error: e.message });
    }
  }

  return { count: candidates.length, results, dryRun };
}
