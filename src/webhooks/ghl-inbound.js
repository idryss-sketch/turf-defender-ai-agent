// Handler for inbound GHL message webhooks.
//
// Flow:
//   1. Receive webhook payload (new customer message arrives in GHL)
//   2. Check safety gates: kill-switch file, contact whitelist
//   3. Pull contact name + recent message history from GHL
//   4. Extract sq ft from history if mentioned
//   5. Call AI engine for next reply
//   6. Either: send reply via GHL, or trigger escalation notification
//   7. In DRY_RUN mode, log what would happen but don't actually send

import { existsSync } from 'node:fs';
import { getReply } from '../conversation/engine.js';
import * as ghl from '../integrations/ghl.js';
import * as jobber from '../integrations/jobber.js';
import { quote, PACKAGES } from '../conversation/pricing.js';
import { getState, updateState, extractSqft, buildCustomerContext, getConversationsByContact } from '../storage/conversations.js';
import { notifyHumanEscalation, notifyBookingResult, notifyHandoff } from '../utils/notify.js';

const KILL_SWITCH_PATH = new URL('../../data/.kill', import.meta.url);

// In-memory dedup cache: prevents GHL's duplicate webhook fires from sending
// the same reply twice. Key = conversationId + body hash, TTL = 45 seconds.
const _dedupCache = new Map();
function isDuplicate(conversationId, body) {
  const key = `${conversationId}::${body}`;
  const now = Date.now();
  const last = _dedupCache.get(key);
  if (last && now - last < 45_000) return true;
  _dedupCache.set(key, now);
  // Prune stale entries occasionally
  if (_dedupCache.size > 500) {
    for (const [k, t] of _dedupCache) {
      if (now - t > 45_000) _dedupCache.delete(k);
    }
  }
  return false;
}

function isKillSwitchActive() {
  return existsSync(KILL_SWITCH_PATH);
}

function isContactAllowed(contactId) {
  // SAFE DEFAULT: empty whitelist = NO ONE is allowed. Must explicitly opt in.
  if (process.env.ALLOW_ALL_CONTACTS === 'true') return true;
  const whitelist = (process.env.ALLOWED_CONTACTS || '').trim();
  if (!whitelist) return false;
  return whitelist.split(',').map((s) => s.trim()).includes(contactId);
}

/**
 * Main entrypoint. Handle a GHL inbound message webhook payload.
 * Returns a result object describing what happened (for logging/testing).
 */
export async function handleInboundMessage(payload) {
  // SAFE DEFAULT: dry run is ON unless DRY_RUN is explicitly set to "false".
  // This means: by default, the AI will THINK but won't actually send anything to your customers.
  const dryRun = process.env.DRY_RUN !== 'false';
  const result = {
    contactId: payload.contactId,
    conversationId: payload.conversationId,
    skipped: false,
    skipReason: null,
    aiReply: null,
    escalated: false,
    escalationReason: null,
    dryRun,
    sentToCustomer: false,
    booked: false,
    bookingPackage: null,
    jobberRequestId: null,
    bookingError: null,
  };

  // Safety gate 1: kill switch
  if (isKillSwitchActive()) {
    result.skipped = true;
    result.skipReason = 'KILL_SWITCH active (data/.kill file exists)';
    console.log(`⛔ ${result.skipReason} — ignoring message from ${payload.contactId}`);
    return result;
  }

  // Safety gate 2: contact whitelist
  if (!isContactAllowed(payload.contactId)) {
    result.skipped = true;
    result.skipReason = `Contact ${payload.contactId} not in ALLOWED_CONTACTS whitelist`;
    console.log(`⛔ ${result.skipReason}`);
    return result;
  }

  // Safety gate 3: dedup — GHL sometimes fires the same webhook twice within
  // seconds. If we've already processed this exact message for this conversation
  // in the last 45s, skip it silently.
  if (isDuplicate(payload.conversationId ?? payload.contactId, payload.body ?? '')) {
    result.skipped = true;
    result.skipReason = 'Duplicate webhook (same message within 45s) — skipped';
    console.log(`🔁 ${result.skipReason}`);
    return result;
  }

  // Some GHL workflow trigger versions don't expose conversation.id as a variable,
  // so the workflow sends contact.id as a placeholder. Detect that and resolve
  // the real conversationId via GHL search so message history works correctly.
  if (payload.conversationId === payload.contactId) {
    try {
      const realConvId = await ghl.findConversationByContact(payload.contactId);
      if (realConvId) {
        console.log(`🔁 Resolved conversationId for contact ${payload.contactId}: ${realConvId}`);
        payload.conversationId = realConvId;
        result.conversationId = realConvId;
      } else {
        console.warn(`⚠️  No conversation found for contact ${payload.contactId} — using contactId as state key (history fetch will fall back)`);
      }
    } catch (e) {
      console.warn(`⚠️  Conversation resolution failed: ${e.message} — using contactId as state key`);
    }
  }

  // Safety gate 3: previously escalated → AI stays out, BUT with a time
  // window. If the escalation is older than the stale threshold, we treat it
  // as stale and let the AI re-engage.
  //
  // Two windows:
  //   • 1 day  — booking-related escalations (human took over to close a deal,
  //              rebook/reschedule handoffs). These are routine completions, not
  //              problems — the customer should be able to reach the bot again
  //              the next day.
  //   • 7 days — everything else (price pushback, complaints, spam, etc.).
  const state = getState(payload.conversationId);
  if (state.escalated) {
    const reason = (state.escalationReason || '').toLowerCase();
    const isBookingHandoff =
      reason.includes('human took over') ||
      reason.includes('rebook request') ||
      reason.includes('reschedule request') ||
      reason.includes('address provided');
    const STALE_DAYS = isBookingHandoff
      ? 1
      : parseInt(process.env.ESCALATION_STALE_DAYS || '7', 10);
    const escalatedAt = state.escalatedAt || state.lastUpdated;
    const ageDays = escalatedAt
      ? (Date.now() - new Date(escalatedAt).getTime()) / (1000 * 60 * 60 * 24)
      : Infinity; // no timestamp → treat as stale and re-engage
    if (ageDays < STALE_DAYS) {
      result.skipped = true;
      result.skipReason = `Conversation already escalated (${state.escalationReason || 'unknown'}) — AI staying silent`;
      console.log(`🤐 ${result.skipReason} (escalated ${Math.round(ageDays * 10) / 10}d ago)`);
      return result;
    }
    // Stale escalation — clear the flag so the AI re-engages this turn.
    console.log(`♻️  Clearing stale escalation (${Math.round(ageDays)}d old, reason: ${state.escalationReason}) — letting AI re-engage`);
    updateState(payload.conversationId, {
      escalated: false,
      escalationReason: null,
      escalationClearedAt: new Date().toISOString(),
      previousEscalation: { reason: state.escalationReason, at: escalatedAt },
    });
  }

  // 1. Pull contact info — we cache the whole contact on state since we'll
  //    need phone/email/address later if a booking comes through. Also store
  //    contactId so we can look up prior conversations for this customer.
  let customerName = state.customerName;
  let contact = state.contact;
  if (!customerName || !contact) {
    try {
      contact = await ghl.getContact(payload.contactId);
      customerName = contact.firstName || contact.name?.split(' ')[0] || 'there';
      updateState(payload.conversationId, {
        contactId: payload.contactId,
        customerName,
        contact: {
          firstName: contact.firstName,
          lastName: contact.lastName,
          fullName: contact.name || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          phone: contact.phone,
          email: contact.email,
          address: contact.address1 || contact.address,
        },
      });
    } catch (e) {
      console.warn(`⚠️  Couldn't fetch contact: ${e.message} — proceeding without name`);
      customerName = 'there';
      contact = {};
    }
  } else if (!state.contactId) {
    // Backfill contactId on existing state records (older conversations
    // before we started storing it).
    updateState(payload.conversationId, { contactId: payload.contactId });
  }

  // Lifetime customer memory: if this contact has prior conversations with
  // us, build a short context summary the AI can use to personalize.
  const customerContext = buildCustomerContext(payload.contactId, payload.conversationId);
  if (customerContext) {
    console.log(`👋 Returning customer detected — injecting context into prompt`);
  }

  // 2. Pull recent message history (and derive real channel from it).
  // Time-window filter: only show AI messages from the last 14 days. Returning
  // customers who haven't messaged in 30+ days will be treated as a fresh
  // conversation (empty history) so the AI won't re-escalate based on stale
  // price pushback or other historical signals.
  let history;
  let ghlMessages = [];
  let recentMessages = [];
  try {
    ghlMessages = await ghl.getMessages(payload.conversationId);
    recentMessages = ghl.filterRecentMessages(ghlMessages, { daysWindow: 14, maxCount: 10 });
    if (ghlMessages.length > recentMessages.length) {
      console.log(`📅 Filtered history: ${ghlMessages.length} total → ${recentMessages.length} recent (last 14 days, max 10)`);
    }
    history = ghl.ghlMessagesToClaudeHistory(recentMessages);
  } catch (e) {
    // Fall back to just the new message if GHL history fetch fails
    console.warn(`⚠️  Couldn't fetch history: ${e.message} — using just the new message`);
    history = [{ role: 'user', content: payload.body }];
  }

  // GHL's history endpoint sometimes lags behind the webhook — when a customer
  // sends a message, the webhook can fire BEFORE GHL has indexed the new
  // message into history. That leaves the AI's previous reply as the last
  // entry, which Claude rejects ("conversation must end with a user message").
  //
  // Defensive fix: if history doesn't end with a user message, append the
  // current inbound payload.body as one. Also dedupe: if the last user
  // message already equals payload.body, skip (history was already current).
  const lastMsg = history[history.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    history.push({ role: 'user', content: payload.body });
  } else if (lastMsg.content !== payload.body) {
    // Last message is a user message but a DIFFERENT one — append this one too.
    history.push({ role: 'user', content: payload.body });
  }

  // NOTE: Day/time and address are no longer auto-captured from the next
  // inbound. The AI parses the customer's response and emits [DAYTIME: ...]
  // or [ADDRESS: ...] markers when it identifies the captured value. This
  // way, mid-flow questions get answered properly instead of being garbled
  // as "day/time" or "address."

  // Human takeover detection: if a human (Dalis or Dave) typed a reply
  // directly in GHL, silently mark the conversation as human-handled and
  // bail. No SMS notification — the human is already engaged.
  const aiSentMessageIds = state.aiSentMessageIds || [];
  const humanTakeover = ghl.detectHumanTakeover(ghlMessages, aiSentMessageIds);
  if (humanTakeover) {
    updateState(payload.conversationId, {
      escalated: true,
      escalatedAt: new Date().toISOString(),
      escalationReason: 'Human took over in GHL',
      humanTakeover: {
        source: humanTakeover.source,
        body: humanTakeover.message.body,
        ts: humanTakeover.message.dateAdded || new Date().toISOString(),
      },
    });
    result.skipped = true;
    result.skipReason = 'Human took over in GHL — AI stepping out';
    console.log(`🤝 Human reply detected in conversation ${payload.conversationId} (via ${humanTakeover.source}) — AI stepping out silently`);
    return result;
  }

  // Derive the real channel from the customer's most recent inbound message.
  // Necessary because some GHL workflow triggers don't expose message.type as
  // a variable, so the workflow sends a placeholder (e.g. "SMS") that we
  // override here with the actual channel — so replies go back via the right
  // channel (Instagram → Instagram, FB → FB, SMS → SMS, etc).
  const derivedChannel = ghl.getLastInboundChannel(ghlMessages);
  if (derivedChannel) {
    if (derivedChannel !== payload.messageType) {
      console.log(`📡 Channel resolved from history: ${derivedChannel} (workflow sent: ${payload.messageType || 'none'})`);
    }
    payload.messageType = derivedChannel;
    // Persist channel on the conversation for analytics (channel performance widget)
    if (!state.channel) {
      updateState(payload.conversationId, { channel: derivedChannel });
    }
  }

  // FORM SUBMISSION OVERRIDE: when the inbound is a fresh web form submission
  // and the contact gave us a phone number, ALWAYS reply via SMS — even if
  // the customer has prior email history with us. The form is a "fresh
  // start" intent and texting closes faster than email. Without this, a
  // returning customer who filled out the form would get an email reply
  // (because getLastInboundChannel anchors to their old email thread).
  const inboundIsForm = /^web form submission/i.test(payload.body || '');
  if (inboundIsForm && contact?.phone) {
    if (payload.messageType !== 'SMS') {
      console.log(`📞 Form submission with phone — overriding channel to SMS (was ${payload.messageType})`);
    }
    payload.messageType = 'SMS';
    updateState(payload.conversationId, { channel: 'SMS' });
  }

  // Smart channel fallback: if we're set to reply via SMS but the contact
  // has no phone (e.g., they filled out the web form with only email),
  // automatically switch to Email so the AI's reply can actually reach them.
  // Order of preference: SMS (if phone) → Email (if email) → escalate
  //
  // IMPORTANT: this whole block ONLY applies when payload.messageType is SMS.
  // For IG / FB / WhatsApp / Web chat, the channel itself IS the contact
  // method — we don't need a phone or email to reply, we just send back
  // through the same DM thread. So those channels skip this gate entirely.
  const dmChannels = new Set(['IG', 'FB', 'WhatsApp', 'Custom']);
  if (payload.messageType === 'SMS' && !contact?.phone && contact?.email) {
    console.log(`📨 No phone on contact — falling back to Email channel for reply`);
    payload.messageType = 'Email';
    updateState(payload.conversationId, { channel: 'Email' });
  } else if (payload.messageType === 'SMS' && !contact?.phone && !contact?.email) {
    // Last-ditch channel detection: if there's ANY message in history at all,
    // it must have come through SOME channel. Use the latest message's
    // channel even if our normalization missed it earlier.
    const fallbackChannel = ghlMessages.length > 0
      ? ghl.normalizeChannel(ghlMessages[0].messageType || ghlMessages[0].type)
      : null;
    if (fallbackChannel && dmChannels.has(fallbackChannel)) {
      console.log(`📲 No phone/email but channel is ${fallbackChannel} — replying via DM thread (channel IS the contact method)`);
      payload.messageType = fallbackChannel;
      updateState(payload.conversationId, { channel: fallbackChannel });
    } else {
      console.warn(`⚠️  Contact has no phone AND no email AND no DM channel — cannot send reply, escalating`);
      notifyHumanEscalation({
        contactId: payload.contactId,
        conversationId: payload.conversationId,
        customerName,
        channel: 'unknown',
        reason: 'No contact method available (no phone, no email, no DM channel)',
        lastCustomerMessage: payload.body,
      });
      updateState(payload.conversationId, {
        escalated: true,
        escalatedAt: new Date().toISOString(),
        escalationReason: 'No reply channel available',
      });
      result.skipped = true;
      result.skipReason = 'No phone or email — escalated to human';
      return result;
    }
  }
  // Hard media escalation: if customer sends photos/videos of the turf,
  // do not let AI guess from a blank message. Notify humans and step out.
  const hasMedia =
    payload.hasMedia === true ||
    payload.hasMedia === 'true' ||
    payload.messageType === 'image' ||
    payload.messageType === 'video' ||
    payload.attachments?.length > 0 ||
    payload.media?.length > 0 ||
    payload.files?.length > 0 ||
    payload.body === '';

  if (hasMedia) {
    const reason = 'Customer sent photo/image/video for human review';
    notifyHumanEscalation({
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      customerName,
      channel: ghl.channelLabel(payload.messageType || 'SMS'),
      reason,
      lastCustomerMessage: payload.body || '[media attachment]',
    });

    updateState(payload.conversationId, {
      escalated: true,
      escalatedAt: new Date().toISOString(),
      escalationReason: reason,
    });

    result.escalated = true;
    result.escalationReason = reason;
    result.skipped = true;
    result.skipReason = 'Media attachment detected — escalated to human';

    console.log(`📷 Media attachment detected — humans notified, AI stepping out.`);
    return result;
  }
  // 3. Extract sq ft if any customer message mentions it
  let sqft = state.sqft;
  if (!sqft) {
    for (const msg of history) {
      if (msg.role === 'user') {
        const found = extractSqft(msg.content);
        if (found) {
          sqft = found;
          updateState(payload.conversationId, { sqft });
          console.log(`📐 Detected sq ft: ${sqft}`);
          break;
        }
      }
    }
  }
  // For returning customers: if sqft still unknown, inherit from their most
  // recent prior conversation that has it. This ensures price placeholders
  // (like [[KHLOE_FIRST_TIME]]) resolve correctly in the rebook flow even
  // when the customer starts a brand-new GHL conversation thread.
  if (!sqft && payload.contactId) {
    const priors = getConversationsByContact(payload.contactId, payload.conversationId);
    const priorWithSqft = priors.find((p) => p.sqft);
    if (priorWithSqft) {
      sqft = priorWithSqft.sqft;
      updateState(payload.conversationId, { sqft });
      console.log(`📐 Inherited sq ft from prior conversation: ${sqft}`);
    }
  }

  // 4. Call AI
  const { reply, escalation, booking, daytime, address, handoff, usage } = await getReply({
    customerName,
    history,
    sqft,
    customerContext,
    channel: ghl.channelLabel(payload.messageType || 'SMS'),
  });

  // Capture day/time and address from AI markers as soon as the AI emits them.
  // (These get persisted to state so the handoff SMS can include them.)
  if (daytime?.captured) {
    updateState(payload.conversationId, { preferredDayTime: daytime.value });
    console.log(`🗓️  Day/time captured by AI: "${daytime.value}"`);
  }
  if (address?.captured) {
    updateState(payload.conversationId, { address: address.value });
    console.log(`📍 Address captured by AI: "${address.value}"`);
  }

  // 5a. Escalation path — TWO modes:
  //   • Silent escalation (no customer-facing text after stripping marker):
  //     Mark conversation as escalated, fire SMS to humans, AI stays silent.
  //     Used for price pushback, low confidence, etc.
  //   • Answer + notify (AI emitted marker AND a customer-facing answer):
  //     Send the answer to the customer, fire SMS to humans, but DON'T mark
  //     the conversation as escalated — AI keeps engaging. Used when AI
  //     answers a question (e.g., commercial pricing) and humans need to
  //     follow up to provide custom pricing/scheduling.
  if (escalation.escalated) {
    result.escalated = true;
    result.escalationReason = escalation.reason;
    notifyHumanEscalation({
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      customerName,
      channel: ghl.channelLabel(payload.messageType || 'SMS'),
      reason: escalation.reason,
      lastCustomerMessage: payload.body,
    });

    const isPhotoEscalation = /photo|image|screenshot|video|visual/i.test(escalation.reason || '');

    // Silent escalation: no customer-facing text → bail.
    if (!reply || reply.trim() === '') {
      updateState(payload.conversationId, {
        escalated: true,
        escalatedAt: new Date().toISOString(),
        escalationReason: escalation.reason,
      });
      console.log(`🤐 Silent escalation — AI staying silent, humans notified.`);
      return result;
    }

    // For photo/image/video handoff, send the short acknowledgement once, then
    // lock the conversation as escalated so the AI does not keep asking the
    // same qualifying questions. Humans take over after the acknowledgement.
    if (isPhotoEscalation) {
      updateState(payload.conversationId, {
        escalated: true,
        escalatedAt: new Date().toISOString(),
        escalationReason: escalation.reason,
      });
      console.log(`📷 Photo/image escalation — sending acknowledgement, then AI steps out.`);
    } else {
      // Otherwise: AI gave an answer AND escalated — fall through to send
      // the customer-facing reply. Don't mark conversation escalated — AI
      // continues engaging on follow-up messages.
      console.log(`📣 Answer-and-notify escalation — AI sent: "${reply.slice(0, 60)}..." and humans notified.`);
    }
  }

  // 5b. Normal reply path
  result.aiReply = reply;

  // 5c. Booking detected → either create Jobber Request OR fire a coordinator
  //     notification, depending on what's configured. Either way, the customer
  //     reply is never blocked — booking handling is fire-and-fallback.
  //
  // SAFETY GUARD: suppress [BOOK: ...] if this is the AI's FIRST reply to a
  // Web form submission. The form pre-selecting a service isn't a real
  // booking confirmation — the customer hasn't replied yet. The AI's prompt
  // tells it not to emit [BOOK] in this case, but if it does anyway, we drop
  // the marker here so we don't fire a premature coordinator notification.
  const isFormSubmission = /^web form submission/i.test(payload.body || '');
  const aiHasNotRepliedYet = (state.aiSentMessageIds || []).length === 0;
  if (booking?.booked && isFormSubmission && aiHasNotRepliedYet) {
    console.warn(`🚧 Suppressing [BOOK: ${booking.package}] — first reply to form submission, customer has not confirmed yet.`);
    booking.booked = false;
    booking.package = null;
  }
  if (booking?.booked) {
    result.booked = true;
    result.bookingPackage = booking.package;

    const channel = ghl.channelLabel(payload.messageType || 'SMS');
    const customerLabel = customerFacingLabel(booking.package);

    // Calculate the price we just quoted (always first-time discount applied).
    let price = null;
    if (sqft) {
      try {
        price = quote(booking.package, sqft, /* firstTime */ true).firstTime;
      } catch (e) {
        console.warn(`⚠️  Couldn't price ${booking.package} for sqft=${sqft}: ${e.message}`);
      }
    }

    // Mark state as booked first (so duplicate AI BOOK markers don't double-create)
    updateState(payload.conversationId, {
      booked: true,
      bookingPackage: booking.package,
      bookingPrice: price,
      bookingTimestamp: new Date().toISOString(),
      handedOff: false,  // Reset so rebook flows re-trigger handoff SMS
    });

    // Booking mode resolver:
    //   • DRY_RUN          → dry-run log only (no notification, no API call)
    //   • notification mode → fire coordinator notification (default when no
    //     Jobber API creds are configured, or when JOBBER_NOTIFICATION_ONLY=true)
    //   • auto mode         → call Jobber API; on failure, fall back to a
    //     'failed' notification so the lead is never dropped.
    const useJobberApi =
      process.env.JOBBER_NOTIFICATION_ONLY !== 'true' &&
      !!process.env.JOBBER_CLIENT_ID &&
      !!process.env.JOBBER_CLIENT_SECRET &&
      !!process.env.JOBBER_REFRESH_TOKEN;

    const bookingPayload = {
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      customerName: contact?.fullName || customerName,
      customerLabel,
      packageId: booking.package,
      sqft,
      price,
      channel,
      phone: contact?.phone,
      email: contact?.email,
      address: contact?.address,
    };

    if (dryRun) {
      const modeLabel = useJobberApi ? 'auto-create Jobber Request' : 'fire coordinator notification';
      console.log(`\n🧪 DRY RUN — would ${modeLabel}:`);
      console.log(`   Package: ${customerLabel} (internal: ${booking.package})`);
      console.log(`   Customer: ${bookingPayload.customerName} ${bookingPayload.phone ? `(${bookingPayload.phone})` : ''}`);
      console.log(`   Sqft: ${sqft || '?'}   Price: ${price ? '$' + price : '?'}`);
    } else if (!useJobberApi) {
      // ─── Notification mode (default for Jobber Core / no API plan) ───
      result.bookingMode = 'notify';
      notifyBookingResult({ mode: 'notify', ...bookingPayload });
    } else {
      // ─── Auto mode (Jobber API configured) ───
      try {
        const res = await jobber.createRequest({
          ...bookingPayload,
          customerName: bookingPayload.customerName,
          package: booking.package,
          packageLabel: customerLabel,
        });
        result.jobberRequestId = res.requestId;
        result.bookingMode = 'auto';
        updateState(payload.conversationId, { jobberRequestId: res.requestId });
        notifyBookingResult({
          mode: 'auto',
          ...bookingPayload,
          jobberRequestId: res.requestId,
        });
      } catch (e) {
        // Graceful fallback: customer still hears the AI's confirmation;
        // coordinator gets a 'failed' notification so the lead isn't dropped.
        result.bookingError = e.message;
        result.bookingMode = 'failed';
        console.error(`❌ Jobber createRequest failed: ${e.message}`);
        notifyBookingResult({
          mode: 'failed',
          ...bookingPayload,
          error: e.message,
        });
      }
    }
  }

  // If the AI captured an address, fire the handoff SMS. Mark conversation
  // as handedOff (NOT escalated) so the AI can still answer follow-up
  // questions later. Don't re-fire the handoff SMS on subsequent messages.
  if (address?.captured && !state.handedOff) {
    const cur = getState(payload.conversationId);
    const channel = ghl.channelLabel(payload.messageType || 'SMS');
    const customerLabel = customerFacingLabel(cur.bookingPackage);
    notifyHandoff({
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      customerName: cur.contact?.fullName || customerName,
      customerLabel,
      packageId: cur.bookingPackage,
      sqft: cur.sqft,
      price: cur.bookingPrice,
      phone: cur.contact?.phone,
      email: cur.contact?.email,
      address: address.value,
      preferredDayTime: cur.preferredDayTime,
      channel,
    });
    updateState(payload.conversationId, {
      handedOff: true,
      handoffReason: 'Address provided',
      handoffTimestamp: new Date().toISOString(),
    });
    result.handoff = 'address_captured';

    // If the AI's reply was JUST the marker (no customer-facing text),
    // don't send anything to the customer — humans take over.
    if (!reply || reply.trim() === '') {
      result.skipped = true;
      console.log(`📭 Address marker captured — humans taking over, no reply sent to customer`);
      return result;
    }
    // Otherwise (AI also answered a question), fall through to send the reply
    console.log(`📭 Address captured AND AI answered a question — sending reply, then handing off`);
  }

  if (dryRun) {
    console.log(`\n🧪 DRY RUN — would send to ${customerName}:`);
    console.log(`   ${reply}\n`);
    return result;
  }

  // Defensive: never send an empty message. If the AI's response was
  // markers-only (and didn't get caught by the address-capture branch
  // above), bail silently here instead of hitting GHL with empty body.
  if (!reply || reply.trim() === '') {
    console.warn(`⚠️  AI reply is empty after marker stripping — skipping sendMessage to avoid 422 error.`);
    result.skipped = true;
    result.skipReason = 'Empty AI reply after marker stripping';
    return result;
  }

  // Output safety net: detect meta-language patterns where the AI is
  // talking ABOUT itself instead of TO the customer. This happens when the
  // AI gets confused (e.g., joins a conversation already being handled by
  // humans). Force-escalate instead of sending the broken message.
  const metaPatterns = [
    /based on my role/i,
    /the ai (sales )?flow/i,
    /the ai (chat ?bot|assistant)/i,
    /\bI'?m an ai\b/i,
    /\bas an ai\b/i,
    /this conversation is (?:already )?past the handoff/i,
    /please share the customer'?s first message/i,
    /from the top of the script/i,
    /handled by humans/i,
    /human team member/i,
    /test or a new conversation/i,
  ];
  for (const pat of metaPatterns) {
    if (pat.test(reply)) {
      console.warn(`🚨 Meta-language detected in AI reply (matched: ${pat}). Force-escalating instead of sending: "${reply.slice(0, 100)}..."`);
      notifyHumanEscalation({
        contactId: payload.contactId,
        conversationId: payload.conversationId,
        customerName,
        channel: ghl.channelLabel(payload.messageType || 'SMS'),
        reason: 'AI generated meta-language (broke character) — auto-escalated',
        lastCustomerMessage: payload.body,
      });
      updateState(payload.conversationId, {
        escalated: true,
        escalatedAt: new Date().toISOString(),
        escalationReason: 'AI broke character — meta-language detected',
      });
      result.skipped = true;
      result.skipReason = 'Meta-language safety net triggered';
      return result;
    }
  }

  // For email replies, pull the threading fields off the most recent
  // inbound email so GHL adds proper In-Reply-To / References headers and
  // Gmail/Outlook keep everything in ONE thread (instead of fanning out a
  // new thread per turn).
  //   • emailMessageId = the RFC822 Message-ID of the inbound (lives in
  //     meta.email.messageIds[0]) — this is the field GHL v2 actually uses
  //     for proper email threading.
  //   • replyMessageId = GHL's internal message id (kept as fallback).
  //   • threadId       = GHL's thread id (if exposed).
  // sendMessage() will retry without these fields if GHL rejects them, so
  // a stale/missing ID never drops the customer reply.
  // For email: find the customer's actual inbound email (NOT our own
  // outbound, which GHL confusingly labels as inbound in the listing API)
  // and pass its GHL message id as replyMessageId so GHL builds proper
  // In-Reply-To headers and Gmail keeps everything in one thread.
  // Body-matching against payload.body is the most reliable signal since
  // GHL's direction labels for email aren't trustworthy.
  let emailTargets = null;
  if ((payload.messageType || 'SMS') === 'Email') {
    emailTargets = ghl.getEmailReplyTargets(ghlMessages, {
      triggerBody: payload.body,
      aiSentMessageIds: state.aiSentMessageIds || [],
    });
    // (Don't log threading target — GHL's reply endpoint doesn't recognize
    // these IDs, so the send always falls through to the "new thread"
    // retry path. Kept the field-passing in case GHL fixes their API.)
  }

  // Actually send the customer-facing reply
  try {
    const sendResult = await ghl.sendMessage({
      contactId: payload.contactId,
      message: reply,
      type: payload.messageType || 'SMS',
      conversationId: payload.conversationId,
      ...(emailTargets || {}),
    });
    result.sentToCustomer = true;
    console.log(`✅ Sent to ${customerName} (${usage.input_tokens}+${usage.output_tokens} tokens)`);

    // Track the message IDs of every AI-sent reply so we can later detect
    // human takeover (any outbound message whose id isn't in our list AND
    // has a userId set = a logged-in human typed it). Cap at last 30.
    const newId = ghl.extractMessageId(sendResult);
    if (newId) {
      const prevIds = (getState(payload.conversationId).aiSentMessageIds || []);
      const aiSentMessageIds = [...prevIds, newId].slice(-30);
      updateState(payload.conversationId, { aiSentMessageIds });
    }

    // Track running token usage on the conversation so we can compute
    // cost-per-booking metrics on the dashboard.
    const curState = getState(payload.conversationId);
    const prevTokens = curState.tokenUsage || { input: 0, output: 0, turns: 0 };
    updateState(payload.conversationId, {
      tokenUsage: {
        input: prevTokens.input + (usage?.input_tokens || 0),
        output: prevTokens.output + (usage?.output_tokens || 0),
        turns: prevTokens.turns + 1,
      },
    });

    // Track questions the customer has asked so we can surface them on the
    // dashboard. Heuristic: customer messages containing "?" are questions.
    if (payload.body && payload.body.includes('?')) {
      const prevQs = curState.questionsAsked || [];
      const trimmed = payload.body.trim().slice(0, 140);
      const newQs = [...prevQs, { text: trimmed, ts: new Date().toISOString() }].slice(-20);
      updateState(payload.conversationId, { questionsAsked: newQs });
    }

    // Handoff marker handling — AI signaled it's done with the customer:
    //   • AWAIT_ADDRESS: AI just asked for the address. Just log it.
    //     The address will be captured via [ADDRESS: ...] marker on the
    //     AI's NEXT reply (after the customer sends address). At that
    //     point the handoff SMS fires with full info.
    //   • CLOSE: AI sent the wrap-up. Fire the handoff SMS now (no address
    //     coming since customer didn't give a specific day/time).
    if (handoff?.handed) {
      const cur = getState(payload.conversationId);
      if (handoff.kind === 'await_address') {
        result.handoff = 'await_address';
        console.log(`📭 Awaiting address from ${customerName} — AI will capture it from next reply via [ADDRESS: ...] marker.`);
      } else if (handoff.kind === 'close') {
        // Only fire SMS once per handoff — guard against double-fires if the
        // AI accidentally re-emits [HANDOFF: CLOSE] in a follow-up message.
        if (!cur.handedOff) {
          const channel = ghl.channelLabel(payload.messageType || 'SMS');
          const customerLabel = customerFacingLabel(cur.bookingPackage);
          notifyHandoff({
            contactId: payload.contactId,
            conversationId: payload.conversationId,
            customerName: cur.contact?.fullName || customerName,
            customerLabel,
            packageId: cur.bookingPackage,
            sqft: cur.sqft,
            price: cur.bookingPrice,
            phone: cur.contact?.phone,
            email: cur.contact?.email,
            address: null,
            preferredDayTime: cur.preferredDayTime,
            channel,
          });
        }
        // Mark handedOff (NOT escalated) so AI can still answer follow-up
        // questions from FAQ, but won't re-pitch or push the sale.
        updateState(payload.conversationId, {
          handedOff: true,
          handoffReason: 'AI completed conversation',
          handoffTimestamp: new Date().toISOString(),
        });
        result.handoff = 'close';
      }
    }
  } catch (e) {
    console.error(`❌ Failed to send: ${e.message}`);
    throw e;
  }

  return result;
}

/**
 * Internal package ID → customer-facing label.
 * Used when building Jobber Request titles/notes (so the coordinator sees
 * "deep clean" rather than the internal id).
 */
function customerFacingLabel(packageId) {
  const map = {
    
    deep: 'deep clean',
    extraction: 'extraction service',
  };
  return map[packageId] || PACKAGES[packageId]?.tagline || packageId;
}
