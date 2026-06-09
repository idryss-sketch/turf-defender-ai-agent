# SCT Sales Agent

AI sales agent for Squeaky Clean Turf. Runs conversations through GoHighLevel using Claude.

## What's built so far (Phase 1)

- **Conversation engine** — Claude Sonnet 4.6 with the locked SCT script, pricing, and escalation rules.
- **Quote calculator** — Winnie / Khloe / Karl pricing with first-time discount.
- **Test scripts** — run conversations against real customer scenarios to verify the AI follows the script.

Not built yet (next phases): GHL webhook handler, Jobber OAuth, deployment.

## Running locally

You need **Node.js 20 or newer**. Check with:

```bash
node --version
```

If you don't have Node, install it: `brew install node` (or download from nodejs.org).

### Step 1 — Open Terminal and go to the app folder

```bash
cd "/Users/dalissmith/Desktop/AI Sales Agent (prototype)/app"
```

### Step 2 — Verify pricing works (no internet needed)

```bash
node scripts/test-pricing.js
```

You should see quote tables for Winnie/Khloe/Karl across different yard sizes.

### Step 3 — Test a real Claude conversation (uses your API key)

```bash
node scripts/test-conversation-direct.js marcus
```

This runs a 4-message scripted conversation pretending to be Marcus (Scottsdale, 600 sq ft, mild odor) and shows you exactly what the AI replies at each step. You'll see token counts and total cost (should be a few cents).

Other scenarios you can try:

```bash
node scripts/test-conversation-direct.js karen_pushback
node scripts/test-conversation-direct.js janet_price_obj
node scripts/test-conversation-direct.js patricia_no_sqft
```

### What we're checking

For each scenario, the AI should:
1. Open with the exact greeting + 5 qualifying questions
2. Pitch Khloe with the correct calculated price
3. Ask "We also offer an extraction service..." gating question
4. Only explain Karl after they say yes
5. Close with "Which one do you think would be best suited?"
6. Hand off to Dalis (not improvise) on price pushback or unknown sq ft

If anything's wrong, copy the output and paste it back to Claude — we'll fix.

## Running the server locally

In Terminal:

```bash
cd "/Users/dalissmith/Desktop/AI Sales Agent (prototype)/app"
node src/server.js
```

You'll see startup logs showing all the safety gates. Open http://localhost:3000/dashboard in your browser to see the live dashboard. Press Ctrl+C in Terminal to stop the server.

**Safety defaults** — even if running, the server WON'T send any real messages because:
- `DRY_RUN=true` is the default (AI logs replies, doesn't send)
- `ALLOWED_CONTACTS` is empty (no one allowed to be messaged)
- A `data/.kill` file (if present) blocks everything

To disable a safety gate, set the matching env var (see `.env.example`).

## Deploying to a real server

See **DEPLOY.md** for the full Railway deployment guide. ~30 minutes start-to-finish.

## File layout

```
app/
├── package.json           Zero deps — uses native fetch
├── railway.json           Railway deployment config
├── .nvmrc                 Pins Node version
├── .env                   Your API keys (auto-generated from ../api-keys.txt)
├── .env.example           Template with all available env vars
├── DEPLOY.md              Step-by-step Railway deploy guide
├── src/
│   ├── server.js                   HTTP server: webhooks + API + dashboard
│   ├── conversation/
│   │   ├── pricing.js              Quote calculator (Winnie/Khloe/Karl)
│   │   ├── prompts.js              System prompt with locked script
│   │   └── engine.js               Claude wrapper (zero-dep, uses fetch)
│   ├── integrations/
│   │   └── ghl.js                  GoHighLevel API wrapper
│   ├── webhooks/
│   │   └── ghl-inbound.js          Inbound message handler with safety gates
│   ├── storage/
│   │   └── conversations.js        Per-conversation state (JSON file)
│   └── utils/
│       └── notify.js               Escalation notifications to Dalis
├── public/
│   └── dashboard.html              Live dashboard (auto-refreshes every 5s)
├── data/
│   ├── conversations.json          Persistent conversation state
│   ├── notifications.json          Escalation log
│   └── .kill                       (if present) Master kill switch
└── scripts/
    ├── test-pricing.js             Pricing smoke test
    ├── test-conversation-direct.js Zero-dep AI conversation test
    └── test-server.js              End-to-end server test with mock webhook
```
