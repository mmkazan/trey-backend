// The client-facing BILLING page — cancel or restart a subscription without
// logging in anywhere, including Stripe.
//
//   GET  /billing?loc=<locationId>&k=<key>          -> current plan + one button
//   POST /billing   (loc, k, action=cancel|resume)  -> apply it, confirm
//
// WHY THIS EXISTS
// terms.html promises "you can cancel at any time", and until now there was no
// way to do it: Payment Links create no self-serve portal, and the Stripe
// customer portal had never been configured. Cancelling meant emailing Matthew
// and waiting. A term the customer cannot actually exercise is a weak term, and
// a subscription people can't leave turns quiet churn into chargebacks.
//
// ONE CLEAR BUTTON, DELIBERATELY. Making cancellation harder than signing up is
// a dark pattern; the CMA takes a dim view of it and the US FTC has legislated
// against it. So there is no retention interstitial, no "are you sure" maze, no
// phone number to ring. The honest version is also the easy one to build.
//
// It cancels AT PERIOD END, matching what terms.html actually says: access
// continues to the end of the period already paid for. That also makes the
// action reversible, which is why Resume exists and why a single click is safe.
//
// Trey has no login by design, so the signed key IS the account — the same
// trust level that already lets this person edit their account details and
// approve public replies in their business's name.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const KEY_LEN = 32;
const INDIGO = "#4338ca";
const INDIGO2 = "#4f46e5";
const SLATE = "#0f172a";
const SUPPORT_EMAIL = "info@trey.today";
const STRIPE_TIMEOUT_MS = 8000;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}
const { linkKey, linkValid, secretConfigured } = require("./link-keys");

// This page's own purpose. Its key opens THIS page and nothing else — see
// link-keys.js for why. A key minted for another page will not validate here.
const LINK_PURPOSE = "billing";

// Kept as a thin wrapper so existing call sites read the same. All the real
// work (constant-time compare, fail-closed on an unset secret, byte-length
// check before timingSafeEqual) lives in link-keys.js.
function keyValid(locationId, provided) {
  return linkValid(LINK_PURPOSE, locationId, provided);
}
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(unixSeconds) {
  // 0 is "unknown", not the epoch. Without this guard periodEndOf() returning 0
  // renders as "1 January 1970" on the cancellation page and in the goodbye
  // email — a lie about the one fact those exist to convey.
  const n = Number(unixSeconds);
  if (!isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  if (isNaN(d)) return "";
  return `${d.getUTCDate()} ${["January","February","March","April","May","June","July","August","September","October","November","December"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Mirrors payLinkFor()'s plan logic. A comped account has no subscription to
// cancel and must never be shown billing controls.
// Keep in step with the copies in inbox/report/approve/profile-check/tap.js.
// This one had already drifted — it predated the "annual" plan and silently
// reported annual customers as standard.
const PLANS = ["standard", "founding", "annual", "free"];
function planOf(client) {
  const p = String((client && client.plan) || "").toLowerCase();
  if (PLANS.includes(p)) return p;
  if (client && client.foundingMember === true) return "founding";
  return "standard";
}

// Minimal Stripe REST call — same reasoning as stripe-webhook.js, which
// hand-rolls signature checking rather than pulling in a 4MB dependency.
async function stripe(path, method, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw Object.assign(new Error("STRIPE_SECRET_KEY not set"), { config: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STRIPE_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params ? new URLSearchParams(params) : undefined,
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `Stripe ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// When does the current paid period end? (unix seconds, 0 if unknown)
//
// WHY THIS IS NOT JUST sub.current_period_end — 15 Aug. Stripe's newer API
// (this account runs "flexible" billing mode) REMOVED current_period_end from
// the top-level Subscription object and moved it onto each subscription ITEM.
// Reading the old field returned undefined, so Naomi's cancellation went through
// correctly but stored no end date — which silently killed the "only N days
// left" banner and left a blank date on the confirmation page.
//
// Checks the item first (current API), then the legacy top-level field, then
// cancel_at, which Stripe sets to the effective end when cancel_at_period_end
// is turned on.
function periodEndOf(sub) {
  if (!sub) return 0;
  const item = sub.items && sub.items.data && sub.items.data[0];
  const v = (item && item.current_period_end) || sub.current_period_end || sub.cancel_at || 0;
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

// --- "Sorry to see you go" ----------------------------------------------------
// Sent once, when they cancel. Three jobs, in order of value to the business:
//   1. Confirm in writing exactly when access ends. Silence after cancelling is
//      how a customer ends up unsure whether it worked and rings the bank.
//   2. Give them one tap back. They still have a live subscription set to end,
//      so Resume costs them nothing and re-enters no card details.
//   3. Ask why. At twenty customers, one honest sentence about why someone left
//      is worth more than any dashboard.
//
// Never throws and never blocks the cancellation — the cancellation has already
// happened in Stripe by the time this runs.
const EMAIL_TIMEOUT_MS = 5000;

async function sendGoodbyeEmail(client, locationId, untilLabel) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn("[billing] RESEND_API_KEY not set — no cancellation email."); return; }
  if (!client || !client.email) return;

  const first = ((client.contactFirstName) || "").trim();
  const hello = first ? `Hi ${first}` : "Hello";
  const biz = client.businessName || "your business";
  const k = linkKey("billing", locationId);
  const base = process.env.URL || "https://trey.today";
  const backUrl = `${base}/.netlify/functions/billing?loc=${encodeURIComponent(locationId)}&k=${k}`;

  const text =
`${hello},

Your Trey subscription for ${biz} has been cancelled — you won't be charged again.

Trey keeps working until ${untilLabel}. Your stand carries on collecting reviews
until then, and your replies keep coming through as normal.

Changed your mind? One tap and you're back, with nothing to re-enter:
${backUrl}

And if you have a moment — what made you cancel? Just hit reply. We're small
enough that one honest sentence genuinely changes what we build next.

Thanks for giving us a go.

Matthew
Trey`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:520px">
<p>${escapeHtml(hello)},</p>
<p>Your Trey subscription for <b>${escapeHtml(biz)}</b> has been cancelled &mdash; you won't be charged again.</p>
<p style="background:#f3f8ff;border-left:3px solid #4338ca;padding:12px 14px;border-radius:0 8px 8px 0">
Trey keeps working until <b>${escapeHtml(untilLabel)}</b>. Your stand carries on collecting reviews until then, and your replies keep coming through as normal.</p>
<p><a href="${backUrl}" style="display:inline-block;background:#4338ca;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:700">Changed your mind? Turn it back on</a><br>
<span style="color:#64748b;font-size:13.5px">One tap &mdash; nothing to re-enter.</span></p>
<p>And if you have a moment &mdash; <b>what made you cancel?</b> Just hit reply. We're small enough that one honest sentence genuinely changes what we build next.</p>
<p>Thanks for giving us a go.</p>
<p style="color:#475569">Matthew<br><span style="color:#94a3b8;font-size:13px">Trey</span></p>
</div>`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMAIL_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Trey <hello@trey.today>",
        to: [client.email],
        reply_to: process.env.RESEND_REPLY_TO || "info@trey.today",
        subject: `Sorry to see you go, ${first || biz}`,
        text, html,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) console.error(`[billing] goodbye email ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  } catch (e) {
    console.error("[billing] goodbye email failed:", e && e.message);
  } finally {
    clearTimeout(timer);
  }
}

function shell(title, inner, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#e4eefc;color:${SLATE}}
  .top{background:linear-gradient(165deg,${INDIGO2},${INDIGO});color:#fff;padding:22px 20px 26px}
  .top .wrap,.main{max-width:560px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:-.3px}
  .brand svg{height:30px;width:30px;display:block;color:#eef2ff}
  h1{font-size:21px;margin:14px 0 2px;letter-spacing:-.4px}
  .sub{font-size:13.5px;opacity:.9}
  .main{padding:18px 16px calc(60px + env(safe-area-inset-bottom,0px))}
  .card{background:#f3f8ff;border:1px solid #cfe0f6;border-radius:14px;padding:16px 15px;margin-bottom:14px}
  .row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 0;border-bottom:1px solid #e3ecfa}
  .row:last-child{border-bottom:0}
  .row .lbl{font-size:13px;color:#64748b;font-weight:600}
  .row .val{font-size:14.5px;font-weight:700}
  .note{font-size:13px;color:#475569;line-height:1.55;margin:0 0 14px}
  .danger{width:100%;background:#fff;color:#b91c1c;border:1px solid #fecaca;border-radius:11px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
  .danger:active{background:#fef2f2}
  .primary{width:100%;background:${INDIGO};color:#fff;border:0;border-radius:11px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}
  .ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:12px;padding:14px 15px;font-size:14px;font-weight:600;margin-bottom:14px}
  .warn{background:#fffbeb;border:1px solid #fde68a;color:#b45309;border-radius:12px;padding:14px 15px;font-size:13.5px;line-height:1.55;margin-bottom:14px}
  .xlink{display:block;text-align:center;margin-top:20px;color:${INDIGO2};font-weight:700;text-decoration:none;font-size:14px}
  .foot{text-align:center;color:#8091ad;font-size:12px;margin-top:24px}
  a{color:${INDIGO2}}
</style></head><body>
  <div class="top"><div class="wrap"><div class="brand">
    <svg viewBox="0 0 100 100" aria-hidden="true"><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.30"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.58"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="currentColor"/><rect x="46" y="39" width="8" height="25" rx="2" fill="currentColor"/></svg>
    trey</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="sub">Your subscription</div>
  </div></div>
  <div class="main">${inner}<div class="foot">Powered by Trey</div></div>
</body></html>`,
  };
}

function notice(title, message, code = 200) {
  return shell(title, `<div class="card"><p class="note" style="margin:0">${message}</p></div>`, code);
}

// "Talk to a human" — used whenever we genuinely cannot self-serve. Never
// pretend a cancellation happened when it didn't.
function manualFallback(title, why) {
  return shell(title, `<div class="warn">${why}</div>
    <div class="card"><p class="note" style="margin:0">Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll sort it out by return. Your subscription is unchanged in the meantime.</p></div>`);
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  let loc = params.loc, k = params.k, action = "";

  if (event.httpMethod === "POST") {
    const body = new URLSearchParams(event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || ""));
    loc = body.get("loc") || loc;
    k = body.get("k") || k;
    action = body.get("action") || "";
  }

  if (!loc) return notice("Billing unavailable", "This link is missing a location.", 400);
  if (!process.env.TREY_REPORT_SECRET) return notice("Billing unavailable", "This isn't set up yet. Please try again later.", 500);
  if (!keyValid(loc, k)) return notice("Billing unavailable", "This link isn't valid or has expired. Please use the most recent link from Trey.", 403);

  const clientsStore = blobsStore("clients");
  const client = await clientsStore.get(loc, { type: "json" });
  if (!client) return notice("Account not found", "We couldn't find this account.", 404);

  const back = `<a class="xlink" href="/.netlify/functions/inbox?loc=${encodeURIComponent(loc)}&k=${encodeURIComponent(k)}">&larr; Back to your reviews</a>`;
  const businessName = client.businessName || "your business";

  // A comped account has no subscription and must never see a cancel button.
  if (planOf(client) === "free") {
    return shell(businessName, `<div class="card">
      <p class="note" style="margin:0"><b>You're on a free account.</b> There's no subscription and nothing to pay, so there's nothing to cancel here.</p>
    </div>${back}`);
  }

  const subId = client.stripeSubscriptionId || "";
  if (!subId) {
    return shell(businessName, `<div class="card">
      <p class="note" style="margin:0">You don't have an active subscription yet &mdash; there's nothing to cancel. If you think that's wrong, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
    </div>${back}`);
  }

  // --- Apply a change ---------------------------------------------------------
  // POST only: a link-preview fetch or a scanner is always a GET and must never
  // be able to cancel somebody's subscription.
  if (event.httpMethod === "POST" && (action === "cancel" || action === "resume")) {
    let sub;
    try {
      sub = await stripe(`subscriptions/${encodeURIComponent(subId)}`, "POST", {
        cancel_at_period_end: action === "cancel" ? "true" : "false",
      });
    } catch (err) {
      console.error(`[billing] ${action} failed for ${loc}:`, err && err.message);
      return manualFallback(businessName, err && err.config
        ? "Online cancellation isn't switched on yet."
        : "We couldn't reach our payment provider just then, so nothing has changed.");
    }

    // Record it for display. The webhook stays the source of truth for
    // subscriptionStatus — it flips to "cancelled" only when the period actually
    // ends, which is what the terms promise.
    //
    // Re-read before writing: the Stripe call above can take up to 8s, and a
    // renewal `invoice.paid`/`payment_failed` webhook can write this client's
    // subscriptionStatus in that window. We own only the three billing-display
    // fields; spreading the stale `client` would revert the webhook's status.
    // (2026-08-18 security review, H2.)
    try {
      const fresh = (await clientsStore.get(loc, { type: "json" })) || client;
      await clientsStore.setJSON(loc, {
        ...fresh,
        cancelAtPeriodEnd: action === "cancel",
        currentPeriodEnd: periodEndOf(sub) || fresh.currentPeriodEnd || "",
        cancelRequestedAt: action === "cancel" ? new Date().toISOString() : "",
      });
    } catch (e) {
      console.error("[billing] record update failed:", e.message);
    }

    const until = fmtDate(periodEndOf(sub));
    if (action === "cancel") {
      // After the Stripe change and the record write — never email somebody that
      // they've cancelled unless it actually went through.
      try { await sendGoodbyeEmail(client, loc, until); }
      catch (e) { console.error("[billing] goodbye email threw:", e && e.message); }
      return shell(businessName, `<div class="ok">Your subscription has been cancelled.</div>
        <div class="card">
          <p class="note">You won't be charged again. Trey keeps working until <b>${escapeHtml(until)}</b> &mdash; the end of the period you've already paid for &mdash; and your stand stops after that.</p>
          <p class="note" style="margin-bottom:0">Changed your mind? You can turn it back on any time before then.</p>
        </div>
        <form method="POST"><input type="hidden" name="loc" value="${escapeHtml(loc)}"><input type="hidden" name="k" value="${escapeHtml(k)}"><input type="hidden" name="action" value="resume">
          <button class="primary" type="submit">Keep my subscription</button>
        </form>${back}`);
    }
    return shell(businessName, `<div class="ok">You're all set &mdash; your subscription continues.</div>
      <div class="card"><p class="note" style="margin:0">Your next payment will go ahead as normal on <b>${escapeHtml(until)}</b>.</p></div>${back}`);
  }

  // --- Show current state -----------------------------------------------------
  let sub;
  try {
    sub = await stripe(`subscriptions/${encodeURIComponent(subId)}`, "GET");
  } catch (err) {
    console.error(`[billing] lookup failed for ${loc}:`, err && err.message);
    return manualFallback(businessName, err && err.config
      ? "Online cancellation isn't switched on yet."
      : "We couldn't load your subscription just then.");
  }

  // SELF-HEAL. Stripe is the truth; the record is a cache that drives the inbox
  // countdown and the admin "Cancellation pending" pill. They drift whenever a
  // cancellation happens somewhere this code didn't see — directly in the Stripe
  // dashboard, or before a bug was fixed. (Naomi's did exactly that: her
  // cancellation was correct in Stripe but stored no end date here, so the
  // banner had nothing to count down from.)
  //
  // So every view reconciles them. Writes only on an actual difference, so a
  // page refresh isn't a pointless blob write.
  const liveCancelling = sub.cancel_at_period_end === true;
  const livePeriodEnd = periodEndOf(sub);
  // Only trust a period end we actually resolved. If Stripe returns a shape we
  // can't read, livePeriodEnd is 0 — writing that would erase a good stored date
  // and silently kill the inbox countdown, which is the exact regression
  // periodEndOf() was written to fix.
  const storedEnd = Number(client.currentPeriodEnd || 0);
  const nextEnd = livePeriodEnd || storedEnd;
  if (client.cancelAtPeriodEnd !== liveCancelling || storedEnd !== nextEnd) {
    try {
      // Re-read before writing — same reason as the POST path: the Stripe fetch
      // this reconcile is based on can overlap a webhook status write, and we own
      // only cancelAtPeriodEnd/currentPeriodEnd here. (2026-08-18 review, H2.)
      const fresh = (await clientsStore.get(loc, { type: "json" })) || client;
      await clientsStore.setJSON(loc, {
        ...fresh,
        cancelAtPeriodEnd: liveCancelling,
        currentPeriodEnd: nextEnd || "",
      });
      console.log(`[billing] reconciled ${loc} from Stripe: cancelling=${liveCancelling} periodEnd=${livePeriodEnd}`);
    } catch (e) {
      console.error("[billing] reconcile write failed:", e.message);
    }
  }

  const amount = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price
    ? sub.items.data[0].price : null;
  const price = amount && amount.unit_amount != null
    ? `£${(amount.unit_amount / 100).toFixed(2)}${amount.recurring ? " / " + amount.recurring.interval : ""}`
    : "—";
  const renews = fmtDate(periodEndOf(sub));
  const ending = sub.cancel_at_period_end === true;

  const detail = `<div class="card">
      <div class="row"><span class="lbl">Plan</span><span class="val">${escapeHtml(price)}</span></div>
      <div class="row"><span class="lbl">${ending ? "Access until" : "Next payment"}</span><span class="val">${escapeHtml(renews)}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val">${ending ? "Cancelling" : "Active"}</span></div>
    </div>`;

  if (ending) {
    return shell(businessName, `${detail}
      <div class="warn">Your subscription is set to end on <b>${escapeHtml(renews)}</b>. You won't be charged again, and Trey keeps working until then.</div>
      <form method="POST"><input type="hidden" name="loc" value="${escapeHtml(loc)}"><input type="hidden" name="k" value="${escapeHtml(k)}"><input type="hidden" name="action" value="resume">
        <button class="primary" type="submit">Keep my subscription</button>
      </form>${back}`);
  }

  return shell(businessName, `${detail}
    <p class="note">Cancel whenever you like &mdash; no notice period, no phone call. Trey carries on to the end of the month you've already paid for, then stops. You can restart any time.</p>
    <form method="POST"><input type="hidden" name="loc" value="${escapeHtml(loc)}"><input type="hidden" name="k" value="${escapeHtml(k)}"><input type="hidden" name="action" value="cancel">
      <button class="danger" type="submit">Cancel my subscription</button>
    </form>${back}`);
};
