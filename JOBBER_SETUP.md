# Jobber setup

The agent supports **two booking modes**. Pick whichever fits your Jobber plan and budget.

## Mode 1 — Notification mode (FREE, default, recommended for now)

You don't need any Jobber credentials. Works on **any Jobber plan including Core ($39/mo)**.

How it works: when the AI closes a booking, the system writes a `booking_notify` event to the notifications log + dashboard with everything the coordinator needs:
- Customer name, phone, email, address
- Package picked + internal code (so it matches Jobber's pricing)
- Sq ft + quoted price (first-time discount applied)
- Channel (SMS / Insta / etc.) + a direct link to the GHL conversation

Your coordinator opens Jobber → New Request → copy-paste those fields → done. ~30 seconds per booking.

### Setup
Nothing. Leave the `JOBBER_*` vars blank in `.env`. The system detects no creds and uses notification mode automatically.

### To force notification mode even with creds present (testing)
```
JOBBER_NOTIFICATION_ONLY=true
```

---

## Mode 2 — Auto-create mode (requires paid plan)

The AI talks to Jobber's GraphQL API and creates the Request automatically. Requires **Jobber Connect ($119/mo)** or higher — Core does not include API access.

If you decide to upgrade, do the following one-time setup. About 10 minutes.

### Step 1 — Register your developer app

1. Go to **https://developer.getjobber.com** and log in with the same Jobber account you use for SCT.
2. Click **Create App** (or "Manage Apps" → "New App").
3. Fill in:
   - **App name:** `SCT Sales Agent`
   - **App type:** Private (only you will use it)
   - **Redirect URI:** `http://localhost:8765/callback` (exact match, no trailing slash)
   - **Scopes:** check at minimum:
     - `read_clients`
     - `write_clients`
     - `write_requests`
4. Save. You'll see:
   - **Client ID** — copy it
   - **Client Secret** — click "Show"/"Reveal", copy it (only shown once)

### Step 2 — Put credentials in `.env`

```
JOBBER_CLIENT_ID=<paste your Client ID>
JOBBER_CLIENT_SECRET=<paste your Client Secret>
JOBBER_REFRESH_TOKEN=    # leave blank for now — Step 3 fills it
```

### Step 3 — Run the auth helper

From `app/`:
```
npm run jobber:auth
```

Follow the printed URL → click Allow → copy the printed `JOBBER_REFRESH_TOKEN=...` line into `.env`.

### Step 4 — Verify

```
npm run test:jobber
```

Expect to see "Jobber OAuth refresh ✅ got an access token" plus all 11 marker tests passing.

### Step 5 — (Optional) Live test

```
npm run test:jobber -- --create
```

Creates a real test Request in your Jobber account titled `[AI BOOKING] deep clean — TEST Customer (delete me)`. Delete it from the Jobber UI when satisfied.

### Step 6 — Add the same vars to Railway

When deploying, add `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`, `JOBBER_REFRESH_TOKEN` to the Railway environment variables.

---

## How tokens work

- The **refresh token** lasts a long time (months).
- The system trades it for short-lived **access tokens** (~1 hour) automatically.
- Tokens are cached in `data/.jobber-token.json` (gitignored, auto-managed).
- If Jobber rotates the refresh token, the rotated value is saved automatically — no re-bootstrap needed.

If you ever see `Jobber OAuth refresh failed (401)`:
1. The refresh token was revoked (you deleted the dev app, changed your password, etc.)
2. Re-run `npm run jobber:auth` to get a new one.

---

## Troubleshooting

**Can't access developer.getjobber.com — "no access" error.**
Your plan tier doesn't include API access. Core ($39/mo) does NOT. You need Connect ($119/mo) or higher to use Mode 2. Use Mode 1 (notification mode) instead — it requires zero Jobber credentials and works on Core.

**"Address already in use" running jobber-auth.js**
Another process is on port 8765:
```
lsof -ti:8765 | xargs kill -9
```

**"redirect_uri does not match"**
The redirect URI in the dev portal must be exactly `http://localhost:8765/callback`.

**"invalid_scope"**
Re-edit your dev app, tick the missing scopes, save, re-run `npm run jobber:auth`.
