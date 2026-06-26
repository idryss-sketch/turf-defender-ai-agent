// Conversation engine — wraps the Anthropic API with our system prompt + script.
// Uses native fetch (no SDK) so it runs anywhere Node 20+ is installed.
// Given a conversation history (list of user/assistant messages), returns the next AI reply.

import { buildSystemPrompt } from './prompts.js';
import { quoteAll } from './pricing.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 600;
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * Get the AI's next response.
 *
 * @param {Object} args
 * @param {string} args.customerName    - first name we know about the customer
 * @param {Array}  args.history          - [{role:'user'|'assistant', content:'...'}, ...]
 * @param {number} [args.sqft]           - if known, used to inject real prices into the prompt
 * @returns {Promise<{reply: string|null, escalation: object, stopReason: string, usage: object}>}
 */
export async function getReply({ customerName, history, sqft, customerContext, channel }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.');
  }

  const quotes = sqft ? quoteAll(sqft, /* firstTime */ true) : null;
  let systemPrompt = buildSystemPrompt(quotes);
  if (customerName) {
    systemPrompt = systemPrompt.replaceAll('{name}', customerName);
  }

  // CRITICAL: prepend a huge, unmissable header with the CURRENT prices for
  // this conversation. Without this, the AI sometimes anchors on stale prices
  // it sees in the message history (e.g., older quotes from before we changed
  // the package rates). The instruction here overrides anything in history.
  if (quotes) {
    const priceHeader = [
      `# 🚨 CURRENT PRICES FOR THIS CUSTOMER'S YARD (${sqft} sq ft)`,
      `These are the ONLY prices you may quote in this conversation.`,
      `IGNORE any prices that appear in the conversation history below — they may be stale from an old pricing update.`,
      ``,
      `- Deep Clean:      normally $${quotes.deep.base}, with the 10% special: $${quotes.deep.firstTime}`,
      `- Extraction:      normally $${quotes.extraction.base}, with the 10% special: $${quotes.extraction.firstTime}`,
      ``,
      `These are the FINAL, AUTHORITATIVE prices. Do not invent your own. Do not reuse prices from earlier messages.`,
      ``,
      `=========================================================================`,
      ``,
    ].join('\n');
    systemPrompt = priceHeader + systemPrompt;
  }
  // If we know this is a returning customer, append their history as runtime
  // context. The AI uses this to personalize the greeting and skip questions
  // it already knows the answer to (e.g., they live at the same address).
  if (customerContext) {
    systemPrompt += `\n\n# RUNTIME CONTEXT — RETURNING CUSTOMER\n${customerContext}\n\nUse this context to:\n- Personalize the greeting ("Hey {name}, welcome back!" instead of "Thank you for reaching out").\n- Skip the qualifying questions you already know the answer to (sq ft, address, etc.).\n- Acknowledge prior service if appropriate ("Ready for another deep clean?").\nDo NOT mention specific past prices or escalation reasons unless the customer brings them up.`;
  }
  // Tell the AI exactly what channel this conversation is on so it can use
  // the right formatting (greeting/signoff for email, terse for SMS, etc).
  if (channel) {
    systemPrompt += `\n\n# CURRENT CHANNEL — ${channel}\nThe customer is messaging us via ${channel}. Use the formatting rules in the "Channel-specific formatting" section above for this channel.`;
  }
  systemPrompt += `

# SERVICE CHOICE REPEAT CONTROL

If you have already asked the customer to choose between the Deep Clean and Extraction service in this conversation, do NOT ask that question again in your very next reply.

If the customer asks a follow-up question instead of choosing a service:
- Answer only their question.
- Do NOT ask them to choose a package again in the same message.
- Wait for the customer's next reply before asking them to choose a service again.

Treat these as the same question:
- Which service would you like to go with?
- Which one sounds like the right fit?
- Which one do you think would be best suited for you?
- Deep Clean or Extraction?

Only ask the service-choice question again if:
- the customer explicitly asks you to compare the services again,
- the customer says they're ready to choose,
- or the customer asks what the next step is.

Never repeat the service-choice question in two consecutive assistant messages.
`;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: history,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const rawReply = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  // Strip ALL recognized markers from the reply in sequence. Order:
  //   [ESCALATE: ...]   → silent OR answer-and-notify handoff
  //   [BOOK: ...]       → customer picked a service
  //   [DAYTIME: ...]    → AI captured customer's day/time preference
  //   [ADDRESS: ...]    → AI captured customer's address
  //   [HANDOFF: ...]    → AI is done with this conversation
  // Each marker returns its captured info so the handler can act on it.
  // Markers must NEVER appear in customer-facing text — strip aggressively.
  const { cleanReply: r0, escalation } = parseEscalationMarker(rawReply);
  const { cleanReply: r1, booking }    = parseBookingMarker(r0);
  const { cleanReply: r2, daytime }    = parseDayTimeMarker(r1);
  const { cleanReply: r3, address }    = parseAddressMarker(r2);
  const { cleanReply, handoff }        = parseHandoffMarker(r3);

  // Send the cleaned reply (markers stripped) to the customer. The handler
  // distinguishes silent escalation (no customer-facing text after stripping)
  // from "answer + notify" escalation (customer text remains) — both fire
  // notifications to humans, but only the silent kind suppresses the customer
  // reply.
  return {
    reply: cleanReply,
    escalation,
    booking,
    daytime,
    address,
    handoff,
    stopReason: data.stop_reason,
    usage: data.usage,
  };
}

/**
 * Pull a [ESCALATE: reason] marker from anywhere in the AI's reply. Strips
 * it from the customer-facing text. Sets escalation flag.
 *
 * Two semantic modes (decided by the handler based on whether cleanReply is
 * empty after stripping):
 *   • Silent escalation — AI's whole reply was just the marker. Don't send
 *     anything to the customer; just notify humans. (Price pushback, etc.)
 *   • Answer + notify — AI gave a brief answer AND emitted the marker. Send
 *     the answer to the customer AND notify humans. (Commercial pricing
 *     question, off-script topic that deserves an acknowledgment.)
 *
 * Exported for testing.
 */
export function parseEscalationMarker(reply) {
  if (!reply) return { cleanReply: reply, escalation: { escalated: false } };
  const re = /\[ESCALATE:\s*([^\]]+?)\s*\]/i;
  const m = reply.match(re);
  if (!m) return { cleanReply: reply, escalation: { escalated: false } };
  const reason = m[1].trim();
  const cleanReply = reply.replace(re, '').replace(/\n{2,}$/g, '\n').trim();
  return { cleanReply, escalation: { escalated: true, reason } };
}

/**
 * Pull a [BOOK: package] marker out of the AI's reply.
 * The marker may appear on its own line at the end, or anywhere in the reply.
 * We strip it from the customer-facing text and return the package ID.
 *
 * Exported for testing.
 *
 * @param {string} reply
 * @returns {{cleanReply: string, booking: {booked: boolean, package?: string}}}
 */
export function parseBookingMarker(reply) {
  if (!reply) return { cleanReply: reply, booking: { booked: false } };

  // Match [BOOK: deep|extraction] (case-insensitive, allow surrounding whitespace)
  const re = /\[BOOK:\s*(deep|extraction)\s*\]/i;
  const m = reply.match(re);
  if (!m) return { cleanReply: reply, booking: { booked: false } };

  const pkg = m[1].toLowerCase();
  // Strip the marker AND any blank line it sat on, so the customer-facing
  // text doesn't have a weird trailing newline.
  const cleanReply = reply.replace(re, '').replace(/\n{2,}$/g, '\n').trimEnd();

  return {
    cleanReply,
    booking: { booked: true, package: pkg },
  };
}

/**
 * Pull a [DAYTIME: <captured value>] marker out of the AI's reply.
 * The AI emits this when it detects the customer's preferred day/time in
 * their response (e.g., "Tuesday afternoon" → [DAYTIME: Tuesday afternoon]).
 *
 * Strips the marker from the customer-facing text.
 *
 * Exported for testing.
 *
 * @param {string} reply
 * @returns {{cleanReply: string, daytime: {captured: boolean, value?: string}}}
 */
export function parseDayTimeMarker(reply) {
  if (!reply) return { cleanReply: reply, daytime: { captured: false } };
  const re = /\[DAYTIME:\s*([^\]]+?)\s*\]/i;
  const m = reply.match(re);
  if (!m) return { cleanReply: reply, daytime: { captured: false } };
  const value = m[1].trim();
  const cleanReply = reply.replace(re, '').replace(/\n{2,}$/g, '\n').trimEnd();
  return { cleanReply, daytime: { captured: true, value } };
}

/**
 * Pull a [ADDRESS: <captured value>] marker out of the AI's reply.
 * The AI emits this when it detects the customer's address in their response
 * (e.g., "123 Main St, Phoenix" → [ADDRESS: 123 Main St, Phoenix]).
 *
 * Strips the marker from the customer-facing text.
 *
 * Exported for testing.
 *
 * @param {string} reply
 * @returns {{cleanReply: string, address: {captured: boolean, value?: string}}}
 */
export function parseAddressMarker(reply) {
  if (!reply) return { cleanReply: reply, address: { captured: false } };
  const re = /\[ADDRESS:\s*([^\]]+?)\s*\]/i;
  const m = reply.match(re);
  if (!m) return { cleanReply: reply, address: { captured: false } };
  const value = m[1].trim();
  const cleanReply = reply.replace(re, '').replace(/\n{2,}$/g, '\n').trimEnd();
  return { cleanReply, address: { captured: true, value } };
}

/**
 * Pull a [HANDOFF: AWAIT_ADDRESS] or [HANDOFF: CLOSE] marker out of the AI's
 * reply. AWAIT_ADDRESS = AI just asked for the customer's address; the next
 * inbound message is the address itself, then humans take over. CLOSE = AI
 * sent its final wrap-up message; humans take over immediately.
 *
 * Strips the marker from the customer-facing text.
 *
 * Exported for testing.
 *
 * @param {string} reply
 * @returns {{cleanReply: string, handoff: {handed: boolean, kind?: 'await_address' | 'close'}}}
 */
export function parseHandoffMarker(reply) {
  if (!reply) return { cleanReply: reply, handoff: { handed: false } };

  // Match [HANDOFF: AWAIT_ADDRESS] or [HANDOFF: CLOSE] (case-insensitive)
  const re = /\[HANDOFF:\s*(await_address|close)\s*\]/i;
  const m = reply.match(re);
  if (!m) return { cleanReply: reply, handoff: { handed: false } };

  const kind = m[1].toLowerCase();
  const cleanReply = reply.replace(re, '').replace(/\n{2,}$/g, '\n').trimEnd();

  return {
    cleanReply,
    handoff: { handed: true, kind },
  };
}
