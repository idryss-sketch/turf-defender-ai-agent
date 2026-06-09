// GoHighLevel v2 API wrapper.
// Uses a Private Integration Token (PIT). Generate one at:
//   GHL → Settings → Private Integrations → Create New Integration
// Required scopes:
//   contacts.readonly, conversations.readonly, conversations.write,
//   conversations/message.readonly, conversations/message.write
//
// Required env vars:
//   GHL_API_KEY          — the PIT (looks like "pit-xxx-xxx-xxx")
//   GHL_LOCATION_ID      — your location id (e.g. "tcHe2IpdPJh0jICpLSTA")
//
// Docs: https://marketplace.gohighlevel.com/docs/

const BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28'; // standard for conversations/contacts endpoints

function authHeaders() {
  const key = process.env.GHL_API_KEY;
  if (!key) throw new Error('GHL_API_KEY not set');
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Version': API_VERSION,
    'Accept': 'application/json',
  };
}

function locationId() {
  const id = process.env.GHL_LOCATION_ID;
  if (!id) throw new Error('GHL_LOCATION_ID not set');
  return id;
}

/**
 * Send an outbound message to a contact through GHL.
 * Channel auto-routes based on the type passed.
 *
 * For SMS / IG / FB / WhatsApp: sends `message` (plain text).
 * For Email: sends `html` (formatted) + `subject` — GHL's email API
 *            requires html+subject, not the `message` field.
 *
 * Email threading: when emailMessageId AND/OR threadId are provided, we
 * include them in the body so the reply lands in the same Gmail/Outlook
 * thread. If the threaded send 4xxs (e.g. GHL can't find the referenced
 * email), we automatically retry WITHOUT the threading fields so the
 * reply still goes out — better an un-threaded reply than no reply.
 *
 * Returns the parsed JSON response.
 */
export async function sendMessage({ contactId, message, type = 'SMS', subject, replyMessageId, emailMessageId, threadId, conversationId }) {
  const body = { type, contactId };
  if (type === 'Email') {
    // Convert plain text to minimal HTML so GHL accepts it. Preserve line
    // breaks. Subject defaults to a sensible "Re:" prefixed line — Gmail/
    // Outlook also use the In-Reply-To/References headers (built from
    // emailMessageId below) when available, but the matching subject is the
    // best client-side fallback if header threading fails.
    const html = textToHtml(message);
    body.html = html;
    body.subject = subject || 'Re: Squeaky Clean Turf — your quote';
    // Some GHL versions also accept `message` as a fallback plain-text body
    body.message = message;
    // Tell GHL which conversation this outbound belongs to. Helps GHL
    // associate the reply with the existing thread on its side.
    if (conversationId) body.conversationId = conversationId;
    // Threading: replyMessageId is the GHL message id of the CUSTOMER's
    // last inbound email (resolved by findCustomerEmailMessage upstream).
    // GHL builds the proper In-Reply-To / References headers from this.
    // Note: meta.email.messageIds in the listing API are GHL internal IDs,
    // not RFC822 Message-IDs, so we DON'T pass emailMessageId — it would
    // be ignored or rejected.
    if (replyMessageId) body.replyMessageId = replyMessageId;
    if (threadId) body.threadId = threadId;
  } else {
    body.message = message;
  }
  const res = await fetch(`${BASE}/conversations/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    // If we tried to thread an email and GHL couldn't find the referenced
    // message (404 / "not found"), strip the threading fields and retry so
    // the reply still goes out — better un-threaded than dropped.
    const looksLikeThreadingFailure = type === 'Email' && (
      (res.status === 404 && /not found/i.test(err)) ||
      /emailmessage.*not found/i.test(err) ||
      /invalid.*emailmessageid/i.test(err) ||
      /invalid.*replymessageid/i.test(err)
    );
    if (looksLikeThreadingFailure && (body.emailMessageId || body.replyMessageId || body.threadId)) {
      // Known GHL limitation: the conversation-message IDs in the listing API
      // aren't recognized by the reply endpoint. Silently retry without
      // threading fields — better an un-threaded reply than no reply.
      // Logged at info-level (not warn) since this is expected behavior.
      console.log(`ℹ️  GHL reply threading not available for this message (${res.status}) — sending as new thread.`);
      delete body.emailMessageId;
      delete body.replyMessageId;
      delete body.threadId;
      const retry = await fetch(`${BASE}/conversations/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!retry.ok) {
        const retryErr = await retry.text();
        throw new Error(`GHL sendMessage ${retry.status} (retry without threading): ${retryErr}`);
      }
      return retry.json();
    }
    throw new Error(`GHL sendMessage ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * Find the most recent INBOUND email message ID in a list of GHL messages.
 * Used to thread our reply to that message (so Gmail/Outlook keeps
 * everything in one email conversation).
 *
 * Returns the GHL message ID or null if no inbound email found.
 * (Kept for backward compatibility — prefer getEmailReplyTargets which
 * returns BOTH the GHL id AND the RFC822 Message-ID.)
 */
export function getReplyTargetMessageId(messages, channel = 'Email') {
  const t = getEmailReplyTargets(messages);
  return t ? (t.replyMessageId || null) : null;
}

/**
 * Pull the threading fields from the most recent INBOUND email in history.
 *
 * Returns:
 *   {
 *     replyMessageId: <GHL message id>,
 *     emailMessageId: <RFC822 Message-ID, e.g. "<CAH...@mail.gmail.com>">,
 *     threadId:       <GHL conversation/thread id, if exposed>,
 *   }
 * or null if no inbound email is present.
 *
 * GHL stores the RFC822 Message-ID in meta.email.messageIds[] (an array,
 * since one email can have multiple Message-IDs across forwards/replies).
 * We use the FIRST entry (most authoritative — it's the original sender's
 * Message-ID) as the In-Reply-To target so Gmail/Outlook properly thread.
 */
export function getEmailReplyTargets(messages, options = {}) {
  // Backward-compat: if called with no options, just look for the newest
  // inbound email. Better to call with { triggerBody, aiSentMessageIds }.
  const { triggerBody = null, aiSentMessageIds = [] } = options;
  if (!Array.isArray(messages)) return null;

  const target = findCustomerEmailMessage(messages, { triggerBody, aiSentMessageIds });
  if (!target) return null;

  const metaEmail = target.meta?.email || target.email || {};
  return {
    replyMessageId: target.id || target.messageId || null,
    threadId: target.threadId || metaEmail.threadId || null,
  };
}

/**
 * Find the customer's actual email message in history.
 *
 * Why this is non-trivial: GHL labels its OWN outbound email sends with
 * direction: "inbound" in the message-listing API (confirmed via diagnostic
 * logs in May 2026). So a naive "newest inbound email" filter picks our
 * previous AI reply — and GHL's reply API 404s when you try to thread to
 * your own send.
 *
 * Strategy:
 *   1. If triggerBody is provided (the body of the message that just fired
 *      the webhook), exact-body-match against history. That uniquely
 *      identifies the customer's most recent email regardless of GHL's
 *      direction labeling. (Best signal.)
 *   2. Otherwise, walk inbound emails newest-first and skip any whose id
 *      is in our aiSentMessageIds list (i.e., messages we sent ourselves).
 *
 * Returns the message object or null.
 */
function findCustomerEmailMessage(messages, { triggerBody = null, aiSentMessageIds = [] } = {}) {
  if (!Array.isArray(messages)) return null;

  // Strategy 1: body match against the webhook's trigger body. Most reliable.
  if (triggerBody) {
    const target = String(triggerBody).trim();
    // Exact match
    for (const m of messages) {
      if (!m.body) continue;
      if (m.body.trim() === target) return m;
    }
    // Prefix match (some clients append quoted history below)
    if (target.length > 40) {
      const prefix = target.slice(0, 80).trim();
      for (const m of messages) {
        if (!m.body) continue;
        if (m.body.trim().startsWith(prefix)) return m;
      }
    }
  }

  // Strategy 2: newest non-our-own inbound email.
  const aiSet = new Set((aiSentMessageIds || []).filter(Boolean));
  for (const m of messages) {
    if (m.direction !== 'inbound') continue;
    const t = String(m.messageType || m.type || '').toUpperCase();
    const isEmail = t.includes('EMAIL') || t === '3' || t === '2';
    if (!isEmail) continue;
    const id = m.id || m.messageId;
    if (id && aiSet.has(id)) continue; // skip our own outbound (mislabeled by GHL)
    return m;
  }
  return null;
}

/**
 * Async version kept for compat with the webhook caller. Now just delegates
 * to the sync version since we no longer need the per-message-detail fetch
 * (GHL doesn't store RFC822 Message-IDs in either endpoint anyway).
 */
export async function resolveEmailReplyTargets(messages, options = {}) {
  return getEmailReplyTargets(messages, options);
}

/**
 * Convert AI's plain-text reply (with newlines) to minimal HTML for email.
 * Preserves paragraphs and line breaks. Doesn't add extra styling — keeps
 * the email looking like a personal reply, not a marketing template.
 */
function textToHtml(text) {
  if (!text) return '';
  // Escape HTML special chars first
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Split on double newlines into paragraphs, single newlines become <br>
  const paragraphs = escaped.split(/\n\s*\n/).map((p) => {
    const withBreaks = p.trim().replace(/\n/g, '<br>');
    return `<p>${withBreaks}</p>`;
  });
  return paragraphs.join('\n');
}

/**
 * GHL's send-message response shape varies by API version. Pull the new
 * message's id from any of the common locations.
 */
export function extractMessageId(sendMessageResponse) {
  if (!sendMessageResponse || typeof sendMessageResponse !== 'object') return null;
  return (
    sendMessageResponse.messageId ||
    sendMessageResponse.id ||
    sendMessageResponse.messageDetails?.id ||
    sendMessageResponse.messageDetails?.messageId ||
    null
  );
}

/**
 * Fetch contact details by ID.
 */
export async function getContact(contactId) {
  const res = await fetch(`${BASE}/contacts/${contactId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL getContact ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.contact || data;
}

/**
 * Find a contact's most recent conversation ID via GHL search.
 * Used when the webhook payload doesn't include conversationId directly —
 * some GHL workflow trigger versions don't expose conversation.id as a variable,
 * so the workflow sends contact.id as a placeholder and we resolve here.
 *
 * Returns the most recent conversationId for that contact, or null if none.
 */
export async function findConversationByContact(contactId) {
  // v2 search endpoint requires locationId in querystring.
  const url = `${BASE}/conversations/search?locationId=${encodeURIComponent(locationId())}&contactId=${encodeURIComponent(contactId)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL findConversationByContact ${res.status}: ${err}`);
  }
  const data = await res.json();
  const conversations = data.conversations || [];
  if (!conversations.length) return null;
  // Prefer the one with the latest lastMessageDate / dateUpdated if available.
  const sorted = [...conversations].sort((a, b) => {
    const ta = new Date(a.lastMessageDate || a.dateUpdated || a.dateAdded || 0).getTime();
    const tb = new Date(b.lastMessageDate || b.dateUpdated || b.dateAdded || 0).getTime();
    return tb - ta;
  });
  return sorted[0].id || null;
}

/**
 * Fetch recent messages from a conversation.
 * Returns newest-first; we'll reverse for AI context.
 */
export async function getMessages(conversationId, limit = 20) {
  const res = await fetch(
    `${BASE}/conversations/${conversationId}/messages?limit=${limit}`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL getMessages ${res.status}: ${err}`);
  }
  const data = await res.json();
  // v2 response shape can be either:
  //   { messages: [...] }                            (flat)
  //   { messages: { messages: [...], nextPage: ... } } (nested — actual v2 docs shape)
  // Handle both defensively.
  if (Array.isArray(data.messages)) return data.messages;
  if (data.messages && Array.isArray(data.messages.messages)) return data.messages.messages;
  return [];
}

/**
 * Filter GHL messages to a recent time window so returning customers don't
 * trigger AI behavior (like escalation) based on stale prior interactions.
 *
 * Default window: 14 days, max 10 messages. If a customer hasn't messaged in
 * >daysWindow days, history is empty → AI treats it as a fresh conversation.
 */
export function filterRecentMessages(messages, { daysWindow = 14, maxCount = 10 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const cutoff = Date.now() - daysWindow * 24 * 60 * 60 * 1000;
  return messages
    .filter((m) => {
      const ts = new Date(m.dateAdded || m.dateCreated || m.createdAt || 0).getTime();
      return ts > 0 && ts >= cutoff;
    })
    .slice(0, maxCount);
}

/**
 * Translate GHL message history into the user/assistant format Claude expects.
 * Inbound (from customer) → 'user', Outbound (from us) → 'assistant'.
 */
export function ghlMessagesToClaudeHistory(messages) {
  // GHL returns newest first — reverse to chronological
  const chrono = [...messages].reverse();
  return chrono
    .filter((m) => m.body && m.body.trim())
    .map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    }));
}

/**
 * Map GHL channel/messageType to a label for the system prompt.
 */
export function channelLabel(messageType) {
  const map = {
    SMS: 'SMS',
    Email: 'Email',
    WhatsApp: 'WhatsApp',
    IG: 'Instagram DM',
    FB: 'Facebook DM',
    Custom: 'Web chat',
    'Live Chat': 'Web chat',
  };
  return map[messageType] || messageType;
}

/**
 * Normalize GHL's various messageType representations to the strings
 * accepted by the send-message API: SMS | Email | WhatsApp | IG | FB | Custom.
 *
 * GHL uses different naming in different places — message history might have
 * "TYPE_SMS" or numeric codes; the send endpoint expects shorthand.
 */
export function normalizeChannel(rawType) {
  if (rawType == null || rawType === '') return null;
  const t = String(rawType).toUpperCase().trim();

  // Numeric type codes (some GHL responses return type as a number)
  const numericMap = {
    '1': 'SMS',
    '2': 'Email', '3': 'Email',
    '4': 'IG', '7': 'IG',
    '5': 'FB', '8': 'FB',
    '6': 'WhatsApp',
    '25': 'Custom', // Live Chat
  };
  if (numericMap[t]) return numericMap[t];

  // String pattern matching (case-insensitive, prefix-tolerant)
  if (t.includes('SMS')) return 'SMS';
  if (t.includes('EMAIL')) return 'Email';
  if (t.includes('INSTAGRAM') || t === 'IG' || t === 'IG_DM') return 'IG';
  if (t.includes('FACEBOOK') || t.includes('MESSENGER') || t === 'FB' || t === 'FB_DM') return 'FB';
  if (t.includes('WHATSAPP')) return 'WhatsApp';
  if (t.includes('LIVE_CHAT') || t.includes('LIVECHAT') || t === 'CUSTOM') return 'Custom';
  return null; // unknown — caller decides fallback
}

/**
 * Detect if a HUMAN (Dalis, Dave, or any other GHL user) has typed a reply
 * directly in GHL — meaning we should stop the AI for this conversation.
 *
 * Strategy: only check the MOST RECENT outbound message. If a human took
 * over, their reply will be the latest outbound. We use two signals:
 *   1. Message ID match — we track the IDs returned from our sendMessage
 *      calls. If the latest outbound's id is in our list, we sent it.
 *   2. userId presence — when a logged-in GHL user types a reply via the
 *      GHL UI, the message has a userId field set. PIT API sends don't.
 *
 * False-positive bias: we'd rather LET the AI keep replying than silently
 * bail by mistake. So we only flag if userId is clearly set AND the
 * message id isn't ours. Body comparison was unreliable (GHL re-formats
 * whitespace/markdown), removed.
 */
export function detectHumanTakeover(messages, aiSentMessageIds = []) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const aiIdSet = new Set(aiSentMessageIds.filter(Boolean));

  // GHL returns messages newest-first.
  const outbounds = messages.filter((m) => m.direction === 'outbound');
  if (outbounds.length === 0) return null;

  const latestOutbound = outbounds[0];
  const latestId = latestOutbound.id || latestOutbound.messageId;
  const latestSentByUs = !!(latestId && aiIdSet.has(latestId));

  // Check ALL outbounds — flag as human takeover ONLY if a logged-in GHL
  // user (Dave or Dalis) actually typed a reply. Auto-replies (form
  // submission confirmations, workflow-triggered messages) don't have a
  // userId, so they don't count as human takeover.
  for (const m of outbounds) {
    const id = m.id || m.messageId;
    const isOurs = !!(id && aiIdSet.has(id));
    if (isOurs) continue;
    // userId being a non-empty string indicates a logged-in human user typed
    // this message via the GHL UI. Auto-replies and API sends don't have it.
    const sentByGhlUser = !!m.userId && String(m.userId).length > 0;
    if (sentByGhlUser) {
      return { source: 'userId', message: m };
    }
  }
  return null;
}

/**
 * Find the channel of the most recent inbound message in the conversation —
 * used to derive the channel when the workflow webhook doesn't include
 * messageType as a variable (some GHL trigger versions don't expose it).
 *
 * Returns the GHL send-API channel string (SMS | IG | FB | Email | etc.)
 * or null if no message of any kind is found.
 *
 * Strategy:
 *   1. Most recent INBOUND message's channel (best signal — that's what the
 *      customer is using right now).
 *   2. Most recent OUTBOUND message's channel (we've been talking to them
 *      this way, so reply on the same channel).
 *   3. null (caller falls back to the workflow-provided messageType).
 *
 * The fallback to outbound matters for IG/FB where GHL's history endpoint
 * sometimes hasn't indexed the inbound that just triggered the webhook —
 * but our prior outbounds ARE indexed and tell us the channel.
 */
export function getLastInboundChannel(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  // GHL returns newest-first; the first inbound is the most recent customer message.
  const lastInbound = messages.find((m) => m.direction === 'inbound');
  if (lastInbound) {
    const raw = lastInbound.messageType ?? lastInbound.type ?? lastInbound.channel;
    const ch = normalizeChannel(raw);
    if (ch) return ch;
  }
  // Fallback: latest outbound message — tells us how we've been replying.
  const lastOutbound = messages.find((m) => m.direction === 'outbound');
  if (lastOutbound) {
    const raw = lastOutbound.messageType ?? lastOutbound.type ?? lastOutbound.channel;
    const ch = normalizeChannel(raw);
    if (ch) return ch;
  }
  return null;
}
