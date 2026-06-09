// Run a scripted conversation against the real Claude API to verify the AI follows the script.
// Run: node scripts/test-conversation.js
//
// You can edit `customer` below to simulate different scenarios.

import 'dotenv/config';
import { getReply } from '../src/conversation/engine.js';

// --- Edit this scenario to test different customers ---
const SCENARIO = {
  customerName: 'Marcus',
  // Customer messages, in order. The script simulates customer typing each one,
  // gets AI response, then types next, etc.
  customerMessages: [
    'hey saw your insta. need a quote',
    'About 600 sq ft, smell is maybe a 4, never been cleaned, turf is 2 years old, Scottsdale',
    'sure',
    'Khloe sounds right for a 4',
  ],
  // Optional: tell the engine the sq ft once known so it can inject real prices.
  sqftOnceKnown: 600,
};
// ------------------------------------------------------

async function run() {
  console.log(`\n=== SCT Sales Agent — Test Conversation ===`);
  console.log(`Customer: ${SCENARIO.customerName}\n`);

  const history = [];
  let totalTokens = { input: 0, output: 0 };

  for (let i = 0; i < SCENARIO.customerMessages.length; i++) {
    const customerMsg = SCENARIO.customerMessages[i];
    console.log(`👤 ${SCENARIO.customerName}: ${customerMsg}\n`);
    history.push({ role: 'user', content: customerMsg });

    // Inject sqft only after customer has answered the qualifying questions
    const sqft = i >= 1 ? SCENARIO.sqftOnceKnown : undefined;

    const { reply, usage } = await getReply({
      customerName: SCENARIO.customerName,
      history,
      sqft,
    });

    console.log(`🤖 SCT: ${reply}\n`);
    console.log(`   [tokens: in=${usage.input_tokens}, out=${usage.output_tokens}]\n`);
    console.log('---');
    history.push({ role: 'assistant', content: reply });

    totalTokens.input += usage.input_tokens;
    totalTokens.output += usage.output_tokens;
  }

  // Cost estimate at Sonnet pricing
  const inputCost = (totalTokens.input / 1_000_000) * 3;
  const outputCost = (totalTokens.output / 1_000_000) * 15;
  const total = inputCost + outputCost;

  console.log(`\n=== Total cost for this conversation ===`);
  console.log(`Input tokens: ${totalTokens.input}`);
  console.log(`Output tokens: ${totalTokens.output}`);
  console.log(`Estimated cost: $${total.toFixed(4)}`);
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
