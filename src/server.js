// SCT Sales Agent — HTTP server.
// Listens for GHL webhooks and routes them to the conversation engine.
//
// Run locally:    node src/server.js
// Default port:   3000 (override with PORT env var)
//
// SAFETY DEFAULTS (you have to explicitly opt out of all of these to go live):
//   1. DRY_RUN defaults to true → AI generates replies but does NOT send them
//   2. ALLOWED_CONTACTS defaults to empty → no contacts are allowed
//   3. data/.kill file → if it exists, server ignores all webhooks
//
// To actually send messages to a real customer, you must:
//   • Set DRY_RUN=false
//   • Either set ALLOWED_CONTACTS=contactId1,contactId2 OR set ALLOW_ALL_CONTACTS=true
//   • Make sure data/.kill does not exist

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env (zero-dep). Only sets values that aren't already in process.env,
// so Railway / shell env vars always take precedence over the local file.
try {
  const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch (e) { /* optional */ }

import { handleInboundMessage } from './webhooks/ghl-inbound.js';
import { initSchema, loadAllConversations, loadAllNotifications, listSuggestions, updateSuggestionStatus } from './storage/db.js';
import { hydrateCache as hydrateConversations, allConversations } from './storage/conversations.js';
import { hydrateCache as hydrateNotifications, getAllNotifications } from './utils/notify.js';
import { runAnalysis } from './learning/analyzer.js';
import { runStalledLeadNudges } from './nudges/stalled-leads.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const KILL_FILE = join(DATA_DIR, '.kill');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) { return fallback; }
}

function serveStaticFile(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * GHL workflow webhooks send a complex payload — standard contact fields at
 * top level (snake_case), Custom Data nested under `customData`, plus
 * `message` / `contact` / `triggerData` objects.
 *
 * Normalize all of those into the camelCase shape the handler expects.
 * Prefers Custom Data values (since the user explicitly mapped them in the
 * workflow), falls back to GHL's standard fields if Custom Data is missing.
 */
function normalizeGhlPayload(raw) {
  const cd = raw.customData || {};
  const msg = raw.message || {};
  const trig = raw.triggerData || {};
  const contact = raw.contact || {};

  const contactId =
    cd.contactId || raw.contact_id || contact.id || raw.contactId || null;

  // GHL doesn't always expose conversationId as a workflow variable. If we
  // can't find it, fall back to contactId — the webhook handler will resolve
  // the real conversationId via GHL's search API.
  const conversationId =
    cd.conversationId ||
    msg.conversationId ||
    trig.conversationId ||
    raw.conversation_id ||
    contactId;

  const messageType =
    cd.messageType ||
    msg.type ||
    msg.messageType ||
    trig.messageType ||
    raw.message_type ||
    null;

  const mediaCandidates = [
    cd.attachments, cd.attachment, cd.files, cd.file, cd.media, cd.image, cd.photo,
    msg.attachments, msg.attachment, msg.files, msg.file, msg.media, msg.image, msg.photo,
    trig.attachments, trig.attachment, trig.files, trig.file, trig.media, trig.image, trig.photo,
    raw.attachments, raw.attachment, raw.files, raw.file, raw.media, raw.image, raw.photo,
  ];
  const hasMedia = mediaCandidates.some((value) => {
    if (!value) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    if (typeof value === 'string') return value.trim() !== '';
    return Boolean(value);
  });

  const body =
    cd.body ||
    msg.body ||
    msg.message ||
    trig.body ||
    raw.message_body ||
    raw.body ||
    (hasMedia ? '[Customer sent photo/image/video]' : null);

  const direction =
    cd.direction || msg.direction || trig.direction || 'inbound';

  return { contactId, conversationId, messageType, body, direction, hasMedia };
}

/**
 * HTTP Basic Auth check. If DASHBOARD_AUTH env var is set as "user:pass",
 * the dashboard + /api endpoints require Basic auth. Webhooks remain open
 * (GHL needs to POST without credentials).
 *
 * Returns true if request is authorized OR auth isn't configured.
 * Returns false (and writes a 401) if auth is required but failed.
 */
function checkBasicAuth(req, res) {
  // Trim defensively — Railway env vars sometimes carry trailing whitespace
  // or invisible chars from copy-paste, which would silently break matching.
  const credentials = (process.env.DASHBOARD_AUTH || '').trim();
  if (!credentials) return true; // auth disabled
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="SCT Sales Agent Dashboard"',
      'Content-Type': 'text/plain',
    });
    res.end('Authentication required');
    return false;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8').trim();
  if (decoded === credentials) return true;
  // Diagnostic log (lengths only, never the actual creds) so we can tell
  // whether the env var is even loading and whether the user's typed creds
  // are reaching the server. Shows in Railway logs.
  console.log(`🔒 Auth mismatch: env-var len=${credentials.length}, browser-sent len=${decoded.length}`);
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="SCT Sales Agent Dashboard"',
    'Content-Type': 'text/plain',
  });
  res.end('Invalid credentials');
  return false;
}

/**
 * Compute aggregated KPI stats from notifications.json + conversations.json.
 * Powers the dashboard widgets (jobs booked, MTD revenue, booking rate, etc.).
 *
 * Considers:
 *   • Booking events (type starts with "booking_" or "handoff" with package)
 *   • Escalation events (type === "escalation")
 *   • Conversations (anything that touched our state store)
 *
 * Returns a flat object with all the values the dashboard needs.
 */
function computeStats() {
  const notifications = getAllNotifications();
  const conversations = allConversations();
  const convoList = Object.values(conversations);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = monthStart;

  // Bookings = handoff events (where AI completed sale) OR legacy booking_*
  // events. Each has a `price` field with the quoted amount.
  // IMPORTANT: a single conversation can fire both [BOOK] (booking_notify
  // event) AND [ADDRESS] (handoff event) — we must dedupe by conversationId
  // so it counts as ONE booking, not two. Prefer the handoff event because
  // it has the most complete info (address, day/time, etc.).
  const bookingNotifs = notifications.filter(
    (n) => n.type === 'handoff' || (n.type && n.type.startsWith('booking_'))
  );
  const byConvo = new Map();
  for (const n of bookingNotifs) {
    if (!n.conversationId) continue;
    const existing = byConvo.get(n.conversationId);
    // Prefer handoff over booking_*; otherwise keep the latest by timestamp
    if (!existing) {
      byConvo.set(n.conversationId, n);
    } else if (n.type === 'handoff' && existing.type !== 'handoff') {
      byConvo.set(n.conversationId, n);
    } else if (existing.type !== 'handoff' && new Date(n.timestamp) > new Date(existing.timestamp)) {
      byConvo.set(n.conversationId, n);
    }
  }
  const bookings = Array.from(byConvo.values());
  const escalations = notifications.filter((n) => n.type === 'escalation');

  // MTD bookings + last-month bookings (for trend %)
  const mtdBookings = bookings.filter((b) => new Date(b.timestamp) >= monthStart);
  const lastMonthBookings = bookings.filter((b) => {
    const t = new Date(b.timestamp);
    return t >= lastMonthStart && t < lastMonthEnd;
  });

  // Revenue (sum of price for bookings — falls back to 0 if no price)
  const sumPrice = (arr) => arr.reduce((s, b) => s + (Number(b.price) || 0), 0);
  const mtdRevenue = sumPrice(mtdBookings);
  const lastMonthRevenue = sumPrice(lastMonthBookings);

  // Avg job value
  const avgJobValue = mtdBookings.length
    ? Math.round(mtdRevenue / mtdBookings.length)
    : (bookings.length ? Math.round(sumPrice(bookings) / bookings.length) : 0);

  // Booking rate (this month) — bookings / GENUINE QUOTE INQUIRIES this month.
  // Excludes greetings, complaints, spam, and off-topic conversations because
  // they distort the metric. A conversation counts as a "quote inquiry" if:
  //   • Customer answered enough qualifying questions for us to detect sqft, OR
  //   • The conversation actually booked
  // This way pure greetings and immediately-escalated spam don't drag the
  // booking rate down.
  const mtdConvos = convoList.filter((c) => {
    const t = c.lastUpdated ? new Date(c.lastUpdated) : null;
    return t && t >= monthStart;
  });
  const mtdQuoteInquiries = mtdConvos.filter((c) => c.sqft || c.booked);
  const bookingRate = mtdQuoteInquiries.length
    ? Math.round((mtdBookings.length / mtdQuoteInquiries.length) * 1000) / 10
    : 0;

  // % change vs last month for jobs booked
  const jobsVsLastMonth = lastMonthBookings.length
    ? Math.round(((mtdBookings.length - lastMonthBookings.length) / lastMonthBookings.length) * 100)
    : null;

  // Package mix (this month)
  const pkgMix = {};
  for (const b of mtdBookings) {
    const k = b.packageId || b.package || 'unknown';
    if (!pkgMix[k]) pkgMix[k] = { count: 0, revenue: 0 };
    pkgMix[k].count++;
    pkgMix[k].revenue += Number(b.price) || 0;
  }
  const packageMix = Object.entries(pkgMix).map(([id, v]) => ({
    id,
    name: id === 'winnie' ? 'Quick Clean' : id === 'khloe' ? 'Deep Clean' : id === 'karl' ? 'Extraction' : id,
    count: v.count,
    revenue: v.revenue,
  }));

  // Booking rate over time — last 8 weeks (Sunday-aligned)
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const wkEnd = new Date(now);
    wkEnd.setDate(wkEnd.getDate() - i * 7);
    const wkStart = new Date(wkEnd);
    wkStart.setDate(wkStart.getDate() - 7);
    const wkBookings = bookings.filter((b) => {
      const t = new Date(b.timestamp);
      return t >= wkStart && t < wkEnd;
    }).length;
    const wkConvos = convoList.filter((c) => {
      const t = c.lastUpdated ? new Date(c.lastUpdated) : null;
      return t && t >= wkStart && t < wkEnd;
    }).length;
    const rate = wkConvos ? Math.round((wkBookings / wkConvos) * 1000) / 10 : 0;
    weeks.push({
      label: `Wk ${8 - i}`,
      rate,
      bookings: wkBookings,
      conversations: wkConvos,
    });
  }

  // Recent activity (latest 15 events) — bookings (deduped) + escalations.
  // Same dedupe as bookings: a single conversation may fire both
  // booking_notify and handoff — only show once, preferring the handoff
  // event (most complete info).
  const dedupedActivity = [];
  const seenBookingConvos = new Set();
  for (const n of [...notifications].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
    if (n.type === 'handoff' || (n.type && n.type.startsWith('booking_'))) {
      if (n.conversationId && seenBookingConvos.has(n.conversationId)) continue;
      if (n.conversationId) seenBookingConvos.add(n.conversationId);
    }
    dedupedActivity.push(n);
  }
  const recentActivity = dedupedActivity
    .slice(0, 15)
    .map((n) => {
      if (n.type === 'handoff' || n.type?.startsWith('booking_')) {
        const pkg = n.customerLabel || n.packageId || 'service';
        const sqft = n.sqft ? `${n.sqft} sq ft` : '';
        const where = n.address ? `, ${n.address}` : '';
        return {
          kind: 'booking',
          text: `${n.customerName || 'Customer'} booked ${pkg}${sqft ? ' — ' + sqft : ''}${where}`,
          timestamp: n.timestamp,
          price: n.price || null,
        };
      }
      if (n.type === 'escalation') {
        return {
          kind: 'escalation',
          text: `Escalation: ${n.customerName || 'Customer'} — ${n.reason || 'unspecified'}`,
          timestamp: n.timestamp,
        };
      }
      return {
        kind: 'event',
        text: n.type,
        timestamp: n.timestamp,
      };
    });

  // Quick AI insight — a one-liner derived from the data
  const aiInsight = computeAiInsight(bookings, mtdBookings, packageMix);

  // ===== CONVERSION FUNNEL =====
  // Step 1: Started — any conversation in our state store
  // Step 2: Engaged — has had at least one customer reply (we know because
  //         customerName got captured, which only happens after first inbound)
  // Step 3: Qualified — sqft is set (customer answered the qualifying questions)
  // Step 4: Booked — booking was emitted
  const funnel = {
    started: convoList.length,
    engaged: convoList.filter((c) => c.customerName).length,
    qualified: convoList.filter((c) => c.sqft).length,
    booked: convoList.filter((c) => c.booked).length,
    escalated: convoList.filter((c) => c.escalated && !c.booked).length,
  };

  // ===== TOP ESCALATION REASONS =====
  const reasonCounts = {};
  for (const e of escalations) {
    const r = (e.reason || 'unspecified').slice(0, 80);
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }
  const escalationReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Lost revenue = escalations that didn't book × avg job value
  const lostRevenue = escalationReasons.length
    ? Math.round(escalationReasons.reduce((s, r) => s + r.count, 0) * (avgJobValue || 350))
    : 0;

  // ===== AI COST PER BOOKING =====
  // Anthropic Sonnet 4.6 pricing (approx): $3/M input, $15/M output
  const INPUT_RATE = 3 / 1_000_000;
  const OUTPUT_RATE = 15 / 1_000_000;
  const tokenTotals = convoList.reduce(
    (acc, c) => {
      const t = c.tokenUsage || { input: 0, output: 0, turns: 0 };
      return {
        input: acc.input + (t.input || 0),
        output: acc.output + (t.output || 0),
        turns: acc.turns + (t.turns || 0),
      };
    },
    { input: 0, output: 0, turns: 0 },
  );
  const totalCost = (tokenTotals.input * INPUT_RATE) + (tokenTotals.output * OUTPUT_RATE);
  const costPerBooking = bookings.length
    ? totalCost / bookings.length
    : 0;
  const aiCost = {
    totalSpend: Math.round(totalCost * 100) / 100,           // $X.YY
    perBooking: Math.round(costPerBooking * 100) / 100,      // $X.YY
    totalTokens: tokenTotals.input + tokenTotals.output,
    totalTurns: tokenTotals.turns,
    bookingsTracked: bookings.length,
  };

  // ===== TIME WINDOWS (Today / This Week / MTD) =====
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);
  const weekStartFloor = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  const todayBookings = bookings.filter((b) => new Date(b.timestamp) >= todayStart);
  const weekBookings  = bookings.filter((b) => new Date(b.timestamp) >= weekStartFloor);
  const timeWindows = {
    today: { count: todayBookings.length, revenue: sumPrice(todayBookings) },
    week:  { count: weekBookings.length,  revenue: sumPrice(weekBookings)  },
    mtd:   { count: mtdBookings.length,   revenue: mtdRevenue              },
  };

  // ===== CHANNEL PERFORMANCE =====
  // For each channel: count quote-inquiry conversations + bookings, then rate.
  const channelMap = {};
  const bumpChannel = (ch, key) => {
    if (!ch) return;
    if (!channelMap[ch]) channelMap[ch] = { conversations: 0, bookings: 0, revenue: 0 };
    channelMap[ch][key]++;
  };
  for (const c of convoList) {
    if (c.sqft || c.booked) bumpChannel(c.channel, 'conversations');
  }
  for (const b of bookings) {
    if (b.channel) {
      if (!channelMap[b.channel]) channelMap[b.channel] = { conversations: 0, bookings: 0, revenue: 0 };
      channelMap[b.channel].bookings++;
      channelMap[b.channel].revenue += Number(b.price) || 0;
    }
  }
  const byChannel = Object.entries(channelMap)
    .map(([channel, v]) => ({
      channel,
      conversations: v.conversations,
      bookings: v.bookings,
      revenue: v.revenue,
      rate: v.conversations ? Math.round((v.bookings / v.conversations) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bookings - a.bookings);

  // ===== CITY PERFORMANCE =====
  // Naive city extraction from address (last comma-separated chunk minus state/zip)
  function extractCity(addr) {
    if (!addr) return null;
    const cities = ['Phoenix','Scottsdale','Tempe','Gilbert','Mesa','Chandler','Queen Creek','Ahwatukee','Apache Junction','Maricopa','Paradise Valley','Gold Canyon','San Tan Valley','Peoria','Surprise','Glendale','Cave Creek','Fountain Hills'];
    const lower = addr.toLowerCase();
    for (const city of cities) {
      if (lower.includes(city.toLowerCase())) return city;
    }
    // Fallback: try to grab the second comma-separated segment
    const parts = addr.split(',').map((p) => p.trim());
    if (parts.length >= 2) return parts[1].split(/\s+/)[0];
    return null;
  }
  const cityMap = {};
  for (const b of bookings) {
    const city = extractCity(b.address);
    if (!city) continue;
    if (!cityMap[city]) cityMap[city] = { count: 0, revenue: 0 };
    cityMap[city].count++;
    cityMap[city].revenue += Number(b.price) || 0;
  }
  const byCity = Object.entries(cityMap)
    .map(([city, v]) => ({
      city,
      count: v.count,
      revenue: v.revenue,
      avgValue: v.count ? Math.round(v.revenue / v.count) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // ===== TIME-TO-BOOK =====
  // Avg minutes from conversation creation → booking. Only count conversations
  // that have both createdAt and bookingTimestamp.
  const ttbValues = [];
  for (const c of convoList) {
    if (c.createdAt && c.bookingTimestamp) {
      const mins = (new Date(c.bookingTimestamp) - new Date(c.createdAt)) / 60000;
      if (mins > 0 && mins < 60 * 24 * 7) ttbValues.push(mins); // sanity: under 1 week
    }
  }
  const avgTimeToBook = ttbValues.length
    ? Math.round((ttbValues.reduce((s, v) => s + v, 0) / ttbValues.length) * 10) / 10
    : null;

  // ===== TOP QUESTIONS ASKED =====
  // Aggregate question text snippets from all conversations
  const allQuestions = [];
  for (const c of convoList) {
    if (Array.isArray(c.questionsAsked)) {
      for (const q of c.questionsAsked) {
        allQuestions.push({
          text: q.text,
          ts: q.ts,
          customerName: c.customerName || 'Unknown',
        });
      }
    }
  }
  // Sort newest first, take last 10 unique-ish
  const recentQuestions = allQuestions
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 10);

  return {
    // Headline KPIs
    jobsBooked: {
      value: mtdBookings.length,
      vsLastMonth: jobsVsLastMonth,
      total: bookings.length,
    },
    avgJobValue: {
      value: avgJobValue,
      target: 300,
    },
    bookingRate: {
      value: bookingRate,
      thisMonthBookings: mtdBookings.length,
      // Now reflects QUOTE INQUIRIES only (excludes greetings/complaints/spam)
      thisMonthConvos: mtdQuoteInquiries.length,
      totalConversationsThisMonth: mtdConvos.length, // for context if needed
    },
    mtdRevenue: {
      value: mtdRevenue,
      breakdown: `${mtdBookings.length} job${mtdBookings.length === 1 ? '' : 's'}`,
      lastMonth: lastMonthRevenue,
    },
    // Lower-row KPIs
    conversationsTouched: convoList.length,
    customerNamesCaptured: convoList.filter((c) => c.customerName).length,
    sqftDetected: convoList.filter((c) => c.sqft).length,
    bookingsToCreate: bookings.filter((b) => !b.completed).length,
    escalations: escalations.length,
    // Chart data
    bookingRateChart: weeks,
    packageMix,
    recentActivity,
    aiInsight,
    // New analytics widgets
    funnel,
    escalationReasons,
    lostRevenue,
    aiCost,
    recentQuestions,
    // Operational widgets (added in this round)
    timeWindows,
    byChannel,
    byCity,
    avgTimeToBook,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Pick a one-liner insight from the data. Rotates through a few based on
 * what's most interesting. If data is too thin, returns a setup tip.
 */
function computeAiInsight(allBookings, mtdBookings, packageMix) {
  if (allBookings.length === 0) {
    return {
      headline: 'Waiting on the first booking to show real insights',
      detail: 'Once customers start booking, this card surfaces patterns from their conversations.',
      basedOn: 'No data yet',
    };
  }
  const totalCount = packageMix.reduce((s, p) => s + p.count, 0);
  if (totalCount > 0) {
    const top = [...packageMix].sort((a, b) => b.count - a.count)[0];
    const pct = Math.round((top.count / totalCount) * 100);
    return {
      headline: `${pct}% of bookings this month are the ${top.name}`,
      detail: `${top.count} of ${totalCount} bookings. Avg revenue per ${top.name}: $${Math.round(top.revenue / top.count)}.`,
      basedOn: `Based on ${mtdBookings.length} bookings this month.`,
    };
  }
  return {
    headline: 'System is healthy and processing conversations',
    detail: 'Once you have a few bookings under your belt, deeper insights will appear here.',
    basedOn: `${allBookings.length} total bookings tracked.`,
  };
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, {
      status: 'ok',
      dryRun: process.env.DRY_RUN !== 'false',
      contactsAllowed: process.env.ALLOW_ALL_CONTACTS === 'true'
        ? 'ALL'
        : (process.env.ALLOWED_CONTACTS || 'NONE'),
      killSwitch: existsSync(KILL_FILE),
      timestamp: new Date().toISOString(),
    });
  }

  // ===================== Auth gate for dashboard + API =====================
  // Webhooks are intentionally exempt (GHL needs to POST without creds).
  // /health is also exempt (used for liveness checks).
  const isProtected =
    req.url === '/' ||
    req.url === '/dashboard' ||
    req.url.startsWith('/api/');
  if (isProtected && !checkBasicAuth(req, res)) return;

  // ===================== Live data API for the dashboard =====================
  if (req.method === 'GET' && req.url === '/api/state') {
    return send(res, 200, {
      dryRun: process.env.DRY_RUN !== 'false',
      allowAllContacts: process.env.ALLOW_ALL_CONTACTS === 'true',
      whitelist: (process.env.ALLOWED_CONTACTS || '').split(',').filter(Boolean),
      killSwitch: existsSync(KILL_FILE),
      businessName: process.env.BUSINESS_NAME || 'Squeaky Clean Turf',
      businessArea: process.env.BUSINESS_AREA || 'Phoenix, AZ',
      activeHours: `${process.env.HOURS_START || '06'}:00 – ${process.env.HOURS_END || '22'}:00`,
    });
  }

  if (req.method === 'GET' && req.url === '/api/conversations') {
    const data = allConversations();
    const list = Object.entries(data).map(([conversationId, state]) => ({
      conversationId,
      ...state,
    })).sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));
    return send(res, 200, { count: list.length, conversations: list });
  }

  if (req.method === 'GET' && req.url === '/api/notifications') {
    const list = getAllNotifications();
    return send(res, 200, {
      count: list.length,
      notifications: [...list].reverse(),  // newest first
    });
  }

  // ===================== Aggregated stats for dashboard widgets =====================
  if (req.method === 'GET' && req.url.startsWith('/api/stats')) {
    return send(res, 200, computeStats());
  }

  // ===================== Stalled-lead nudges =====================
  // POST /api/nudges/run — manually trigger a nudge sweep. Returns the
  // candidates found and what was sent (or would be sent in DRY_RUN).
  // Add ?force=true to bypass the active-hours gate (useful for testing).
  if (req.method === 'POST' && req.url.startsWith('/api/nudges/run')) {
    try {
      const force = /[?&]force=true/.test(req.url);
      const result = await runStalledLeadNudges({ force });
      return send(res, 200, result);
    } catch (e) {
      console.error('💌 Nudge run failed:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  // ===================== Learning loop =====================
  if (req.method === 'GET' && req.url === '/api/learning/suggestions') {
    try {
      const all = await listSuggestions();
      return send(res, 200, { suggestions: all });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/learning/analyze') {
    try {
      console.log('🧠 Learning loop: starting analysis...');
      const result = await runAnalysis();
      console.log(`🧠 Learning loop: ${result.inserted}/${result.generated} suggestions inserted (${result.tokensUsed || 0} tokens)`);
      return send(res, 200, result);
    } catch (e) {
      console.error('🧠 Learning loop failed:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  // POST /api/learning/suggestions/:id/approve  (or /reject)
  const learningActionMatch = req.url.match(/^\/api\/learning\/suggestions\/(\d+)\/(approve|reject)$/);
  if (req.method === 'POST' && learningActionMatch) {
    try {
      const id = parseInt(learningActionMatch[1], 10);
      const action = learningActionMatch[2];
      const status = action === 'approve' ? 'approved' : 'rejected';
      await updateSuggestionStatus(id, status);
      return send(res, 200, { ok: true, id, status });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // ===================== Static dashboard =====================
  // GET / → serve dashboard.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
    if (serveStaticFile(res, join(PUBLIC_DIR, 'dashboard.html'))) return;
  }
  // GET /<file> → static files from public/
  if (req.method === 'GET' && req.url.startsWith('/') && !req.url.startsWith('/api') && !req.url.startsWith('/webhooks')) {
    const safePath = req.url.replace(/\?.*$/, '').replace(/\.\./g, '');
    if (serveStaticFile(res, join(PUBLIC_DIR, safePath))) return;
  }

  // GHL inbound message webhook
  if (req.method === 'POST' && req.url === '/webhooks/ghl/inbound') {
    try {
      const raw = await readBody(req);
      const payload = normalizeGhlPayload(raw);
      console.log(`\n📥 Inbound webhook from contact ${payload.contactId}: "${payload.body || ''}"`);

      // Required fields check
      if (!payload.contactId || !payload.conversationId || !payload.body) {
        return send(res, 400, {
          error: 'Missing required fields: contactId, conversationId, body',
          received: Object.keys(raw),
          normalized: Object.keys(payload),
        });
      }

      const result = await handleInboundMessage(payload);
      return send(res, 200, result);
    } catch (e) {
      console.error('❌ Handler error:', e);
      return send(res, 500, { error: e.message });
    }
  }

  // Anything else → 404
  send(res, 404, { error: 'Not found', method: req.method, url: req.url });
});

/**
 * Boot sequence:
 *   1. Initialize Postgres schema (idempotent CREATE TABLE IF NOT EXISTS).
 *   2. Hydrate in-memory caches from DB so getState/getAllNotifications work
 *      synchronously throughout the codebase.
 *   3. Start the HTTP listener.
 *
 * If Postgres isn't available (no DATABASE_URL or connection error), the
 * server still boots — but state won't persist across redeploys, and stats
 * will show as empty until the DB is reachable.
 */
async function boot() {
  if (process.env.DATABASE_URL) {
    try {
      await initSchema();
      const [convos, notifs] = await Promise.all([
        loadAllConversations(),
        loadAllNotifications(),
      ]);
      hydrateConversations(convos);
      hydrateNotifications(notifs);
      console.log(`💾 Hydrated cache: ${Object.keys(convos).length} conversations, ${notifs.length} notifications from Postgres`);
    } catch (e) {
      console.error(`🚨 Postgres init failed: ${e.message} — continuing without persistence`);
    }
  } else {
    console.warn('⚠️  DATABASE_URL not set — running without persistence (state resets on redeploy)');
  }

  server.listen(PORT, () => {
    console.log(`\n🐕 SCT Sales Agent server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Webhook URL:  http://localhost:${PORT}/webhooks/ghl/inbound`);
    console.log('');
    console.log(`   DRY_RUN:           ${process.env.DRY_RUN !== 'false' ? 'ON ✅ (safe — won\'t send to customers)' : 'OFF ⚠️  (will send real messages!)'}`);
    console.log(`   ALLOW_ALL:         ${process.env.ALLOW_ALL_CONTACTS === 'true' ? 'YES ⚠️' : 'no'}`);
    console.log(`   Whitelist:         ${process.env.ALLOWED_CONTACTS || '(empty — no one allowed)'}`);
    console.log('');
    console.log('   Press Ctrl+C to stop the server.\n');
  });

  // Auto-schedule the stalled-lead nudge sweep every 30 minutes.
  // The nudge function self-gates on active hours (9 AM – 7 PM AZ), so this
  // interval can fire 24/7 without spamming customers in the middle of the
  // night — out-of-hours runs return { skipped: true } silently.
  if (process.env.NUDGE_DISABLED !== 'true') {
    const NUDGE_INTERVAL_MS = 30 * 60 * 1000;
    setInterval(async () => {
      try {
        const result = await runStalledLeadNudges();
        if (result.count > 0) {
          console.log(`💌 Scheduled nudge sweep: ${result.count} processed.`);
        }
      } catch (e) {
        console.error(`💌 Scheduled nudge sweep failed: ${e.message}`);
      }
    }, NUDGE_INTERVAL_MS);
    console.log(`💌 Stalled-lead nudge scheduler: every 30 minutes (active 9 AM–7 PM AZ).`);
  }
}

boot();
