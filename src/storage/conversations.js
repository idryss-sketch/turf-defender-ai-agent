// Per-conversation state store.
//
// Architecture: in-memory cache backed by Postgres.
//   • Cache is loaded from DB on boot (loadAllConversations).
//   • Reads (getState) are sync and hit the cache.
//   • Writes (updateState) update the cache synchronously AND fire an async
//     write-through to Postgres (no await needed at call sites).
//
// This lets us keep the existing sync getState/updateState API everywhere in
// the codebase while gaining real persistence across redeploys.

import { saveConversation } from './db.js';

const cache = {};

/**
 * Hydrate the in-memory cache from the DB. Called once at server boot.
 */
export function hydrateCache(loaded) {
  for (const [id, state] of Object.entries(loaded || {})) {
    cache[id] = state;
  }
}

/**
 * Get the saved state for a conversation. Always returns an object.
 */
export function getState(conversationId) {
  if (!conversationId) return {};
  return cache[conversationId] || {};
}

/**
 * Merge new fields into a conversation's saved state.
 * Returns the new state (sync). Persists to Postgres in the background.
 */
export function updateState(conversationId, patch) {
  if (!conversationId) return {};
  const existing = cache[conversationId] || {};
  const now = new Date().toISOString();
  const next = {
    // Stamp createdAt only on first ever update for this conversation —
    // used by the time-to-book widget on the dashboard.
    ...(existing.createdAt ? {} : { createdAt: now }),
    ...existing,
    ...patch,
    lastUpdated: now,
  };
  cache[conversationId] = next;

  // Fire-and-forget write-through to Postgres. Failures are logged but don't
  // throw — the in-memory cache stays consistent for this request.
  saveConversation(conversationId, next).catch((e) => {
    console.warn(`⚠️  Postgres saveConversation failed for ${conversationId}: ${e.message}`);
  });

  return next;
}

/**
 * Return the full cache (used by /api/conversations and /api/stats endpoints).
 */
export function allConversations() {
  return { ...cache };
}

/**
 * Find prior conversations for a given GHL contactId, EXCLUDING the current
 * conversation. Used to give the AI lifetime memory of a returning customer.
 *
 * Returns an array of { conversationId, ...state }, newest first.
 */
export function getConversationsByContact(contactId, excludeConversationId = null) {
  if (!contactId) return [];
  return Object.entries(cache)
    .filter(([id, state]) => state.contactId === contactId && id !== excludeConversationId)
    .map(([id, state]) => ({ conversationId: id, ...state }))
    .sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));
}

/**
 * Build a short customer-history summary the AI can use to personalize the
 * greeting and avoid re-asking things we already know. Returns null if there
 * are no prior conversations.
 */
export function buildCustomerContext(contactId, excludeConversationId = null) {
  const priors = getConversationsByContact(contactId, excludeConversationId);
  if (priors.length === 0) return null;

  const lines = [];
  lines.push(`Returning customer — ${priors.length} prior conversation${priors.length === 1 ? '' : 's'} on file.`);

  // Last booking
  const lastBooking = priors.find((p) => p.booked);
  if (lastBooking) {
    const pkg = lastBooking.bookingPackage || 'service';
    const price = lastBooking.bookingPrice ? `$${lastBooking.bookingPrice}` : 'price unknown';
    const sqft = lastBooking.sqft ? `${lastBooking.sqft} sq ft` : 'size unknown';
    const when = lastBooking.bookingTimestamp
      ? new Date(lastBooking.bookingTimestamp).toLocaleDateString()
      : 'unknown date';
    lines.push(`Last booking: ${pkg} (${sqft}, ${price}) on ${when}.`);
  } else {
    lines.push(`No prior bookings — they've reached out before but didn't book.`);
  }

  // Prior escalations
  const escalations = priors.filter((p) => p.escalated && !p.booked);
  if (escalations.length > 0) {
    const reasons = [...new Set(escalations.map((e) => e.escalationReason).filter(Boolean))];
    if (reasons.length) {
      lines.push(`Prior escalation reason${reasons.length === 1 ? '' : 's'}: ${reasons.join('; ')}.`);
    }
  }

  // Most recent address (for handoff convenience)
  const lastAddress = priors.map((p) => p.address).find((a) => !!a);
  if (lastAddress) {
    lines.push(`Last known address: ${lastAddress}.`);
  }

  return lines.join('\n');
}

/**
 * Try to extract sq ft from a customer message.
 *
 * Two strategies:
 *   1. Explicit sq ft: "600 sq ft", "1200 sqft", "about 800 square feet".
 *   2. Dimensions: "12x12", "12 x 12", "20 by 30", "12'x12'", "12 ft x 10 ft".
 *      Multiplies the two dimensions to compute total sq ft.
 *
 * Explicit values win over dimensions if both appear in the same message.
 *
 * Returns a number, or null if not found.
 */
export function extractSqft(text) {
  if (!text) return null;

  // Strategy 1: explicit "X sqft" patterns (preferred — most precise)
  // Handles BOTH "1500 sqft" (number first) AND "Sqft: 1500" (label first,
  // common in form-submission bodies).
  const sqftPatterns = [
    // Number-first: "1500 sqft", "1500 sq ft", "1500 square feet", "1500 sf"
    /([\d,]{2,5})\s*sq\.?\s*ft/i,
    /([\d,]{2,5})\s*sqft/i,
    /([\d,]{2,5})\s*square\s*f(?:ee|oo)?t/i,
    /([\d,]{2,5})\s*sf\b/i,
    // Label-first: "Sqft: 1500", "sq ft: 1500", "Square footage: 1500"
    /sq\.?\s*ft\s*[:=]\s*([\d,]{2,5})/i,
    /sqft\s*[:=]\s*([\d,]{2,5})/i,
    /square\s*footage\s*[:=]\s*([\d,]{2,5})/i,
    /yard\s*size\s*[:=]\s*([\d,]{2,5})/i,
  ];
  for (const re of sqftPatterns) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isNaN(n) && n >= 50 && n <= 50000) return n;
    }
  }

  // Strategy 2: dimension patterns
  const dimRe = /(\d{1,3})\s*(?:'|ft\b|feet\b|′)?\s*(?:x|×|by)\s*(\d{1,3})\s*(?:'|ft\b|feet\b|′)?/i;
  const dimMatch = text.match(dimRe);
  if (dimMatch) {
    const a = parseInt(dimMatch[1], 10);
    const b = parseInt(dimMatch[2], 10);
    if (
      !isNaN(a) && !isNaN(b) &&
      a >= 3 && a <= 500 &&
      b >= 3 && b <= 500
    ) {
      const total = a * b;
      if (total >= 9 && total <= 50000) return total;
    }
  }

  return null;
}
