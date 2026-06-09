# Deployment Guide — Railway

Step-by-step guide to deploy the SCT Sales Agent to a real server so GoHighLevel
can send webhooks to it. Designed to be done by a non-developer in ~30 minutes.

---

## Why Railway?

- **Free tier** that handles your projected volume (no credit card required to start)
- **Auto-deploys** from GitHub on every commit (or one command from your Mac)
- **Public HTTPS URL** out of the box (which GHL needs for webhooks)
- **Built-in env var management** (no editing .env files in production)

---

## Step 1 — Create a Railway account

1. Go to **railway.com** → click **Login** → sign in with GitHub or email.
2. (Optional but recommended) Add a payment method later in Settings → Billing → set a hard limit at $5/month so you can never get a surprise bill.

---

## Step 2 — Install the Railway CLI

The CLI lets you deploy from your Mac with one command. Open Terminal.

### Option A — via npm (recommended if you don't have Homebrew)
You already have Node installed, so this works out of the box:

```bash
npm install -g @railway/cli
```

If you get a permission error, prefix with `sudo`:

```bash
sudo npm install -g @railway/cli
```

### Option B — via Homebrew (if you have it)

```bash
brew install railway
```

### Then log in (either option)

```bash
railway login
```

(This opens a browser window — click to confirm. Use the same login method you used to sign up for Railway.)

---

## Step 3 — Initialize the project

In Terminal, navigate to the app folder:

```bash
cd "/Users/dalissmith/Desktop/AI Sales Agent (prototype)/app"
```

Initialize a Railway project:

```bash
railway init
```

When prompted:
- **Project name:** `sct-sales-agent`
- **Empty project** or **Deploy from template:** choose **Empty project**

---

## Step 4 — Set environment variables

You can do this either in the Railway web dashboard (railway.com) or via CLI.

**Easiest — web dashboard:**
1. Open your project at railway.com
2. Click your service → **Variables** tab → **+ New Variable**
3. Add each one:

| Name | Value | Notes |
|------|-------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Your Claude key from console.anthropic.com |
| `GHL_API_KEY` | `eyJ...` | Your GoHighLevel location API key |
| `BUSINESS_NAME` | `Squeaky Clean Turf` | Cosmetic, used in dashboard |
| `BUSINESS_AREA` | `Phoenix, AZ` | Cosmetic |
| `TIMEZONE` | `America/Phoenix` | For active hours check |
| `HOURS_START` | `06` | Active hours start (24h) |
| `HOURS_END` | `22` | Active hours end (24h) |
| `DRY_RUN` | `true` | **CRITICAL — leave this true for testing** |

**Jobber env vars are OPTIONAL.** If you skip them, the system runs in "notification mode" — when the AI closes a booking, the dashboard gets a coordinator-queue entry with all the details to copy into Jobber manually. This is the default for the SCT prototype because Jobber Core ($39/mo) doesn't include API access. To enable auto-create later (requires Connect plan), see `JOBBER_SETUP.md` and add `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`, `JOBBER_REFRESH_TOKEN`.

**Don't add `ALLOW_ALL_CONTACTS` or `ALLOWED_CONTACTS` yet.** That keeps the AI in completely safe mode (DRY_RUN + no whitelist = nothing happens to customers).

---

## Step 5 — Deploy

Back in Terminal:

```bash
railway up
```

Wait ~2 minutes. When done, Railway will show a deploy URL like:
```
https://sct-sales-agent-production.up.railway.app
```

**Copy that URL.** You'll need it for GHL webhook configuration.

---

## Step 6 — Verify the deploy

In your browser, open:
```
https://YOUR-URL.up.railway.app/health
```

You should see JSON like:
```json
{
  "status": "ok",
  "dryRun": true,
  "contactsAllowed": "NONE",
  "killSwitch": false,
  "timestamp": "..."
}
```

Then check the dashboard:
```
https://YOUR-URL.up.railway.app/dashboard
```

You should see the live dashboard. Currently empty (no conversations yet) but with status banner showing "🧪 SAFE MODE."

---

## Step 7 — Configure GHL webhook (click-by-click)

GHL's Webhook trigger lives inside Workflows. Here's the exact flow:

### 7a. Create the workflow
1. In GHL, left sidebar → **Automation** (some accounts call it **Workflows**)
2. Click **+ Create Workflow** → choose **Start from scratch** → name it `SCT AI Sales Agent — inbound`
3. Click **+ Add New Trigger** → search for and pick **"Customer Replied"** (or **"Inbound Message"** depending on GHL version)
4. Configure the trigger:
   - **Filters:** leave empty (we want every inbound message — the agent's safety gates filter on the receiving end)
   - Click **Save Trigger**

### 7b. Add the webhook action
1. Below the trigger, click **+** → **Webhook**
2. Configure:
   - **Method:** `POST`
   - **URL:** `https://YOUR-URL.up.railway.app/webhooks/ghl/inbound` (your Railway URL from Step 5)
   - **Content-Type / Headers:** add header `Content-Type: application/json`
3. **Body / Custom Data** — switch to "Custom Data" or "JSON Body" mode and paste:

   ```json
   {
     "contactId": "{{contact.id}}",
     "conversationId": "{{conversation.id}}",
     "messageType": "{{message.type}}",
     "body": "{{message.body}}",
     "direction": "inbound"
   }
   ```

   GHL will substitute the `{{...}}` placeholders with real values when each message comes in. If your GHL UI has a "Variable picker" instead of plain text, click each `{{...}}` slot and select the matching field from the dropdown (e.g., Contact → ID).

4. (Optional) Click **Test** in GHL — it'll fire a sample webhook with mock data. Check your Railway logs (Step 8) to confirm it arrives.

5. **Save** the action, then **Publish** the workflow. Toggle it **ON**.

### 7c. Confirm it's live
- The workflow status should show "Published" + green/active toggle.
- Try sending a test message to your business SMS number (or DM your business IG account from another phone). Refresh the dashboard at `/dashboard` — you should see the conversation appear within ~5 seconds.

It's now LIVE — but **DRY_RUN=true means customers still hear nothing.** The AI runs through the full script silently and you can watch on the dashboard.

### Common gotchas
- **Webhook fires but server returns 400 "Missing required fields"** — your JSON body has the wrong variable names. The 5 required fields (case-sensitive) are: `contactId`, `conversationId`, `messageType`, `body`, `direction`.
- **Webhook fires but server returns 500** — check Railway logs. Usually a missing env var or a typo in `ANTHROPIC_API_KEY` / `GHL_API_KEY`.
- **No webhook fires at all** — check the workflow is **Published** AND **toggled on**. GHL has both; either off and nothing fires.

---

## Step 8 — Test in safe mode

Send your test phone number (or DM your business IG account from a friend's account) a message like "hey need a quote." Then:

1. Refresh your dashboard at `https://YOUR-URL.up.railway.app/dashboard`
2. You should see the conversation appear
3. Check Railway logs: dashboard → Deployments → latest → View Logs
4. You'll see the AI's would-be reply logged but NOT sent

---

## Step 9 — Going live (graduated)

Once you've verified safe mode is working:

**Option A: Whitelist mode (test with one contact)**
1. Find your own contact ID in GHL (Contacts → click your test contact → URL has the ID)
2. In Railway → Variables, add: `ALLOWED_CONTACTS=your-contact-id-here`
3. Set `DRY_RUN=false`
4. Now the AI will respond to YOU only. Everyone else still ignored.
5. Test fully — quote flow, escalation, everything.

**Option B: Full live**
1. Remove `ALLOWED_CONTACTS` (or leave it)
2. Add `ALLOW_ALL_CONTACTS=true`
3. Set `DRY_RUN=false`
4. The AI now responds to all incoming messages.

---

## Emergency stop

If anything goes wrong, three ways to kill it instantly:

1. **In Railway:** dashboard → service → Stop. AI stops immediately.
2. **Set DRY_RUN=true:** in Railway Variables. Takes effect in ~10 seconds.
3. **Disable the webhook in GHL:** AI stops receiving messages.

---

## What it costs you

- **Railway:** Free for first ~$5/month of usage. At your projected volume, well under that.
- **Anthropic:** ~$30–60/month at 750 conversations/month.
- **GoHighLevel & Jobber:** unchanged, you already pay these.

Total marginal cost of running this: **$30–80/month**.
