// Jobber GraphQL API wrapper.
//
// What this does:
//   1. Holds the OAuth refresh token, exchanges it for short-lived access tokens.
//   2. Caches the access token in memory + a file (data/.jobber-token.json) so
//      we don't refresh on every webhook. Refreshes proactively ~5 min before expiry.
//   3. Find-or-create a Client (looked up by phone), then creates a Request
//      with all the booking details attached.
//
// Docs:
//   - OAuth:    https://developer.getjobber.com/docs/build_with_jobber/authentication
//   - GraphQL:  https://developer.getjobber.com/docs/build_with_jobber/graphql_basics
//
// To bootstrap a refresh token for the first time, run:
//   node scripts/jobber-auth.js
//
// Required env vars:
//   JOBBER_CLIENT_ID
//   JOBBER_CLIENT_SECRET
//   JOBBER_REFRESH_TOKEN

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OAUTH_URL = 'https://api.getjobber.com/api/oauth/token';
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
// Pin the GraphQL schema version so Jobber breaking changes don't surprise us.
const GRAPHQL_VERSION = '2023-11-15';

const TOKEN_CACHE_PATH = new URL('../../data/.jobber-token.json', import.meta.url);

// In-memory cache (process lifetime). Refilled from disk on cold start.
let cachedToken = null; // { accessToken, expiresAt (ms epoch), refreshToken }

// ─────────────────────────── token plumbing ───────────────────────────

function loadCachedToken() {
  if (cachedToken) return cachedToken;
  try {
    if (!existsSync(TOKEN_CACHE_PATH)) return null;
    cachedToken = JSON.parse(readFileSync(TOKEN_CACHE_PATH, 'utf8'));
    return cachedToken;
  } catch (e) {
    return null;
  }
}

function saveCachedToken(token) {
  cachedToken = token;
  const dir = dirname(TOKEN_CACHE_PATH.pathname);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(token, null, 2));
}

/**
 * Exchange a refresh token for a fresh access token.
 * Jobber rotates refresh tokens on each refresh — we save the new one too.
 */
async function refreshAccessToken(refreshToken) {
  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET must be set in .env');
  }
  if (!refreshToken) {
    throw new Error('JOBBER_REFRESH_TOKEN missing — run `node scripts/jobber-auth.js` to bootstrap one');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jobber OAuth refresh failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  // Standard OAuth response: access_token, refresh_token, expires_in (seconds)
  const expiresInMs = (data.expires_in || 3600) * 1000;
  // Refresh 5 minutes early so we never serve a stale token.
  const expiresAt = Date.now() + expiresInMs - 5 * 60 * 1000;
  const token = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken, // some servers don't rotate
    expiresAt,
  };
  saveCachedToken(token);
  return token;
}

/**
 * Get a valid access token, refreshing if needed.
 * Reads JOBBER_REFRESH_TOKEN from env on first call; afterwards uses the
 * rotated token from the cache.
 */
async function getAccessToken() {
  const cached = loadCachedToken();
  if (cached && cached.accessToken && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }
  const refreshToken = (cached && cached.refreshToken) || process.env.JOBBER_REFRESH_TOKEN;
  const fresh = await refreshAccessToken(refreshToken);
  return fresh.accessToken;
}

// ─────────────────────────── GraphQL helper ───────────────────────────

async function gql(query, variables = {}) {
  const accessToken = await getAccessToken();
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': GRAPHQL_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jobber GraphQL ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (data.errors && data.errors.length) {
    throw new Error(`Jobber GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// ─────────────────────────── client lookup / create ───────────────────────────

/**
 * Search Jobber for a client matching the given phone number.
 * Returns the first match's ID, or null if not found.
 *
 * Note: Jobber normalizes phones loosely — we strip non-digits before searching
 * to maximize match rate (formatting varies wildly between channels).
 */
async function findClientByPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 7) return null;

  // Jobber's `clients` query supports a `filter` arg. We do a contains search
  // on the last 7 digits (handles +1 country code variations).
  const last7 = digits.slice(-7);
  const query = `
    query SearchClient($search: String!) {
      clients(filter: { searchTerm: $search }, first: 5) {
        nodes { id firstName lastName phones { number } }
      }
    }
  `;
  try {
    const data = await gql(query, { search: last7 });
    const nodes = data?.clients?.nodes || [];
    // Pick the one whose phone digits actually match
    const match = nodes.find((c) =>
      (c.phones || []).some((p) => String(p.number || '').replace(/\D/g, '').endsWith(last7))
    );
    return match?.id || null;
  } catch (e) {
    // If search isn't available in this Jobber plan/schema, fall through to create.
    console.warn(`⚠️  Jobber client search failed (${e.message}) — will create new client instead`);
    return null;
  }
}

/**
 * Create a new client in Jobber.
 */
async function createClient({ firstName, lastName, phone, email, address }) {
  // Build phones array Jobber expects
  const phones = phone ? [{ number: phone, primary: true }] : [];
  const emails = email ? [{ address: email, primary: true }] : [];

  const billingAddress = address ? { street: address } : undefined;

  const input = {
    firstName: firstName || 'Customer',
    lastName: lastName || '(via SCT AI)',
    phones,
    emails,
    ...(billingAddress ? { billingAddress } : {}),
  };

  const mutation = `
    mutation CreateClient($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client { id firstName lastName }
        userErrors { message path }
      }
    }
  `;
  const data = await gql(mutation, { input });
  const errs = data?.clientCreate?.userErrors || [];
  if (errs.length) {
    throw new Error(`Jobber clientCreate userErrors: ${JSON.stringify(errs)}`);
  }
  return data.clientCreate.client.id;
}

// ─────────────────────────── public: createRequest ───────────────────────────

/**
 * Create a Jobber Request for an inbound booking from the AI.
 *
 * @param {Object} args
 * @param {string} args.customerName     - "Marcus" or "Marcus Smith"
 * @param {string} [args.phone]          - any format; we normalize
 * @param {string} [args.email]
 * @param {string} [args.address]        - street address if known
 * @param {string} args.package          - 'winnie' | 'khloe' | 'karl'
 * @param {string} args.packageLabel     - customer-facing label ("deep clean", etc.)
 * @param {number} [args.sqft]
 * @param {number} args.price            - first-time-discount price we quoted
 * @param {string} args.channel          - "SMS" | "Instagram DM" | etc.
 * @param {string} args.conversationId   - GHL conversation ID (for traceback)
 * @returns {Promise<{requestId: string, clientId: string, created: boolean}>}
 */
export async function createRequest({
  customerName,
  phone,
  email,
  address,
  package: pkgId,
  packageLabel,
  sqft,
  price,
  channel,
  conversationId,
}) {
  // Split "Marcus Smith" → first/last; default last to "(via SCT AI)" so
  // Dalis can spot AI-created records at a glance in Jobber.
  const [firstName, ...rest] = (customerName || '').trim().split(/\s+/);
  const lastName = rest.length ? rest.join(' ') : '(via SCT AI)';

  // 1. Find or create client
  let clientId = await findClientByPhone(phone);
  let createdClient = false;
  if (!clientId) {
    clientId = await createClient({
      firstName: firstName || 'Customer',
      lastName,
      phone,
      email,
      address,
    });
    createdClient = true;
  }

  // 2. Create the Request
  const title = `[AI BOOKING] ${packageLabel} — ${firstName || 'Customer'}${sqft ? ` (${sqft} sq ft)` : ''}`;
  const ghlLink = `https://app.gohighlevel.com/conversations/${conversationId}`;
  const description = [
    `📦 Package picked: ${packageLabel} (internal: ${pkgId})`,
    sqft ? `📐 Sq ft: ${sqft}` : null,
    `💵 Price quoted (first-time discount applied): $${price}`,
    `📨 Channel: ${channel}`,
    `🔗 GHL conversation: ${ghlLink}`,
    '',
    'Customer accepted this quote via the AI sales agent.',
    'Coordinator: please contact customer to lock in a date.',
  ].filter(Boolean).join('\n');

  const input = {
    clientId,
    title,
    request: {
      title,
      // Jobber uses `companyName` / `description` on the underlying RequestCreate input.
      // The exact shape varies by GraphQL version; we keep the title/description
      // pair which is the stable surface.
      description,
      source: 'AI Sales Agent (SCT)',
    },
  };

  // Try the modern shape first, fall back to legacy if Jobber rejects it.
  // Jobber has shifted RequestCreate inputs over schema versions; we send a
  // conservative shape that works on 2023-11-15.
  const mutation = `
    mutation CreateRequest($clientId: EncodedId!, $title: String!, $description: String!) {
      requestCreate(input: {
        clientId: $clientId
        title: $title
        description: $description
        source: "AI Sales Agent (SCT)"
      }) {
        request { id title }
        userErrors { message path }
      }
    }
  `;
  const data = await gql(mutation, { clientId, title, description });
  const errs = data?.requestCreate?.userErrors || [];
  if (errs.length) {
    throw new Error(`Jobber requestCreate userErrors: ${JSON.stringify(errs)}`);
  }

  return {
    requestId: data.requestCreate.request.id,
    clientId,
    created: true,
    createdClient,
  };
}

// ─────────────────────────── exposed for tests / debugging ───────────────────────────
export const _internal = {
  refreshAccessToken,
  getAccessToken,
  findClientByPhone,
  createClient,
  gql,
};
