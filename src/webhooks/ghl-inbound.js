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
import { getState, updateState, extractSqft, buildCustomerContext } from '../storage/conversations.js';
import { notifyHumanEscalation, notifyBookingResult, notifyHandoff } from '../utils/notify.js';

const KILL_SWITCH_PATH = new URL('../../data/.kill', import.meta.url);

function isKillSwitchActive() {
  return existsSync(KILL_SWITCH_PATH);
}

function isContactAllowed(contactId) {
  if (process.env.ALLOW_ALL_CONTACTS === 'true') return true;
  const whitelist = (process.env.ALLOWED_CONTACTS || '').trim();
  if (!whitelist) return false;
  return whitelist.split(',').map((s) => s.trim()).includes(contactId);
}

export async function handleInboundMessage(payload) {
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

  if (isKillSwitchActive()) {
    result.skipped = true;
    result.skipReason = 'KILL_SWITCH active (data/.kill file exists)';
    console.log(`⛔ ${result.skipReason} — ignoring message from ${payload.contactId}`);
    return result;
  }

  if (!isContactAllowed(payload.contactId)) {
    result.skipped = true;
    result.skipReason = `Contact ${payload.contactId} not in ALLOWED_CONTACTS whitelist`;
    console.log(`⛔ ${result.skipReason}`);
    return result;
  }

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

  const state = getState(payload.conversationId);
  if (state.escalated) {
    const STALE_DAYS = parseInt(process.env.ESCALATION_STALE_DAYS || '7', 10);
    const escalatedAt = state.escalatedAt || state.lastUpdated;
    const ageDays = escalatedAt
      ? (Date.now() - new Date(escalatedAt).getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;
    if (ageDays < STALE_DAYS) {
      result.skipped = true;
      result.skipReason = `Conversation already escalated (${state.escalationReason || 'unknown'}) — AI staying silent`;
      console.log(`🤐 ${result.skipReason} (escalated ${Math.round(ageDays * 10) / 10}d ago)`);
      return result;
    }
    console.log(`♻️  Clearing stale escalation (${Math.round(ageDays)}d old, reason: ${state.escalationReason}) — letting AI re-engage`);
    updateState(payload.conversationId, {
      escalated: false,
      escalationReason: null,
      escalationClearedAt: new Date().toISOString(),
      previousEscalation: { reason: state.escalationReason, at: escalatedAt },
    });
  }

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
    updateState(payload.conversationId, { contactId: payload.contactId });
  }

  const customerContext = buildCustomerContext(payload.contactId, payload.conversationId);
  if (customerContext) {
    console.log(`👋 Returning customer detected — injecting context into prompt`);
  }

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
    console.warn(`⚠️  Couldn't fetch history: ${e.message} — using just the new message`);
    history = [{ role: 'user', content: payload.body }];
  }

  const lastMsg = history[history.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    history.push({ role: 'user', content: payload.body });
  } else if (lastMsg.content !== payload.body) {
    history.push({ role: 'user', content: payload.body });
  }

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

  const derivedChannel = ghl.getLastInboundChannel(ghlMessages);
  if (derivedChannel) {
    if (derivedChannel !== payload.messageType) {
      console.log(`📡 Channel resolved from history: ${derivedChannel} (workflow sent: ${payload.messageType || 'none'})`);
    }
    payload.messageType = derivedChannel;
    if (!state.channel) {
      updateState(payload.conversationId, { channel: derivedChannel });
    }
  }

  const inboundIsForm = /^web form submission/i.test(payload.body || '');
  if (inboundIsForm && contact?.phone) {
    if (payload.messageType !== 'SMS') {
      console.log(`📞 Form submission with phone — overriding channel to SMS (was ${payload.messageType})`);
    }
    payload.messageType = 'SMS';
    updateState(payload.conversationId, { channel: 'SMS' });
  }

  const dmChannels = new Set(['IG', 'FB', 'WhatsApp', 'Custom']);
  if (payload.messageType === 'SMS' && !contact?.phone && contact?.email) {
    console.log(`📨 No phone on contact — falling back to Email channel for reply`);
    payload.messageType = 'Email';
    updateState(payload.conversationId, { channel: 'Email' });
  } else if (payload.messageType === 'SMS' && !contact?.phone && !contact?.email) {
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

  const LARGE_JOB_THRESHOLD = 1000;
  if (sqft && sqft >= LARGE_JOB_THRESHOLD && !state.escalated) {
    console.log(`📐 Large job detected (${sqft} sqft ≥ ${LARGE_JOB_THRESHOLD}) — handing off to humans, skipping AI quote`);
    notifyHumanEscalation({
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      customerName,
      channel: payload.messageType || 'SMS',
      reason: `Large job — ${sqft} sqft over ${LARGE_JOB_THRESHOLD} sqft threshold. Human closer needed.`,
      lastCustomerMessage: payload.body,
    });
    updateState(payload.conversationId, {
      escalated: true,
      escalatedAt: new Date().toISOString(),
      escalationReason: `Large job — ${sqft} sqft over ${LARGE_JOB_THRESHOLD} sqft threshold`,
    });
    await ghl.sendMessage({
      conversationId: payload.conversationId,
      contactId: payload.contactId,
      messageType: payload.messageType || 'SMS',
      body: `For a yard that size I want to make sure we get you the most accurate quote possible. Let me have the team reach out to you directly — what's the best number or email to reach you at?`,
    });
    result.skipReason = `Large job (${sqft} sqft) — humans notified, AI stepping out`;
    return result;
  }

  const { reply, escalation, booking, daytime, address, handoff, usage } = await getReply({
    customerName,
    history,
    sqft,
    customerContext,
    channel: ghl.channelLabel(payload.messageType || 'SMS'),
  });

  if (daytime?.captured) {
    updateState(payload.conversationId, { preferredDayTime: daytime.value });
    console.log(`🗓️  Day/time captured by AI: "${daytime.value}"`);
  }
  if (address?.captured) {
    updateState(payload.conversationId, { address: address.value });
    console.log(`📍 Address captured by AI: "${address.value}"`);
  }

  if (escalation.escalated) {
    result.escalated = true;
    result.escalationReason = escalation.reason;
    notifyHumanEscalation({
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      customerName,
      channel: payload.messageType || 'SMS',
      reason: escalation.reason,
      lastCustomerMessage: payload.body,
    });

    const isPhotoEscalation = /photo|image|screenshot|video|visual/i.test(escalation.reason || '');

    if (!reply || reply.trim() === '') {
      updateState(payload.conversationId, {
        escalated: true,
        escalatedAt: new Date().toISOString(),
        escalationReason: escalation.reason,
      });
      console.log(`🤐 Silent escalation — AI staying silent, humans notified.`);
      return result;
    }

    if (isPhotoEscalation) {
      updateState(payload.conversationId, {
        escalated: true,
        escalatedAt: new Date().toISOString(),
        escalationReason: escalation.reason,
      });
      console.log(`📷 Photo/image escalation — sending acknowledgement, then AI steps out.`);
    } else {
      console.log(`📣 Answer-and-notify escalation — AI sent: "${reply.slice(0, 60)}..." and humans notified.`);
    }
  }

  result.aiReply = reply;

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

    // Guard against duplicate booking notifications: the AI sometimes
    // re-emits [BOOK: ...] on a later turn (e.g. confirming the package,
    // giving day/time, or giving address) even though this conversation
    // was already booked on a prior turn. Without this check, every one
    // of those turns re-fires the coordinator notification — Dalis gets
    // told to "create the matching Request in Jobber" two or three times
    // for the same job. Skip the notification when already booked; the
    // customer still gets a normal AI reply either way.
    const alreadyBooked = getState(payload.conversationId).booked;
    if (alreadyBooked) {
      console.log(`📋 [BOOK: ${booking.package}] re-emitted on a later turn for ${payload.conversationId} — already booked, skipping duplicate notification.`);
    } else {

    const channel = payload.messageType || 'SMS';
    const customerLabel = customerFacingLabel(booking.package);

    let price = null;
    if (sqft) {
      try {
        price = quote(booking.package, sqft, true).firstTime;
      } catch (e) {
        console.warn(`⚠️  Couldn't price ${booking.package} for sqft=${sqft}: ${e.message}`);
      }
    }

    updateState(payload.conversationId, {
      booked: true,
      bookingPackage: booking.package,
      bookingPrice: price,
      bookingTimestamp: new Date().toISOString(),
    });

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
      result.bookingMode = 'notify';
      notifyBookingResult({ mode: 'notify', ...bookingPayload });
    } else {
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
    } // end: alreadyBooked guard (skips re-notification on repeat [BOOK] markers)
  }

  if (address?.captured && !state.handedOff) {
    const cur = getState(payload.conversationId);
    const channel = payload.messageType || 'SMS';
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

    if (!reply || reply.trim() === '') {
      result.skipped = true;
      console.log(`📭 Address marker captured — humans taking over, no reply sent to customer`);
      return result;
    }
    console.log(`📭 Address captured AND AI answered a question — sending reply, then handing off`);
  }

  if (dryRun) {
    console.log(`\n🧪 DRY RUN — would send to ${customerName}:`);
    console.log(`   ${reply}\n`);
    return result;
  }

  if (!reply || reply.trim() === '') {
    console.warn(`⚠️  AI reply is empty after marker stripping — skipping sendMessage to avoid 422 error.`);
    result.skipped = true;
    result.skipReason = 'Empty AI reply after marker stripping';
    return result;
  }

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
        channel: payload.messageType || 'SMS',
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

  let emailTargets = null;
  if ((payload.messageType || 'SMS') === 'Email') {
    emailTargets = ghl.getEmailReplyTargets(ghlMessages, {
      triggerBody: payload.body,
      aiSentMessageIds: state.aiSentMessageIds || [],
    });
  }

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

    const newId = ghl.extractMessageId(sendResult);
    if (newId) {
      const prevIds = (getState(payload.conversationId).aiSentMessageIds || []);
      const aiSentMessageIds = [...prevIds, newId].slice(-30);
      updateState(payload.conversationId, { aiSentMessageIds });
    }

    const curState = getState(payload.conversationId);
    const prevTokens = curState.tokenUsage || { input: 0, output: 0, turns: 0 };
    updateState(payload.conversationId, {
      tokenUsage: {
        input: prevTokens.input + (usage?.input_tokens || 0),
        output: prevTokens.output + (usage?.output_tokens || 0),
        turns: prevTokens.turns + 1,
      },
    });

    if (payload.body && payload.body.includes('?')) {
      const prevQs = curState.questionsAsked || [];
      const trimmed = payload.body.trim().slice(0, 140);
      const newQs = [...prevQs, { text: trimmed, ts: new Date().toISOString() }].slice(-20);
      updateState(payload.conversationId, { questionsAsked: newQs });
    }

    if (handoff?.handed) {
      const cur = getState(payload.conversationId);
      if (handoff.kind === 'await_address') {
        result.handoff = 'await_address';
        console.log(`📭 Awaiting address from ${customerName} — AI will capture it from next reply via [ADDRESS: ...] marker.`);
      } else if (handoff.kind === 'close') {
        if (!cur.handedOff) {
          const channel = payload.messageType || 'SMS';
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

function customerFacingLabel(packageId) {
  const map = {
    winnie: 'quick clean',
    khloe: 'deep clean',
    karl: 'extraction service',
  };
  return map[packageId] || PACKAGES[packageId]?.tagline || packageId;
}
