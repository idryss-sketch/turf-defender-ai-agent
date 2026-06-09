// Sandbox-safe conversation test — uses fetch() directly, no SDK install needed.
// Run: node scripts/test-conversation-direct.js
// (For local dev with the SDK, use test-conversation.js instead.)

// Tiny zero-dep .env loader (sandbox can't npm install)
import { readFileSync } from 'node:fs';
try {
  const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch (e) { /* .env optional */ }

import { buildSystemPrompt } from '../src/conversation/prompts.js';
import { quoteAll } from '../src/conversation/pricing.js';

const MODEL = 'claude-sonnet-4-6';

async function callClaude({ system, messages }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText}`);
  }
  return res.json();
}

async function getReply({ customerName, history, sqft }) {
  const quotes = sqft ? quoteAll(sqft, true) : null;
  let system = buildSystemPrompt(quotes);
  if (customerName) system = system.replaceAll('{name}', customerName);

  const data = await callClaude({ system, messages: history });
  const reply = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  return { reply, usage: data.usage };
}

// --- Scenarios ---
const SCENARIOS = {
  marcus: {
    customerName: 'Marcus',
    customerMessages: [
      'hey saw your insta. need a quote',
      'About 600 sq ft, smell is maybe a 4, never been cleaned, turf is 2 years old, Scottsdale',
      'sure',
      'deep clean sounds right for a 4',
    ],
    sqft: 600,
  },
  karen_pushback: {
    customerName: 'Karen',
    customerMessages: [
      'Need a quote for my turf',
      '800 sq ft, smell is BAD probably 8, never cleaned, 4 years old, Mesa. Two big dogs',
      'yes please',
      'I\'ll think about it and let you know',
    ],
    sqft: 800,
  },
  janet_price_obj: {
    customerName: 'Janet',
    customerMessages: [
      'how much do you charge',
      '500 sqft, smell maybe 5, never, 3 years, central phoenix',
      '$213 to spray water on grass? no thanks',
    ],
    sqft: 500,
  },
  patricia_no_sqft: {
    customerName: 'Patricia',
    customerMessages: [
      'I want a quote',
      'I have no idea how big it is. Smell is maybe a 6, never cleaned, like 3 years old, chandler',
    ],
    sqft: null,
  },
};

// Detect escalation marker — when AI emits [ESCALATE: ...], we suppress
// the message to customer and instead alert the human (Dalis).
function checkEscalation(reply) {
  const m = reply.match(/^\s*\[ESCALATE:\s*(.+?)\s*\]\s*$/);
  if (m) return { escalated: true, reason: m[1] };
  return { escalated: false };
}

async function runScenario(scenarioName) {
  const s = SCENARIOS[scenarioName];
  if (!s) throw new Error(`Unknown scenario: ${scenarioName}`);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenarioName}`);
  console.log(`Customer: ${s.customerName}`);
  console.log('='.repeat(70));

  const history = [];
  let totalIn = 0, totalOut = 0;

  for (let i = 0; i < s.customerMessages.length; i++) {
    const msg = s.customerMessages[i];
    console.log(`\n👤 ${s.customerName}: ${msg}`);
    history.push({ role: 'user', content: msg });

    const sqft = i >= 1 ? s.sqft : undefined;

    const { reply, usage } = await getReply({
      customerName: s.customerName,
      history,
      sqft,
    });

    const esc = checkEscalation(reply);
    if (esc.escalated) {
      console.log(`\n🚨 ESCALATION TRIGGERED — customer hears nothing from AI.`);
      console.log(`   Reason: ${esc.reason}`);
      console.log(`   → System would now ping Dalis for personal handoff.`);
      console.log(`   [in=${usage.input_tokens} out=${usage.output_tokens}]`);
      // In production we'd stop here. For test, we end the conversation.
      break;
    }

    console.log(`\n🤖 SCT AI: ${reply}`);
    console.log(`   [in=${usage.input_tokens} out=${usage.output_tokens}]`);
    history.push({ role: 'assistant', content: reply });

    totalIn += usage.input_tokens;
    totalOut += usage.output_tokens;
  }

  const cost = (totalIn / 1_000_000) * 3 + (totalOut / 1_000_000) * 15;
  console.log(`\n--- Cost: $${cost.toFixed(4)} (in=${totalIn} out=${totalOut}) ---`);
}

const scenario = process.argv[2] || 'marcus';
runScenario(scenario).catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
