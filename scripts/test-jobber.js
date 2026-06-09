// Smoke test for the Jobber integration.
//
// Default mode (safe): refresh the access token only, then exit.
//   node scripts/test-jobber.js
//
// Optional: actually create a fake test request in your Jobber account.
//   node scripts/test-jobber.js --create
// (This DOES write to your real Jobber account. Use the dev/sandbox account.)
//
// Also runs a unit test on the [BOOK: ...] marker parser, no API needed.

import { readFileSync } from 'node:fs';
import { parseBookingMarker } from '../src/conversation/engine.js';
import * as jobber from '../src/integrations/jobber.js';

// .env loader (mirrors test-conversation-direct.js)
try {
  const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch (e) { /* .env optional */ }

const args = new Set(process.argv.slice(2));
const doCreate = args.has('--create');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else      { fail++; console.log(`  ❌ ${label}`); }
}

// ─────────────── 1. Marker parser unit tests (no API needed) ───────────────
console.log('\n━━━ Marker parser ━━━');

{
  const r = parseBookingMarker('Awesome choice! locked in at $213. Coordinator will text.\n[BOOK: khloe]');
  assert(r.booking.booked === true, 'detects [BOOK: khloe]');
  assert(r.booking.package === 'khloe', 'extracts package "khloe"');
  assert(!r.cleanReply.includes('[BOOK'), 'strips marker from clean reply');
  assert(r.cleanReply.includes('Coordinator will text'), 'preserves customer-facing text');
}
{
  const r = parseBookingMarker('You got it — extraction service! Locked in at $360.\n[BOOK: karl]');
  assert(r.booking.package === 'karl', 'detects "karl"');
}
{
  const r = parseBookingMarker('Sounds good! Quick clean for $128.\n[BOOK: winnie]');
  assert(r.booking.package === 'winnie', 'detects "winnie"');
}
{
  const r = parseBookingMarker('Which one do you think suits you best?');
  assert(r.booking.booked === false, 'no marker = booked false');
  assert(r.cleanReply === 'Which one do you think suits you best?', 'no-marker reply unchanged');
}
{
  const r = parseBookingMarker('All locked in.\n\n  [BOOK: KHLOE]  ');
  assert(r.booking.package === 'khloe', 'case-insensitive + tolerates whitespace');
}
{
  const r = parseBookingMarker('Awesome! [BOOK: karl] is ready');
  assert(r.booking.package === 'karl', 'inline marker also works');
  assert(!r.cleanReply.includes('[BOOK'), 'inline marker also stripped');
}

// ─────────────── 2. OAuth refresh (live, harmless) ───────────────
console.log('\n━━━ Jobber OAuth refresh ━━━');

const haveCreds =
  process.env.JOBBER_CLIENT_ID &&
  process.env.JOBBER_CLIENT_SECRET &&
  process.env.JOBBER_REFRESH_TOKEN;

if (!haveCreds) {
  console.log('  ⏭  Skipped — JOBBER_CLIENT_ID / SECRET / REFRESH_TOKEN not set.');
  console.log('     Run `node scripts/jobber-auth.js` first to bootstrap a refresh token.');
} else {
  try {
    const token = await jobber._internal.getAccessToken();
    assert(typeof token === 'string' && token.length > 20, 'got an access token');
  } catch (e) {
    console.log(`  ❌ refresh failed: ${e.message}`);
    fail++;
  }
}

// ─────────────── 3. Optional: create a real test Request ───────────────
if (doCreate && haveCreds) {
  console.log('\n━━━ Jobber createRequest (LIVE — will write to your account) ━━━');
  try {
    const res = await jobber.createRequest({
      customerName: 'TEST Customer (delete me)',
      phone: '+15555550100',
      email: 'test@example.com',
      address: '123 Test St, Phoenix, AZ',
      package: 'khloe',
      packageLabel: 'deep clean',
      sqft: 500,
      price: 213,
      channel: 'SMS',
      conversationId: 'TEST-CONVERSATION-ID',
    });
    console.log('  ✅ Created Request:', res);
    console.log('\n   👀 Check Jobber → Requests, you should see "[AI BOOKING] deep clean — TEST Customer (delete me)".');
    console.log('   (Delete it from Jobber UI when you\'re done.)');
  } catch (e) {
    console.log(`  ❌ createRequest failed: ${e.message}`);
    fail++;
  }
} else if (!doCreate) {
  console.log('\n(skipped live createRequest — pass --create to actually hit Jobber)');
}

console.log(`\n━━━ Result: ${pass} passed, ${fail} failed ━━━\n`);
process.exit(fail === 0 ? 0 : 1);
