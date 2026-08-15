// STRIPE WEBHOOK — keeps client.subscriptionStatus true without anyone typing it.
//
// Endpoint:  POST /.netlify/functions/stripe-webhook
// Env:       STRIPE_WEBHOOK_SECRET (whsec_…)  — REQUIRED, this fails closed without it
//            NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN (as everywhere else)
//
// WHY THIS EXISTS
// subscriptionStatus drives the tap gate (tap.js), the trial-ended page, the
// profile-work paywall, the report banners and the referral "owed" list. Until
// now it was set BY HAND in admin.html, which means it is wrong from the moment
// a card fails at 3am until somebody notices. This makes it self-maintaining.
//
// FAILS CLOSED, DELIBERATELY.
// The 15 Aug env audit found three guards written as
//     if (secret) { enforce } else { warn and carry on }
// …one of which left review-webhook publicly writable for weeks because the env
// var was never set. That shape is not repeated here: no STRIPE_WEBHOOK_SECRET
// means every request is refused. A webhook that silently accepts unsigned
// traffic is worse than one that is switched off, because this one can cancel a
// paying customer's subscription.
//
// STATUS VOCABULARY (must match tap.js isPaused/pauseReason — do not invent new ones)
//   "active"    → everything works
//   "paused"    → pauseReason "payment"   → "there's a problem with your payment details"
//   "cancelled" → pauseReason "cancelled" → "your subscription has been cancelled"
//   "trial"     → time-boxed by trialStartedAt + trialDays
//   ""          → grandfathered, treated as active. Never written here.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Stripe replays events on any non-2xx, and will happily deliver the same event
// twice on its own. Five minutes of clock skew is Stripe's own recommendation.
const TOLERANCE_SECONDS = 300;

/**
 * Verify the Stripe-Signature header against the RAW body.
 *
 * Deliberately hand-rolled rather than pulling in the `stripe` package: this repo
 * has three dependencies and none of them are 4MB. The scheme is small and stable —
 * header is "t=<unix>,v1=<hex>[,v1=<hex>]", signed payload is "<t>.<rawBody>",
 * HMAC-SHA256 with the whsec_ value.
 *
 * The body MUST be the untouched string. JSON.parse then re-stringify changes key
 * order and whitespace and the signature will never match — that is the classic
 * way to spend an afternoon on this.
 */
function verifySignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return { ok: false, reason: "missing input" };

  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || !signatures.length) return { ok: false, reason: "malformed header" };

  // Replay protection. Without this, a signature captured once stays valid forever.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!isFinite(age) || age > TOLERANCE_SECONDS) return { ok: false, reason: `timestamp outside tolerance (${age}s)` };

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  const expBuf = Buffer.from(expected, "utf8");
  for (const sig of signatures) {
    const sigBuf = Buffer.from(sig, "utf8");
    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) return { ok: true };
  }
  return { ok: false, reason: "no matching signature" };
}

// Stripe's subscription vocabulary -> Trey's. Anything unrecognised returns null
// so we leave the record alone rather than guessing a customer into a paused state.
function mapStatus(stripeStatus) {
  switch (stripeStatus) {
    case "active":
    case "trialing":            return "active";
    case "past_due":
    case "unpaid":
    case "paused":              return "paused";     // -> "payment" message
    case "canceled":
    case "incomplete_expired":  return "cancelled";  // -> "cancelled" message
    case "incomplete":          return null;         // first payment still in flight; not a failure yet
    default:                    return null;
  }
}

// Later events (subscription.updated, invoice.payment_failed) carry a Stripe
// customer id but no locationId, so checkout time is the ONLY chance to record
// the link between the two. That index is what makes every subsequent event
// resolvable.
async function locationForCustomer(customerId) {
  if (!customerId) return null;
  try {
    const rec = await blobsStore("stripecustomers").get(String(customerId), { type: "json" });
    return rec && rec.locationId ? rec.locationId : null;
  } catch (e) {
    console.error("[stripe-webhook] customer index read failed:", e.message);
    return null;
  }
}

async function setStatus(locationId, status, extra) {
  if (!locationId || !status) return false;
  const clients = blobsStore("clients");
  const client = await clients.get(locationId, { type: "json" });
  if (!client) {
    console.error(`[stripe-webhook] no client for locationId ${locationId}`);
    return false;
  }
  const before = client.subscriptionStatus || "";
  await clients.setJSON(locationId, {
    ...client,
    ...(extra || {}),
    subscriptionStatus: status,
    subscriptionUpdatedAt: new Date().toISOString(),
    subscriptionUpdatedBy: "stripe-webhook",
  });
  console.log(`[stripe-webhook] ${locationId}: ${before || "(none)"} -> ${status}`);
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // --- FAIL CLOSED -----------------------------------------------------------
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing all requests.");
    return { statusCode: 500, body: JSON.stringify({ error: "Webhook not configured" }) };
  }

  // Raw body, untouched. Netlify base64-encodes some request bodies.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  const h = event.headers || {};
  const sigHeader = h["stripe-signature"] || h["Stripe-Signature"] || "";
  const verdict = verifySignature(rawBody, sigHeader, secret);
  if (!verdict.ok) {
    // 400, not 500: Stripe should NOT retry an unsigned or forged request.
    console.error("[stripe-webhook] signature rejected:", verdict.reason);
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid signature" }) };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const type = stripeEvent.type || "";
  const id = stripeEvent.id || "";
  const obj = (stripeEvent.data && stripeEvent.data.object) || {};

  // --- Idempotency -----------------------------------------------------------
  // Stripe retries on timeouts and can deliver duplicates. Processing
  // "subscription.deleted" twice is harmless; doing it while a human is
  // mid-reactivation is not. Cheap to guard, so guard it.
  const seen = blobsStore("stripeevents");
  try {
    if (id && await seen.get(id, { type: "json" })) {
      return { statusCode: 200, body: JSON.stringify({ received: true, deduped: true }) };
    }
  } catch (e) { /* index unavailable — process anyway, better than dropping */ }

  try {
    switch (type) {
      // ---------------------------------------------------------------------
      // First payment. The ONLY event carrying client_reference_id, so this is
      // where the customer -> locationId index gets written.
      case "checkout.session.completed": {
        const locationId = obj.client_reference_id || "";
        const customerId = obj.customer || "";
        const subscriptionId = obj.subscription || "";

        if (!locationId) {
          // Expected, not exceptional: a founding-member link sent by hand won't
          // carry ?client_reference_id=. Park it for manual reconciliation rather
          // than dropping a real payment on the floor.
          console.warn(`[stripe-webhook] checkout ${id} has no client_reference_id — parked for reconciliation`);
          await blobsStore("stripeunmatched").setJSON(id, {
            at: new Date().toISOString(),
            customerId, subscriptionId,
            email: (obj.customer_details && obj.customer_details.email) || "",
            amountTotal: obj.amount_total, currency: obj.currency,
suggestion: "Match this to a client by email, then set subscriptionStatus manually in admin.",
          });
          break;
        }

        if (customerId) {
          await blobsStore("stripecustomers").setJSON(String(customerId), {
            locationId, at: new Date().toISOString(),
          });
        }
        await setStatus(locationId, "active", {
          stripeCustomerId: customerId || undefined,
          stripeSubscriptionId: subscriptionId || undefined,
          subscribedAt: new Date().toISOString(),
          // A paying client is no longer hardware-only. Left explicit because
          // admin.html checks hardwareOnly BEFORE subscriptionStatus when it
          // renders the status pill — a stale flag would keep showing "hardware".
          hardwareOnly: false,
        });
        break;
      }

      // ---------------------------------------------------------------------
      // Plan changes, cancellations scheduled, payment recovery, going past_due.
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const customerId = obj.customer || "";
        const locationId = await locationForCustomer(customerId);
        if (!locationId) {
          console.warn(`[stripe-webhook] ${type}: no locationId for customer ${customerId}`);
          break;
        }
        const status = type === "customer.subscription.deleted"
          ? "cancelled"
          : mapStatus(obj.status);
        if (!status) {
          console.log(`[stripe-webhook] ${type}: stripe status "${obj.status}" not mapped — leaving record alone`);
          break;
        }
        // Capture the wind-down state so the inbox can show its "only N days
        // left" countdown — and so that works even when the cancellation happened
        // OUTSIDE Trey (directly in Stripe, or by us on a customer's behalf).
        // billing.js writes these too, but the webhook is the source of truth.
        //
        // On "deleted" the wind-down is over, not in progress: force the flag off
        // so a stale true can never leave a countdown running on an account that
        // has already ended.
        const ended = type === "customer.subscription.deleted";
        await setStatus(locationId, status, {
          stripeSubscriptionId: obj.id || undefined,
          cancelAtPeriodEnd: ended ? false : obj.cancel_at_period_end === true,
          currentPeriodEnd: obj.current_period_end || undefined,
        });
        break;
      }

      // ---------------------------------------------------------------------
      // A renewal failed. Stripe will retry over the following days, and
      // subscription.updated -> active will bring them back automatically.
      case "invoice.payment_failed": {
        const customerId = obj.customer || "";
        const locationId = await locationForCustomer(customerId);
        if (!locationId) {
          console.warn(`[stripe-webhook] payment_failed: no locationId for customer ${customerId}`);
          break;
        }
        await setStatus(locationId, "paused", { lastPaymentFailedAt: new Date().toISOString() });
        break;
      }

      // ---------------------------------------------------------------------
      // Renewal succeeded — including the recovery after a failed one.
      case "invoice.paid": {
        const customerId = obj.customer || "";
        const locationId = await locationForCustomer(customerId);
        if (!locationId) break;
        await setStatus(locationId, "active", { lastPaymentAt: new Date().toISOString() });
        break;
      }

      default:
        // Everything else is acknowledged and ignored. Returning non-2xx would
        // make Stripe retry events we will never care about.
        console.log(`[stripe-webhook] ignoring ${type}`);
    }

    if (id) {
      try { await seen.setJSON(id, { at: new Date().toISOString(), type }); }
      catch (e) { console.error("[stripe-webhook] dedupe write failed:", e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    // 500 so Stripe retries — a dropped subscription event leaves a paying
    // customer switched off, or a cancelled one still being served.
    console.error("[stripe-webhook] handler error:", err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Handler error" }) };
  }
};

module.exports.verifySignature = verifySignature;
module.exports.mapStatus = mapStatus;
