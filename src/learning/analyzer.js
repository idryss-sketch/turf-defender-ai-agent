// Learning loop analyzer.
//
// Reviews recent escalations, customer questions, and booking patterns,
// asks Claude to suggest concrete script/FAQ improvements, then stores the
// suggestions in Postgres for the operator (Dalis) to approve/reject from
// the dashboard.
//
// Triggered manually (POST /api/learning/analyze) for now. Can be put on
// a cron schedule later.

import { allConversations } from '../storage/conversations.js';
import { getAllNotifications } from '../utils/notify.js';
import { insertSuggestion } from '../storage/db.js';

const MODEL = 'claude-sonnet-4-6';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANALYSIS_LOOKBACK_DAYS = 14;

/**
 * Run an analysis pass. Returns a summary of how many suggestions were
 * generated and inserted.
 */
export async function runAnalysis() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot run analysis');
  }

  const cutoff = Date.now() - ANALYSIS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const convos = Object.values(allConversations()).filter(
    (c) => c.lastUpdated && new Date(c.lastUpdated).getTime() >= cutoff,
  );
  const notifications = getAllNotifications().filter(
    (n) => n.timestamp && new Date(n.timestamp).getTime() >= cutoff,
  );

  if (convos.length === 0 && notifications.length === 0) {
    return { generated: 0, inserted: 0, reason: 'No recent activity to analyze' };
  }

  // Build the analysis input — keep it concise so we don't blow token budgets.
  const escalations = notifications
    .filter((n) => n.type === 'escalation')
    .slice(-30)
    .map((n) => ({
      reason: n.reason,
      lastMessage: n.lastCustomerMessage,
      channel: n.channel,
      ts: n.timestamp,
    }));

  const bookings = notifications
    .filter((n) => n.type === 'handoff' || (n.type && n.type.startsWith('booking_')))
    .slice(-30)
    .map((n) => ({
      package: n.packageId,
      sqft: n.sqft,
      price: n.price,
      city: n.address ? guessCity(n.address) : null,
      ts: n.timestamp,
    }));

  const questions = [];
  for (const c of convos) {
    if (Array.isArray(c.questionsAsked)) {
      for (const q of c.questionsAsked) questions.push(q.text);
    }
  }
  const dedupedQuestions = [...new Set(questions)].slice(-40);

  const summaryStats = {
    totalConversations: convos.length,
    booked: convos.filter((c) => c.booked).length,
    escalated: escalations.length,
    qualified: convos.filter((c) => c.sqft).length,
    handedOff: convos.filter((c) => c.handedOff).length,
  };

  const userMessage = buildAnalysisPrompt({
    summaryStats,
    escalations,
    bookings,
    questions: dedupedQuestions,
    lookbackDays: ANALYSIS_LOOKBACK_DAYS,
  });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  const suggestions = parseSuggestions(raw);
  let inserted = 0;
  for (const s of suggestions) {
    try {
      await insertSuggestion({
        kind: s.kind,
        title: s.title,
        detail: s.detail,
        proposedChange: s.proposedChange,
        evidence: s.evidence,
      });
      inserted++;
    } catch (e) {
      console.warn(`⚠️  Failed to insert suggestion: ${e.message}`);
    }
  }

  return {
    generated: suggestions.length,
    inserted,
    lookbackDays: ANALYSIS_LOOKBACK_DAYS,
    convosAnalyzed: convos.length,
    escalationsAnalyzed: escalations.length,
    bookingsAnalyzed: bookings.length,
    questionsAnalyzed: dedupedQuestions.length,
    tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
  };
}

const SYSTEM_PROMPT = `You are a sales operations consultant analyzing data from an AI sales agent for a turf cleaning business in Phoenix, AZ. Your job is to spot patterns and suggest CONCRETE, ACTIONABLE improvements to the AI's sales script and FAQ.

You will receive:
- Summary stats (conversations, bookings, escalations)
- Recent escalation reasons + last customer messages
- Recent bookings (package, sqft, price, city)
- Recent customer questions

Your output must be ONLY a valid JSON array of suggestion objects. No prose before or after. Each suggestion has:
{
  "kind": "faq_addition" | "script_change" | "pricing_observation" | "operational",
  "title": "Short headline (under 80 chars)",
  "detail": "1-3 sentence explanation of the pattern you noticed",
  "proposedChange": "Exact text to add to FAQ or change in script. Empty string if just an observation.",
  "evidence": { "count": number, "examples": ["string", "string"] }
}

Generate 0-5 suggestions per analysis. Quality over quantity. Skip the analysis entirely (return []) if data is too thin.

Examples of good suggestions:
- faq_addition: customers keep asking "Do you do trampoline play areas?" → add to FAQ
- script_change: 3 escalations had reason "customer asked about HOA approval" → add a Step 2.5 about HOA
- pricing_observation: customers in Mesa convert at 12% vs Gilbert 31% → consider geo-targeted pricing

DO NOT suggest:
- Vague things like "improve the script"
- Changes to safety gates (DRY_RUN, whitelist, kill switch)
- Pricing changes without strong evidence
- Anything you're less than 70% confident about`;

function buildAnalysisPrompt({ summaryStats, escalations, bookings, questions, lookbackDays }) {
  const lines = [];
  lines.push(`# Activity from last ${lookbackDays} days`);
  lines.push('');
  lines.push('## Summary');
  lines.push(JSON.stringify(summaryStats, null, 2));
  lines.push('');

  if (escalations.length) {
    lines.push(`## Recent escalations (${escalations.length})`);
    lines.push(JSON.stringify(escalations, null, 2));
    lines.push('');
  }

  if (bookings.length) {
    lines.push(`## Recent bookings (${bookings.length})`);
    lines.push(JSON.stringify(bookings, null, 2));
    lines.push('');
  }

  if (questions.length) {
    lines.push(`## Customer questions asked (${questions.length}, deduped)`);
    for (const q of questions) lines.push(`- ${q}`);
    lines.push('');
  }

  lines.push('Generate suggestions as a JSON array per the system prompt instructions.');
  return lines.join('\n');
}

function parseSuggestions(raw) {
  if (!raw) return [];
  // Try to extract a JSON array from the response (Claude sometimes wraps in code fences)
  let text = raw.trim();
  const jsonMatch = text.match(/```json\s*([\s\S]+?)\s*```/);
  if (jsonMatch) text = jsonMatch[1];
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) text = arrMatch[0];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((s) => s && s.title);
  } catch (e) {
    console.warn(`⚠️  Failed to parse suggestions JSON: ${e.message}`);
  }
  return [];
}

function guessCity(addr) {
  const cities = ['Phoenix','Scottsdale','Tempe','Gilbert','Mesa','Chandler','Queen Creek','Ahwatukee','Apache Junction','Maricopa','Paradise Valley','Gold Canyon','San Tan Valley','Peoria','Surprise','Glendale','Cave Creek','Fountain Hills'];
  const lower = (addr || '').toLowerCase();
  for (const city of cities) if (lower.includes(city.toLowerCase())) return city;
  return null;
}
