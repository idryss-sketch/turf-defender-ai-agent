// Local end-to-end test:
//   1. Spins up the server
//   2. Fires a fake GHL webhook payload at it (NO real GHL involved)
//   3. Logs what the server would have done
//
// Run: node scripts/test-server.js
//
// This is 100% safe — touches nothing in your real GHL account.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3099;

const FAKE_PAYLOADS = [
  {
    name: 'Marcus — first contact',
    payload: {
      type: 'InboundMessage',
      locationId: 'fake-location-123',
      contactId: 'fake-marcus-001',
      conversationId: 'fake-conv-marcus',
      messageType: 'SMS',
      body: 'hey saw your insta. need a quote',
      direction: 'inbound',
    },
  },
  {
    name: 'Marcus — answers qualifying questions',
    payload: {
      type: 'InboundMessage',
      contactId: 'fake-marcus-001',
      conversationId: 'fake-conv-marcus',
      messageType: 'SMS',
      body: 'About 600 sq ft, smell is maybe a 4, never been cleaned, turf is 2 years old, Scottsdale',
      direction: 'inbound',
    },
  },
];

async function postWebhook(payload) {
  const res = await fetch(`http://localhost:${PORT}/webhooks/ghl/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log('🚀 Starting test server on port', PORT, '...\n');

  // Force safe defaults for this test
  const env = {
    ...process.env,
    PORT: String(PORT),
    DRY_RUN: 'true',                  // never send real messages
    ALLOW_ALL_CONTACTS: 'true',       // allow our fake contact
  };

  const child = spawn('node', ['src/server.js'], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: new URL('..', import.meta.url).pathname,
  });

  // Wait for server to come up
  await sleep(800);

  try {
    // Health check
    const health = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json());
    console.log('Server health:', health);

    // Fire each fake payload
    for (const test of FAKE_PAYLOADS) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`📨 ${test.name}`);
      console.log('─'.repeat(60));
      const result = await postWebhook(test.payload);
      console.log('Result:', JSON.stringify(result.body, null, 2));
    }
  } catch (e) {
    console.error('Test failed:', e.message);
  } finally {
    child.kill();
    process.exit(0);
  }
}

main();
