const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

// --- Which plan is this client on? -------------------------------------------
//   "standard" -> £35/mo (the default for everyone else)
//   "founding" -> £25/mo for life (the first 20; index.html advertises it)
//   "annual"   -> £350/yr (two months free)
//   "free"     -> complimentary. Family, friends and test accounts. Never
//                 billed, never nagged to subscribe, never paused.
//
// Centralised because these decisions appear on FIVE separate pages — the inbox,
// the monthly report, the approve page, the profile-check paywall and the paused
// stand. A founding member quoted £25 in one place and £35 in another doesn't
// read that as a bug, they read it as a bait-and-switch; and a comped friend
// being asked to pay is worse.
const PLANS = ["standard", "founding", "annual", "free"];
function planOf(client) {
  const p = String((client && client.plan) || "").toLowerCase();
  if (PLANS.includes(p)) return p;
  // Back-compat with the short-lived boolean this replaced.
  if (client && client.foundingMember === true) return "founding";
  return "standard";
}

// A comped account. Treated as permanently subscribed: no payment link, no
// upgrade banner, no paywall, and the stand never pauses.
function isComped(client) {
  return planOf(client) === "free";
}

// An unrecognised plan falls back to STANDARD, never to free — a typo must not
// silently give the product away. A missing env var falls back to the standard
// link rather than rendering an unpayable page, but says so loudly: quietly
// charging someone £35 for a plan you promised at £25 is the kind of failure
// nobody spots until they complain.
function payLinkFor(client) {
  const plan = planOf(client);
  if (plan === "free") return "";   // nothing to sell them
  const standard = process.env.STRIPE_PAYMENT_LINK || "";
  if (plan === "founding" || plan === "annual") {
    const envName = plan === "founding" ? "STRIPE_FOUNDING_PAYMENT_LINK" : "STRIPE_ANNUAL_PAYMENT_LINK";
    const link = process.env[envName];
    if (link) return link;
    console.warn(`[pricing] ${envName} is not set — a "${plan}" client is being shown the STANDARD price. Set it in Netlify and redeploy.`);
    return standard;
  }
  return standard;
}


// Normalise a stored phone number to E.164 for Twilio.
//
// WHY — 15 Aug, Raven Holistics' first real review alert died on Twilio 21211,
// "The 'To' number whatsapp:+44 7933189216 is not a valid phone number." The
// self-serve signup form formats numbers for READING ("+44 7933189216"), and
// that single space is enough for Twilio to reject the send. Every outbound
// WhatsApp to a self-serve signup was affected; it only surfaced now because
// Naomi is the first. Admin-created clients had numbers typed without a space.
//
// Normalising at SEND time as well as on write means records already saved with
// a space are fixed too, with no data migration.
function toE164(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const d = raw.replace(/[^\d]/g, "");
  if (!d) return "";
  if (raw.startsWith("+")) return "+" + d;   // already international — trust it
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith("0")) return "+44" + d.slice(1);  // UK national
  if (d.startsWith("44")) return "+" + d;
  return "+" + d;
}


// NFC/QR "Tappy Stand" landing endpoint.
//
//  - Logs the tap so review-webhook.js can attribute a review to it.
//  - Counts taps per month for reporting ("6 taps -> 4 completed reviews").
//  - Enforces the free-trial pause promised in the Terms (14 days, or 30 if
//    the business arrived through a referral link): once a
//    client's trial has ended and they haven't subscribed, the stand shows an
//    "unavailable" page (with a billing link) instead of the Google review page.
//  - Active clients are redirected straight to Google to leave a review.
//
// Clients with no subscriptionStatus are treated as active ("grandfathered"),
// so stands that were live before this feature shipped never pause by surprise.

// How long is this client's free trial? Normally 14 days; a business that came
// in through a referral link gets 30 (set by signup.js). Anything odd falls back
// to 14 so a bad value can never hand out an unlimited trial.
function trialDaysFor(client) {
  const n = Number(client && client.trialDays);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 14;
}

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Monday (UTC) of the given date's week, as YYYY-MM-DD — used as the weekly key.
function weekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun .. 6=Sat
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

// A quick branded "thank you" screen shown for ~1.6s before we send the
// customer on to Google. Uses the client's saved logoUrl when present.
function thankYouPage(client, target) {
  const name = escapeHtml((client && client.businessName) || displayName(client) || "");
  const logoUrl = client && client.logoUrl ? escapeHtml(client.logoUrl) : "";
  const safeTarget = escapeHtml(target);
  const greeting = name ? `Thanks for visiting ${name}!` : "Thanks for visiting!";
  const logoImg = logoUrl
    ? `<img src="${logoUrl}" alt="${name}" style="max-height:88px;max-width:220px;margin:0 auto 22px;display:block;object-fit:contain;">`
    : "";
  const body = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2;url=${safeTarget}">
<title>Thank you</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{max-width:420px;width:100%;text-align:center}
  h1{font-size:24px;margin:0 0 10px;letter-spacing:-0.4px}
  p{font-size:16px;color:#475569;margin:0 0 24px;line-height:1.55}
  .spinner{width:32px;height:32px;border:4px solid #d1fae5;border-top-color:#059669;border-radius:50%;margin:0 auto 20px;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  a.go{color:#059669;font-size:14px;text-decoration:none}
  .foot{margin-top:32px;font-size:12px;color:#94a3b8}
</style></head>
<body>
  <div class="card">
    ${logoImg}
    <h1>${greeting}</h1>
    <p>Taking you to Google to leave a quick review &mdash; it only takes a moment and really helps other customers find us.</p>
    <div class="spinner"></div>
    <a class="go" id="go" href="${safeTarget}">Not redirected? Tap here</a>
    <div class="foot">Powered by Trey</div>
  </div>
  <script>setTimeout(function(){var g=document.getElementById('go');if(g){window.location.replace(g.href);}},1600);</script>
</body></html>`;
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body,
  };
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- "You're live" alerts, sent once, on activation ---------------------------
// Added 15 Aug. Activation was silent: the owner pressed the button, saw a page,
// and that was the end of it. That is the single best moment to tell them the
// one thing that actually determines whether Trey works for them — that they
// have to ASK. A stand nobody is pointed at gets tapped by almost nobody.
//
// Sent on BOTH channels deliberately. WhatsApp is immediate but only guaranteed
// to deliver inside Meta's 24-hour session window (see below); email always
// arrives but may sit unread. Neither is reliable alone.
//
// NOTHING here can break activation: the trial is already stamped before any of
// this runs, every call is time-boxed, and every failure is logged and swallowed.
const ALERT_TIMEOUT_MS = 3000;
const KEY_LEN = 32;

// Same derivation as inbox.js / signup.js / approve.js. Trey has no login, so
// this signed URL *is* the account.
function reportKey(locationId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update(String(locationId)).digest("hex").slice(0, KEY_LEN);
}
function inboxUrl(locationId) {
  const base = process.env.URL || "https://trey.today";
  return `${base}/.netlify/functions/inbox?loc=${encodeURIComponent(locationId)}&k=${reportKey(locationId)}`;
}

// A small fetch with a hard timeout, so a hanging Twilio or Resend can't leave
// the owner staring at a spinner at the exact moment they're meant to be delighted.
async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ALERT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function activationCopy(client, locationId) {
  const first = ((client && client.contactFirstName) || "").trim();
  const biz = (client && client.businessName) || "your business";
  const hw = client && client.hardware === "keyfob" ? "key fob" : "stand";
  const days = trialDaysFor(client);
  return { first, biz, hw, days, inbox: inboxUrl(locationId) };
}

/**
 * WhatsApp "you're live".
 *
 * THE 24-HOUR WINDOW. Meta only allows free-form messages within 24 hours of the
 * business last messaging us. Activation usually happens days after signup, so a
 * free-form send will often come back as Twilio 63016 and never arrive. An
 * approved template has no such limit.
 *
 * So: use the template when TWILIO_ACTIVATED_CONTENT_SID is set, otherwise fall
 * back to free-form, which still works for anyone who happens to be inside the
 * window. Until that template exists the email is the channel that always lands,
 * which is exactly why both are sent.
 */
async function whatsAppActivated(client, locationId) {
  const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !auth) return "whatsapp: twilio not configured";
  if (!client || !client.phone) return "whatsapp: no phone";
  if (client.nudgesOptOut === true) return "whatsapp: opted out";

  const { first, biz, hw, days, inbox } = activationCopy(client, locationId);
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const params = messagingServiceSid
    ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
    : { To: `whatsapp:${toE164(client.phone)}`, From: process.env.TWILIO_WHATSAPP_FROM };

  const contentSid = process.env.TWILIO_ACTIVATED_CONTENT_SID;
  if (contentSid) {
    params.ContentSid = contentSid;
    params.ContentVariables = JSON.stringify({
      1: String(first || biz).slice(0, 60),
      2: String(days),
      3: inbox.slice(0, 300),
    });
  } else {
    params.Body =
      `You're live${first ? ", " + first : ""} \u{1F389}\n\n` +
      `${biz}'s Trey ${hw} is switched on. Every tap now takes a customer straight to your Google review page.\n\n` +
      `One thing matters more than anything else: ASK. "If you've got a second, tap this and leave us a review" — ` +
      `said out loud, at the counter, is the difference between a stand that works and one that gathers dust.\n\n` +
      `Your Trey inbox, no password needed:\n${inbox}\n\n` +
      `Your ${days}-day free trial starts today. Reply STOP any time.`;
  }

  const resp = await fetchWithTimeout(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return contentSid ? "whatsapp: sent (template)" : "whatsapp: sent (free-form)";
}

/** Email "you're live" — the channel that lands whatever Meta's window says. */
async function emailActivated(client, locationId) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return "email: RESEND_API_KEY not set";
  if (!client || !client.email) return "email: no address";

  const { first, biz, hw, days, inbox } = activationCopy(client, locationId);
  const hello = first ? `Hi ${first}` : "Hello";

  const text =
`${hello},

Your Trey ${hw} is live. ${biz} is switched on, and from now on every tap sends
that customer straight to your Google review page.

The one thing that decides whether this works: ASK.

"If you've got a second, tap this and leave us a review" — said out loud, at the
counter, as they're leaving happy. A stand nobody is pointed at gets tapped by
almost nobody. The businesses that do best are simply the ones that mention it.

A few things worth knowing:
- Your ${days}-day free trial starts today.
- When a review comes in, we'll draft a reply and WhatsApp it to you. Read it,
  tap approve, done.
- Your Trey inbox lives here, no password:
  ${inbox}

Any questions, just reply to this email.

Matthew
Trey — more Google reviews, without the chasing`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:520px">
<p>${escapeHtml(hello)},</p>
<p><b>Your Trey ${escapeHtml(hw)} is live.</b> ${escapeHtml(biz)} is switched on, and from now on every tap sends that customer straight to your Google review page.</p>
<p style="background:#eef2ff;border-left:3px solid #4338ca;padding:12px 14px;border-radius:0 8px 8px 0;margin:18px 0">
<b>The one thing that decides whether this works: ask.</b><br>
<span style="color:#334155">&ldquo;If you&rsquo;ve got a second, tap this and leave us a review&rdquo; &mdash; said out loud, at the counter, as they&rsquo;re leaving happy. A stand nobody is pointed at gets tapped by almost nobody. The businesses that do best are simply the ones that mention it.</span></p>
<ul style="padding-left:20px;color:#334155">
  <li>Your <b>${days}-day free trial starts today</b>.</li>
  <li>When a review comes in, we&rsquo;ll draft a reply and WhatsApp it to you. Read it, tap approve, done.</li>
</ul>
<p><a href="${inbox}" style="display:inline-block;background:#4338ca;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:700">Open your Trey inbox</a><br>
<span style="color:#64748b;font-size:13.5px">No password &mdash; worth bookmarking.</span></p>
<p>Any questions, just reply to this email.</p>
<p style="color:#475569">Matthew<br><span style="color:#94a3b8;font-size:13px">Trey &mdash; more Google reviews, without the chasing</span></p>
</div>`;

  const resp = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "Trey <hello@trey.today>",
      to: [client.email],
      reply_to: process.env.RESEND_REPLY_TO || "info@trey.today",
      subject: `You're live — ${biz} is switched on`,
      text, html,
    }),
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return "email: sent";
}

/**
 * Fire both alerts. Runs them in PARALLEL so the owner waits for the slower of
 * the two rather than the sum, and never rejects — activation has already
 * happened by the time this is called and must not be undone by a message.
 */
async function sendActivationAlerts(client, locationId) {
  const results = await Promise.allSettled([
    whatsAppActivated(client, locationId),
    emailActivated(client, locationId),
  ]);
  for (const r of results) {
    if (r.status === "fulfilled") console.log(`[tap] activation alert — ${r.value}`);
    else console.error(`[tap] activation alert failed: ${r.reason && r.reason.message}`);
  }
}

// Recover the locationId from a short-link path: /t/<locationId>.
//
// WHY THIS EXISTS — found 15 Aug, against production. The rewrite in _redirects
//     /t/*   /.netlify/functions/tap?locationId=:splat   200
// fires correctly (this function does run), but Netlify does NOT substitute
// :splat into the destination's QUERY STRING. Verified live: /t/<anything>
// returned the "no locationId" 400, while the long URL carrying the same id
// returned normally. /q/<id> failed the same way.
//
// admin.html's makeTapUrl() emits the short form, and tap-qr.js encodes the
// short form into the QR — so EVERY NFC tag written and EVERY QR downloaded
// from the admin panel pointed at a dead link, and the error page said only
// "this tap link isn't set up correctly", which reads like the client record is
// wrong rather than the URL.
//
// Netlify hands the function the ORIGINAL request path, so we read the id from
// there and stop depending on the rewrite's query handling at all. The
// _redirects rule is fixed too, but this is the belt: it keeps every tag that
// has already been programmed working, whatever Netlify does with :splat.
function locationFromPath(event) {
  const raw = (event && (event.path || event.rawUrl)) || "";
  let pathname = String(raw);
  if (/^https?:\/\//i.test(pathname)) {
    try { pathname = new URL(pathname).pathname; } catch (e) { /* keep raw */ }
  }
  const m = pathname.match(/^\/t\/([^/?#]+)/);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

// Returns the normalised href if this is a safe Google review destination,
// otherwise null. Split out so the tag's own parameter and the link stored on
// the client record cannot drift apart in what they accept.
function allowedGoogleUrl(candidate) {
  if (!candidate) return null;
  try {
    const u = new URL(String(candidate).trim());
    const host = u.hostname.toLowerCase();
    // Google review/maps hosts only. Note: goo.gl (a link shortener) is
    // deliberately excluded, and Google's own /url?q= open-redirector is
    // rejected below — both could otherwise bounce a visitor to any site.
    const okHost =
      host === "google.com" || host.endsWith(".google.com") ||
      host === "g.page" || host.endsWith(".g.page");
    const isRedirector = u.pathname === "/url"; // e.g. https://www.google.com/url?q=https://evil.com
    if (u.protocol === "https:" && okHost && !isRedirector) return u.href;
  } catch (e) { /* not a valid absolute URL — fall through */ }
  return null;
}

// Resolve where to send the customer.
//
// Preference order: the tag's own `googleUrl`, then the review link the business
// gave us at signup, then a URL built from their saved placeId, then the
// locationId. Every candidate URL goes through allowedGoogleUrl() — this stops
// an attacker turning a stand link into an open redirect to a phishing site or
// a javascript: link.
//
// The googleReviewUrl step was missing until 15 Aug: the signup form asked for a
// review link, stored it, and then NOTHING read it. A business could hand us the
// exact right URL and their stand would still redirect to a writereview page
// built from a locationId that isn't a Place ID — a dead review page, with the
// working link sitting unused on the same record. It is validated by the same
// allow-list as the tag parameter, so it is no more dangerous here than there.
//
// Netlify already URL-decodes query params once, so we must NOT
// decodeURIComponent again (double-decode corrupts valid targets and throws on
// a literal %).
function safeReviewTarget(googleUrl, client, locationId) {
  for (const candidate of [googleUrl, client && client.googleReviewUrl]) {
    const href = allowedGoogleUrl(candidate);
    if (href) return href;
  }
  const fallbackId = (client && client.placeId) || locationId;
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(fallbackId)}`;
}

// When did the trial actually start (ms since epoch), or null if it hasn't yet.
// New model: the trial starts when the business OWNER activates the stand (the
// button on the activation page below), stamped as trialStartedAt. Clients
// flagged trialStartsOnTap follow this model; older clients without the flag fall
// back to createdAt so stands live before this feature keep their clock.
function trialStartMs(client) {
  if (!client) return null;
  if (client.trialStartedAt) {
    const t = new Date(client.trialStartedAt).getTime();
    if (!isNaN(t)) return t;
  }
  if (client.trialStartsOnTap) return null; // new model — not started until activated
  if (client.createdAt) {
    const t = new Date(client.createdAt).getTime();
    if (!isNaN(t)) return t;
  }
  return null;
}

// The small indigo Trey mark, inline so these pages stay self-contained.
function treyMarkSvg(size) {
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#4338ca"/><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.32"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.6"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="#fff"/><rect x="46" y="39" width="8" height="25" rx="2" fill="#fff"/></svg>`;
}

// Shown when a "ready to send" stand is tapped before the owner has activated it
// (in the customer's hands, or in transit). Reassures a delivery driver, shows
// who the package is for, and lets the OWNER start their trial. The button POSTs
// (never a GET link) so a scanner/bot pre-fetch cannot trigger activation.
function activationPage(client, locationId) {
  const name = escapeHtml((client && client.businessName) || "your business");
  const logoUrl = client && client.logoUrl ? escapeHtml(client.logoUrl) : "";
  const logoChip = logoUrl ? `<div class="lchip"><img src="${logoUrl}" alt="${name}"></div>` : "";
  const action = `/.netlify/functions/tap?locationId=${encodeURIComponent(locationId)}&activate=1`;
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Activate your Trey stand</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#eef3fc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:22px}
 /* Keep the last control clear of the phone's gesture/nav bar. Without this the
    bottom button sits directly above the system back button. */
 .wrap{max-width:400px;width:100%;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))}
 .driver{background:#fff;border:1px solid #dbe4f3;border-radius:12px;padding:13px 15px;font-size:13px;color:#475569;line-height:1.5;margin-bottom:16px}
 .driver b{color:#0f172a}
 .recipient{text-align:center;margin:6px 0 22px}
 .lchip{display:inline-block;background:#fff;border:1px solid #dbe4f3;border-radius:14px;padding:14px 20px;box-shadow:0 6px 18px rgba(15,23,42,.06)}
 .lchip img{max-height:64px;max-width:210px;display:block;object-fit:contain}
 .bizname{font-size:20px;font-weight:800;letter-spacing:-.4px;margin-top:12px}
 .card{background:#fff;border:1px solid #cfe0f6;border-radius:18px;padding:22px 20px;text-align:center;box-shadow:0 14px 40px rgba(79,70,229,.12)}
 .card h1{font-size:19px;margin:0 0 8px;letter-spacing:-.3px}
 .card p{font-size:14.5px;color:#475569;line-height:1.55;margin:0 0 18px}
 .btn{display:block;width:100%;background:linear-gradient(180deg,#4f46e5,#4338ca);color:#fff;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 8px 18px rgba(67,56,202,.28)}
 .fine{font-size:12px;color:#94a3b8;margin-top:12px}
 /* The SAFE action deliberately sits lowest — see the note in the markup. */
 .btn-safe{display:block;width:100%;background:#fff;color:#475569;border:1px solid #cbd5e1;border-radius:12px;padding:14px;font-size:15px;font-weight:600;cursor:pointer;margin-top:14px}
 .btn-safe:active{background:#f1f5f9}
 .foot{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:22px;color:#64748b;font-size:12px;font-weight:600}
 .done{background:#fff;border:1px solid #cfe0f6;border-radius:18px;padding:30px 22px;text-align:center;box-shadow:0 14px 40px rgba(79,70,229,.12)}
 .done h1{font-size:19px;margin:12px 0 8px;letter-spacing:-.3px}
 .done p{font-size:14.5px;color:#475569;line-height:1.55;margin:0}
</style></head><body>
 <div class="wrap" id="wrap">
   <div class="driver">&#128230; <b>Just delivering?</b> You've tapped a small NFC tag on this package &mdash; nothing's wrong and nothing is needed from you. Tap <b>&ldquo;I'm just delivering this&rdquo;</b> at the bottom and carry on. It's on its way to the business below.</div>
   <div class="recipient">${logoChip}<div class="bizname">${name}</div></div>
   <div class="card">
     <h1>Is this you, ${name}? &#128075;</h1>
     <p>Your Trey stand is ready. Press the button below to start your <b>${trialDaysFor(client)}-day free trial</b> &mdash; the countdown only begins now, not while it was in the post.</p>
     <form method="POST" action="${action}"><button class="btn" type="submit">Activate my stand &rarr;</button></form>
     <div class="fine">Only press this once your stand is set up and ready for customers.</div>
   </div>
   <!-- DELIBERATE ORDER: the dismiss button is the LOWEST control on the page.
        On a phone the bottom of the screen is where the system back/gesture bar
        sits, so that is the easiest spot to hit by accident — a courier holding
        a parcel one-handed is the likely case. Whatever lands there must be
        harmless, so the harmless action gets that position and Activate is moved
        up out of the thumb's path. An accidental activation would start the
        owner's free trial days early, while they're still in the post.
        It also answers the courier's actual question ("am I done?") with a
        button instead of leaving them guessing.
        Note: a page cannot close a tab it did not open, so window.close() would
        silently do nothing on most phones. This swaps to a finished state
        instead, which is honest and needs no permission. -->
   <button class="btn-safe" type="button" id="dismiss">I'm just delivering this &mdash; nothing to do</button>
   <div class="foot">${treyMarkSvg(24)} Powered by Trey</div>
 </div>
 <script>
   document.getElementById('dismiss').addEventListener('click', function () {
     document.getElementById('wrap').innerHTML =
       '<div class="done">${treyMarkSvg(40)}<h1>All done &mdash; thank you<\\/h1>' +
       '<p>Nothing further needed. You can close this page and carry on.<\\/p><\\/div>';
     window.scrollTo(0, 0);
   });
 <\/script>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
}

// Shown right after the owner presses Activate — trial has started, stand is live.
function activatedPage(client, target) {
  const safeTarget = escapeHtml(target);
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your stand is live</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#eef3fc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:22px}
 .card{max-width:400px;width:100%;background:#fff;border:1px solid #cfe0f6;border-radius:18px;padding:26px 22px;text-align:center;box-shadow:0 14px 40px rgba(79,70,229,.12)}
 .tick{width:56px;height:56px;border-radius:50%;background:#ecfdf5;color:#059669;display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 14px}
 h1{font-size:21px;margin:0 0 8px;letter-spacing:-.3px}
 p{font-size:14.5px;color:#475569;line-height:1.55;margin:0 0 18px}
 a.preview{color:#4338ca;font-size:13px;text-decoration:none;font-weight:600}
 .foot{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:22px;color:#64748b;font-size:12px;font-weight:600}
</style></head><body>
 <div style="max-width:400px;width:100%">
   <div class="card">
     <div class="tick">&#10003;</div>
     <h1>You're live!</h1>
     <p>Your ${trialDaysFor(client)}-day free trial has started. From now on, anyone who taps your stand goes straight to your Google review page.</p>
     <a class="preview" href="${safeTarget}">Preview your review page &rarr;</a>
   </div>
   <div class="foot">${treyMarkSvg(24)} Powered by Trey</div>
 </div>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
}

// Should the stand be paused for this client (trial over, not subscribed)?
function isPaused(client) {
  if (!client) return false;
  if (isComped(client)) return false;   // comped: never pauses, whatever the status says
  const status = client.subscriptionStatus;
  if (status === "active") return false;
  if (status === "paused" || status === "past_due" || status === "cancelled" || status === "canceled" || status === "expired") return true;
  if (status === "trial") {
    const started = trialStartMs(client);
    if (started === null) return false; // trial hasn't started yet -> stand still works (test)
    return Date.now() > started + trialDaysFor(client) * 24 * 60 * 60 * 1000;
  }
  return false; // no status recorded = grandfathered active
}

// Name to show on the pause page: the individual's sign-off, else the business.
function displayName(client) {
  if (!client) return "the business owner";
  const isIndividual = (client.voicePerspective || "").toLowerCase() === "individual";
  return (isIndividual ? client.publicSignOffName : client.businessName) ||
    client.businessName || client.publicSignOffName || "the business owner";
}

// Why is the stand deactivated? Drives which message the pause page shows.
//   "payment"     — a subscription payment failed (status paused / past_due)
//   "cancelled"   — the subscription was cancelled
//   "trial_ended" — the free trial (14 days, or 30 if referred) elapsed without subscribing
function pauseReason(client) {
  if (!client) return null;
  if (isComped(client)) return null;
  const s = client.subscriptionStatus;
  if (s === "paused" || s === "past_due") return "payment";
  if (s === "cancelled" || s === "canceled" || s === "expired") return "cancelled";
  if (s === "trial") {
    const started = trialStartMs(client);
    if (started !== null && Date.now() > started + trialDaysFor(client) * 24 * 60 * 60 * 1000) return "trial_ended";
  }
  return null;
}

function pausedPage(client, locationId, reasonOverride) {
  const name = escapeHtml(displayName(client));
  const reason = reasonOverride || pauseReason(client) || "trial_ended";
  const isPayment = reason === "payment";
  const isCancelled = reason === "cancelled";
  const payBase = payLinkFor(client);
  const payUrl = payBase
    ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "")
    : "";

  const heading = isPayment ? "This review link is temporarily unavailable" : "This review link is currently unavailable";
  let ownerMsg, btnLabel;
  if (isPayment) {
    ownerMsg = `<strong>${name}</strong> &mdash; there's a problem with your payment details, so your Trey stand is temporarily disconnected. Update your payment to reconnect it right away.`;
    btnLabel = "Update payment details";
  } else if (isCancelled) {
    ownerMsg = `<strong>${name}</strong> &mdash; your Trey subscription has been cancelled, so your stand is switched off. Resubscribe whenever you'd like it back on.`;
    btnLabel = "Resubscribe";
  } else {
    ownerMsg = `<strong>${name}</strong> &mdash; your ${trialDaysFor(client)}-day free trial has ended. Subscribe to switch your Trey stand back on and keep every review answered.`;
    btnLabel = "Subscribe via Stripe";
  }
  const payButton = payUrl
    ? `<a href="${escapeHtml(payUrl)}" style="display:inline-block;margin-top:20px;background:linear-gradient(180deg,#4f46e5,#4338ca);color:#fff;text-decoration:none;border-radius:12px;padding:15px 28px;font-size:16px;font-weight:700;box-shadow:0 8px 18px rgba(67,56,202,.28);">${btnLabel} &rarr;</a>`
    : `<p style="color:#94a3b8;font-size:13px;margin-top:20px;">Billing link coming soon &mdash; please contact us to reactivate.</p>`;
  const support = `<p style="color:#94a3b8;font-size:12.5px;margin-top:18px;">${isPayment ? "Payment already sorted, or think this is a mistake? " : "Questions? "}Contact us at <a href="mailto:info@trey.today" style="color:#4338ca;">info@trey.today</a></p>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Review link unavailable</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#eef3fc;">
  <div style="max-width:440px;margin:0 auto;padding:24px;">
    <div style="background:#fff;border:1px solid #cfe0f6;border-radius:18px;padding:34px 26px;text-align:center;box-shadow:0 14px 40px rgba(79,70,229,.12);margin-top:60px;">
      <div style="font-size:40px;">&#9203;</div>
      <h1 style="color:#0f172a;font-size:20px;margin:12px 0 8px;">${heading}</h1>
      <p style="color:#64748b;font-size:15px;line-height:1.5;margin:0;">If you were about to leave a review, thank you &mdash; please let <strong>${name}</strong> know their Trey stand needs reactivating.</p>
      <hr style="border:none;border-top:1px solid #eef2f7;margin:22px 0;">
      <p style="color:#475569;font-size:14px;line-height:1.55;margin:0;">${ownerMsg}</p>
      ${payButton}
      ${support}
      <p style="color:#94a3b8;font-size:12px;margin-top:22px;">Trey &bull; Reputation on Autopilot</p>
    </div>
  </div>
</body></html>`,
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { googleUrl, preview } = params;
  // Query param first, then the short-link path. See locationFromPath().
  const locationId = params.locationId || locationFromPath(event);

  // No location on the tag = misconfigured stand. Show a gentle notice rather
  // than bouncing the customer to a broken Google URL.
  if (!locationId) {
    console.warn(`[tap] no locationId — path="${(event && event.path) || ""}" rawUrl="${(event && event.rawUrl) || ""}"`);
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invalid link</title></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:80px 24px;color:#64748b;">This tap link isn't set up correctly. Please let the business know.<!-- trey: no locationId in query or path --></body></html>`,
    };
  }

  const clientsStore = blobsStore("clients");
  const client = await clientsStore.get(locationId, { type: "json" });

  // Unknown location = no such client. Show the gentle notice instead of counting
  // bogus taps or redirecting to a broken Google URL.
  if (!client) {
    console.warn(`[tap] unknown locationId "${locationId}" — no such client record.`);
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not found</title></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:80px 24px;color:#64748b;">This tap link isn't set up correctly. Please let the business know.<!-- trey: unknown locationId "${escapeHtml(locationId)}" --></body></html>`,
    };
  }

  // Preview mode lets an owner/admin see a deactivated page without changing
  // anything. ?preview=paused|trial_ended -> trial-ended message; ?preview=payment
  // -> payment-problem message.
  if (preview === "paused" || preview === "trial_ended") return pausedPage(client, locationId, "trial_ended");
  if (preview === "payment") return pausedPage(client, locationId, "payment");

  // Enforce the trial / subscription gate.
  if (isPaused(client)) {
    return pausedPage(client, locationId);
  }

  const status = client && client.subscriptionStatus;
  // A trial stand whose owner hasn't activated it yet.
  const notStarted = status === "trial" && trialStartMs(client) === null;

  // OWNER ACTIVATION. The activation page's button POSTs here (POST only, so a
  // link-preview bot or NFC scanner pre-fetch — always a GET — can never trigger
  // it). The first activation stamps the trial start and switches the stand live.
  if (event.httpMethod === "POST" && params.activate === "1") {
    if (notStarted && client) {
      try {
        await clientsStore.setJSON(locationId, { ...client, trialStartedAt: new Date().toISOString() });
      } catch (e) {
        console.error("Activation write failed:", e);
        // Don't tell the owner they're live when the write failed — ask them to retry.
        return {
          statusCode: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Try again</title></head><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#eef3fc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;text-align:center;"><div style="max-width:400px;"><div style="font-size:38px;">&#9888;&#65039;</div><h1 style="font-size:20px;margin:10px 0 8px;">That didn't go through</h1><p style="color:#475569;font-size:15px;line-height:1.55;">We couldn't switch your stand on just then &mdash; please tap Activate again in a moment. If it keeps happening, email <a href="mailto:info@trey.today" style="color:#4338ca;">info@trey.today</a>.</p></div></body></html>`,
        };
      }
      // Only AFTER the trial stamp is safely written. Sending "you're live" to
      // someone whose activation didn't save would be worse than sending nothing.
      // Guarded even though sendActivationAlerts() already swallows everything —
      // an unexpected throw here must not turn a successful activation into the
      // "that didn't go through" page.
      try {
        await sendActivationAlerts(client, locationId);
      } catch (e) {
        console.error("[tap] activation alerts threw unexpectedly:", e && e.message);
      }
      return activatedPage(client, safeReviewTarget(googleUrl, client, locationId));
    }
    // Already live / not a trial -> just send them onward.
    return { statusCode: 303, headers: { Location: safeReviewTarget(googleUrl, client, locationId), "Cache-Control": "no-store" }, body: "" };
  }

  // Not yet activated -> show the activation page (delivery-driver notice + the
  // owner's Activate button) instead of redirecting to Google.
  //
  // This is the DEFAULT, deliberately. It used to fire only when standMode was
  // explicitly "ship", which meant a stand provisioned without that flag skipped
  // the gate entirely: it passed straight through to Google, never stamped
  // trialStartedAt, and so never started the trial clock — free service forever.
  // Now only an explicit "test" stand (an admin checking the chip before dispatch)
  // bypasses activation, so a forgotten flag fails CLOSED ("please activate")
  // rather than free.
  //
  // The trial therefore starts on the business's own first genuine tap, when they
  // press Activate and switch the Google pass-through on — not while the stand is
  // still in the post.
  if (notStarted && client && client.standMode !== "test") {
    return activationPage(client, locationId);
  }

  // Otherwise: an explicit admin "Test" stand (redirect to Google so the chip can
  // be checked, but don't count and don't start the clock), or a live / active /
  // grandfathered stand (redirect AND count).
  if (!notStarted) {
    try {
      const tapsStore = blobsStore("taps");
      await tapsStore.setJSON(locationId, {
        timestamp: new Date().toISOString(),
        processed: false,
      });

      // Tap tallies for reporting: one per month, plus an all-time total since sign-up.
      const tallyStore = blobsStore("taptally");
      const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
      const tallyKey = `${locationId}:${monthKey}`;
      const tally = (await tallyStore.get(tallyKey, { type: "json" })) || { taps: 0 };
      tally.taps += 1;
      await tallyStore.setJSON(tallyKey, tally);

      const totalKey = `${locationId}:total`;
      const total = (await tallyStore.get(totalKey, { type: "json" })) || { taps: 0 };
      total.taps += 1;
      await tallyStore.setJSON(totalKey, total);

      // Weekly bucket (Mon-Sun) for the weekly report.
      const weekTallyKey = `${locationId}:week:${weekKey(new Date())}`;
      const weekTally = (await tallyStore.get(weekTallyKey, { type: "json" })) || { taps: 0 };
      weekTally.taps += 1;
      await tallyStore.setJSON(weekTallyKey, weekTally);
    } catch (err) {
      console.error("Tap logging error:", err);
    }
  }

  const target = safeReviewTarget(googleUrl, client, locationId);

  // Active clients: redirect STRAIGHT to Google — no interstitial. The tap is
  // already logged above, so attribution is unaffected. The old 1.6s thank-you
  // page was unreadable and only cost drop-off between tap and review form.
  // (The pause/notice pages above are kept — the message only matters when the
  // subscription isn't paid.)
  return {
    statusCode: 302,
    headers: { Location: target, "Cache-Control": "no-store" },
    body: "",
  };
};
