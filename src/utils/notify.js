// Escalation + booking notifications — when AI hands off to humans.
//
// Three things happen on every notify event:
//   1. Console log (visible in Railway deploy logs)
//   2. Append to Postgres notifications table + in-memory cache
//      (powers the dashboard cards, persists across redeploys)
//   3. SMS to NOTIFY_CONTACT_IDS contacts (Dalis + business partner) via GHL
//
// Set NOTIFY_CONTACT_IDS env var to comma-separated GHL contact IDs of the
// humans who should receive SMS alerts (e.g. "ABC123,DEF456").
// If empty/unset, SMS sending is skipped silently (notifications still logged).

import * as ghl from '../integrations/ghl.js';
import { appendNotification } from '../storage/db.js';

// In-memory cache of all notifications. Sync reads via getAllNotifications().
// Loaded at boot from Postgres; appended in-place on each notify event AND
// fire-and-forget written to Postgres for persistence.
const cache = [];

/**
 * Hydrate the notifications cache from the DB. Called once at server boot.
 */
export function hydrateCache(loaded) {
  cache.length = 0;
  for (const n of (loaded || [])) cache.push(n);
}

/** Returns all notifications (caller may copy if needed). */
export function getAllNotifications() {
  return cache;
}

/** Internal: append to in-memory cache + persist to Postgres. */
function persistEvent(event) {
  cache.push(event);
  appendNotification(event).catch((e) => {
    console.warn(`⚠️  Postgres appendNotification failed: ${e.message}`);
  });
}

/**
 * Fire-and-forget SMS notification to all configured human recipients.
 * Failures are logged but don't throw — notifications are best-effort,
 * the dashboard log is the durable source of truth.
 */
async function sendNotificationSMS(message) {
  const ids = (process.env.NOTIFY_CONTACT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return; // not configured — skip silently
  for (const contactId of ids) {
    try {
      await ghl.sendMessage({ contactId, message, type: 'SMS' });
      console.log(`📲 SMS notification sent to ${contactId}`);
    } catch (e) {
      console.warn(`⚠️  Failed to send SMS notification to ${contactId}: ${e.message}`);
    }
  }
}

export function notifyHumanEscalation({ contactId, conversationId, customerName, channel, reason, lastCustomerMessage }) {
  const event = {
    timestamp: new Date().toISOString(),
    type: 'escalation',
    contactId,
    conversationId,
    customerName,
    channel,
    reason,
    lastCustomerMessage,
  };

  // Log to stdout so we see it during local dev
  console.log('\n🚨 ESCALATION — human takeover needed');
  console.log(`   Customer:  ${customerName} (${channel})`);
  console.log(`   Reason:    ${reason}`);
  console.log(`   Last msg:  "${lastCustomerMessage}"`);
  console.log(`   GHL link:  https://app.gohighlevel.com/conversations/${conversationId}\n`);

  // Persist to Postgres + in-memory cache
  persistEvent(event);

  // SMS notification to human team — fire-and-forget
  const smsBody = [
    `🚨 SCT AI escalation`,
    `Customer: ${customerName} (${channel})`,
    `Reason: ${reason}`,
    `Last msg: "${lastCustomerMessage}"`,
    `Take over: https://app.gohighlevel.com/conversations/${conversationId}`,
  ].join('\n');
  sendNotificationSMS(smsBody).catch((e) => console.warn('SMS notify failed:', e.message));

  return event;
}

/**
 * Booking event notification.
 *
 * Three modes:
 *   • mode='auto'   → Jobber API created the Request automatically. Informational.
 *   • mode='notify' → Notification mode (no Jobber API configured). Coordinator
 *                     creates the Request manually using the details below. This
 *                     is the EXPECTED path on Jobber Core plan, not an error.
 *   • mode='failed' → Jobber API was supposed to run but failed. Coordinator
 *                     must create the Request manually so the lead isn't dropped.
 */
export function notifyBookingResult({
  mode,
  contactId,
  conversationId,
  customerName,
  customerLabel,
  packageId,
  sqft,
  price,
  channel,
  phone,
  email,
  address,
  error,
  jobberRequestId,
}) {
  const event = {
    timestamp: new Date().toISOString(),
    type: `booking_${mode}`,           // booking_auto | booking_notify | booking_failed
    mode,
    contactId,
    conversationId,
    customerName,
    customerLabel,
    packageId,
    sqft,
    price,
    channel: channel || null,
    phone: phone || null,
    email: email || null,
    address: address || null,
    error: error || null,
    jobberRequestId: jobberRequestId || null,
  };

  const ghlLink = `https://app.gohighlevel.com/conversations/${conversationId}`;

  if (mode === 'auto') {
    console.log('\n📒 BOOKING — Jobber Request created automatically');
    console.log(`   Customer:  ${customerName}`);
    console.log(`   Package:   ${customerLabel} (internal: ${packageId})`);
    console.log(`   Sqft:      ${sqft || '?'}   Price: ${price ? '$' + price : '?'}`);
    console.log(`   Jobber ID: ${jobberRequestId}\n`);
  } else if (mode === 'notify') {
    // Coordinator workflow: this is what they paste into Jobber by hand.
    // Format it so it's easy to scan + copy fields out of.
    console.log('\n📋 BOOKING — coordinator action needed (notification mode)');
    console.log(`   Customer:  ${customerName}${phone ? `  ${phone}` : ''}`);
    if (email)   console.log(`   Email:     ${email}`);
    if (address) console.log(`   Address:   ${address}`);
    console.log(`   Package:   ${customerLabel} (internal: ${packageId})`);
    console.log(`   Sqft:      ${sqft || '?'}   Price: $${price || '?'}`);
    console.log(`   Channel:   ${channel || 'SMS'}`);
    console.log(`   GHL link:  ${ghlLink}`);
    console.log(`   → Create the matching Request in Jobber.\n`);
  } else if (mode === 'failed') {
    console.log('\n🚨 BOOKING FAILED — manual Jobber Request needed');
    console.log(`   Customer:  ${customerName}${phone ? `  ${phone}` : ''}`);
    console.log(`   Package:   ${customerLabel} (internal: ${packageId})`);
    console.log(`   Sqft:      ${sqft || '?'}   Price: $${price || '?'}`);
    console.log(`   Error:     ${error}`);
    console.log(`   GHL link:  ${ghlLink}\n`);
  } else {
    console.warn(`⚠️  notifyBookingResult called with unknown mode: ${mode}`);
  }

  // Persist to Postgres + in-memory cache
  persistEvent(event);

  // NOTE: SMS notification is intentionally NOT sent here. SMS now fires only
  // when the AI completes the conversation (handoff event below) so we can
  // include the customer's day/time preference + address in a single message.

  return event;
}

/**
 * Handoff event — AI is done with the conversation, humans take over.
 * Fires SMS notification to NOTIFY_CONTACT_IDS with the full picture:
 * customer, package, price, preferred day/time, address.
 *
 * Two trigger paths:
 *   • Customer gave a specific day/time → AI asked for address → customer
 *     sent address → this fires with both day/time + address
 *   • Customer didn't give a specific day/time → AI sent wrap-up → this
 *     fires with no day/time and no address
 */
export function notifyHandoff({
  contactId,
  conversationId,
  customerName,
  customerLabel,
  packageId,
  sqft,
  price,
  phone,
  email,
  address,
  preferredDayTime,
  channel,
}) {
  const event = {
    timestamp: new Date().toISOString(),
    type: 'handoff',
    contactId,
    conversationId,
    customerName,
    customerLabel,
    packageId,
    sqft,
    price,
    channel: channel || null,
    phone: phone || null,
    email: email || null,
    address: address || null,
    preferredDayTime: preferredDayTime || null,
  };

  const ghlLink = `https://app.gohighlevel.com/conversations/${conversationId}`;

  console.log('\n🤝 HANDOFF — AI finished, human takeover needed');
  console.log(`   Customer:  ${customerName}${phone ? `  ${phone}` : ''}`);
  console.log(`   Package:   ${customerLabel} (internal: ${packageId})`);
  console.log(`   Sqft:      ${sqft || '?'}   Price: $${price || '?'}`);
  if (preferredDayTime) console.log(`   Day/Time:  ${preferredDayTime}`);
  if (address)          console.log(`   Address:   ${address}`);
  console.log(`   Channel:   ${channel || 'SMS'}`);
  console.log(`   GHL link:  ${ghlLink}\n`);

  // Persist to Postgres + in-memory cache
  persistEvent(event);

  // SMS notification to human team — fire-and-forget
  const smsBody = [
    `🤝 SCT booking — your turn`,
    `Customer: ${customerName}${phone ? ` (${phone})` : ''}`,
    `Package: ${customerLabel} • $${price || '?'} • ${sqft || '?'} sqft`,
    preferredDayTime ? `Wants: ${preferredDayTime}` : `No day/time given — call to schedule`,
    address ? `Address: ${address}` : null,
    `GHL: ${ghlLink}`,
  ].filter(Boolean).join('\n');
  sendNotificationSMS(smsBody).catch((e) => console.warn('SMS notify failed:', e.message));

  return event;
}
