// stripe-ordering.js — the pure ordering rule for Stripe subscription events.
//
// Extracted from stripe-webhook.js so it can be unit-tested with no dependency
// on @netlify/blobs (the test suite is zero-dependency and reads source or
// requires pure modules only — see link-keys.js for the same pattern).
//
// WHY THIS EXISTS (18 Aug 2026 security review — H1)
// --------------------------------------------------
// Stripe does NOT guarantee event delivery order and retries failed deliveries
// for hours or days. setStatus() used to write subscriptionStatus
// unconditionally, so a redelivered *older* `invoice.paid` could land AFTER
// `customer.subscription.deleted` and flip a cancelled account back to "active".
// A cancelled subscription emits no further events, so nothing would ever
// correct it — the customer keeps Trey for free indefinitely. The mirror case:
// a late-retried `invoice.payment_failed` pausing a customer who has already
// recovered.
//
// The fix is a monotonic clock. Every lifecycle event carries `created` (unix
// seconds); we store the newest one applied on the client as `subscriptionEventAt`
// and refuse anything older.

// Decide whether an incoming event may overwrite the stored subscription state.
//   client        the stored client record (may be undefined)
//   status        the Trey status this event would write ("active" | "paused" | "cancelled")
//   eventCreated  stripeEvent.created, unix seconds (0/undefined if unknown)
// Returns true to apply, false to skip.
//   - Rejects any event strictly OLDER than the newest already applied.
//   - Refuses to reactivate a terminal "cancelled" from an event that merely
//     TIES on Stripe's second-granularity clock; a genuine re-subscribe arrives
//     as a strictly newer checkout.session.completed and is still allowed.
//   - A first-ever event (no stored subscriptionEventAt) always applies, so
//     existing records with no clock are never stuck.
function shouldApplyEvent(client, status, eventCreated) {
  const prevAt = Number(client && client.subscriptionEventAt) || 0;
  const evAt = Number(eventCreated) || 0;
  const before = (client && client.subscriptionStatus) || "";
  if (evAt && prevAt && evAt < prevAt) return false;
  if (status === "active" && before === "cancelled" && !(evAt > prevAt)) return false;
  return true;
}

module.exports = { shouldApplyEvent };
