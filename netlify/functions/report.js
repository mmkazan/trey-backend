const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const askHealthLib = require("./ask-health.js");
const audit = require("./profile-audit.js");

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


// Enhanced Monthly Report — the "read more" page the monthly WhatsApp links to.
//
// Server-renders a full, self-contained, mobile-first HTML page showing one
// client's month with Trey: their Google rating climb, taps + new reviews this
// month, Trey's share of those reviews, the journey since they joined, and an
// optional glowing-review highlight. Personalised with the client's own logo.
// Same "one request in, finished HTML out" pattern as tap.js's pause page, so
// it loads instantly when tapped from WhatsApp.
//
//   GET /.netlify/functions/report?loc=<locationId>&m=<YYYY-MM>&k=<key>
//        -> the rendered report page
//        m is optional -> defaults to the last COMPLETE calendar month.
//
//   GET /.netlify/functions/report?loc=<locationId>&gen=1&token=<ADMIN_TOKEN>[&m=YYYY-MM]
//        -> JSON { loc, month, key, url } — generates the signed link to send.
//           Guarded by CLIENT_ADMIN_TOKEN (same token used across the backend),
//           so keys are minted with the real secret that lives on Netlify.
//
// The link must not be guessable (a competitor shouldn't be able to swap in
// another locationId and read its stats), so every link carries a per-client
// key k = HMAC-SHA256(locationId, TREY_REPORT_SECRET) truncated, verified here.
//
// Env: TREY_REPORT_SECRET (new), CLIENT_ADMIN_TOKEN, and the usual
//      NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN used by the other functions.

// Trey brand.
// "GREEN" kept as the name to avoid churn, but Trey's accent is now Indigo.
const GREEN = "#4338ca";
const SLATE = "#0f172a";

// The Trey WhatsApp avatar mark (docs/trey_whatsapp_avatar.png), downscaled to
// 64px and inlined as a data URI so it needs no external fetch. Used as the
// little badge on the "brought you … reviews" line.

// Truncated HMAC length (hex chars). 32 hex = 128 bits — non-guessable, still
// short enough to sit comfortably in a WhatsApp URL.
const KEY_LEN = 32;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Per-client link key. Deterministic, so the monthly send and this function
// derive the same value from the same secret.

// Constant-time compare so a bad key can't be brute-forced by timing.
const { linkKey, linkValid, secretConfigured } = require("./link-keys");

// This page's own purpose. Its key opens THIS page and nothing else — see
// link-keys.js for why. A key minted for another page will not validate here.
const LINK_PURPOSE = "report";

// Kept as a thin wrapper so existing call sites read the same. All the real
// work (constant-time compare, fail-closed on an unset secret, byte-length
// check before timingSafeEqual) lives in link-keys.js.
function keyValid(locationId, provided) {
  return linkValid(LINK_PURPOSE, locationId, provided);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A gentle "days of free trial left + Subscribe" banner. Shows only while the
// client is on trial (or lapsed); nothing once subscribed. Needs STRIPE_PAYMENT_LINK.
// --- Winding down: cancelled, but still paid up until period end -------------
// A client who cancels stays subscriptionStatus "active" until the period they
// paid for actually runs out — which is exactly what terms.html promises, but it
// meant they saw NOTHING at all: no countdown, no way back. The single best
// moment to win someone back is while they can still change their mind with one
// tap, and while they're still getting value.
//
// Points at the BILLING page, not a payment link. They still have a live Stripe
// subscription that is merely set to end, so the correct action is Resume — one
// click, no card re-entry, no new subscription. Sending them to a fresh payment
// link here would create a SECOND subscription and bill them twice.
function windingDownBanner(client, locationId) {
  if (!client || !client.cancelAtPeriodEnd || !client.currentPeriodEnd) return "";
  // Only while they're actually still being served. A paused or cancelled
  // account with a stale future period-end would otherwise show "only N days
  // left — change your mind?" while the stand is already switched off: two
  // surfaces telling the customer opposite things.
  const st = String(client.subscriptionStatus || "").toLowerCase();
  if (st && st !== "active" && st !== "trial") return "";
  const endMs = Number(client.currentPeriodEnd) * 1000;
  if (!isFinite(endMs)) return "";
  const daysLeft = Math.ceil((endMs - Date.now()) / 86400000);
  if (daysLeft <= 0) return "";   // already ended — the paused banner takes over
  const k = linkKey("billing", locationId);
  const base = process.env.URL || "https://trey.today";
  const url = `${base}/.netlify/functions/billing?loc=${encodeURIComponent(locationId)}&k=${k}`;
  const days = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
  return `<div style="background:#fff7ed;border-bottom:1px solid #fed7aa;color:#9a3412;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.45;text-align:center;padding:10px 14px">` +
    `Only <b>${days}</b> left with Trey. <a href="${url}" style="color:#c2410c;font-weight:800;text-decoration:underline;white-space:nowrap">Change your mind?</a>` +
    `</div>`;
}

function trialBanner(client, locationId) {
  if (!client) return "";
  // A comped account has nothing to buy — never show them a Subscribe nag.
  if (isComped(client)) return "";
  // Cancelled but still running — countdown beats silence.
  const winding = windingDownBanner(client, locationId);
  if (winding) return winding;
  const status = client.subscriptionStatus;
  if (status === "active") return "";
  // 14 days normally; 30 for a business that arrived via a referral link.
  const TRIAL_DAYS = (function(){ const n = Number(client && client.trialDays);
    return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 14; })();
  const onTrial = status === "trial";
  // Effective trial start: trialStartedAt (set on the stand's first live tap)
  // or, for legacy clients without the new flag, createdAt.
  let startedMs = null;
  if (client.trialStartedAt) { const t = new Date(client.trialStartedAt).getTime(); if (!isNaN(t)) startedMs = t; }
  else if (!client.trialStartsOnTap && client.createdAt) { const t = new Date(client.createdAt).getTime(); if (!isNaN(t)) startedMs = t; }
  const payBase = payLinkFor(client);
  const payUrl = payBase ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "") : "";
  const bar = (inner) => `<div style="background:#fff1f2;border-bottom:1px solid #fecdd3;color:#9f1239;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.45;text-align:center;padding:10px 14px">${inner}</div>`;
  const link = (t) => (payUrl ? `<a href="${escapeHtml(payUrl)}" style="color:#4f46e5;font-weight:800;text-decoration:underline;white-space:nowrap">${t}</a>` : `<strong>${t}</strong>`);
  // On-tap trial that hasn't started yet — waiting on the stand's first tap.
  if (onTrial && startedMs === null) {
    return bar(`Your ${TRIAL_DAYS}-day free trial starts once you activate your Trey stand.`);
  }
  let daysLeft = null;
  if (startedMs !== null) daysLeft = Math.ceil((startedMs + TRIAL_DAYS * 86400000 - Date.now()) / 86400000);
  const ended = status === "paused" || status === "past_due" || status === "cancelled" || status === "canceled" || (onTrial && daysLeft !== null && daysLeft <= 0);
  if (!onTrial && !ended) return "";
  let msg;
  if (ended) {
    msg = `Your Trey stand is paused — ${link("resubscribe")} to switch it back on.`;
  } else if (daysLeft !== null && daysLeft <= 3) {
    msg = `Just ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left of your free trial — ${link("keep Trey going")} whenever you're ready.`;
  } else if (daysLeft !== null) {
    msg = `${daysLeft} days left of your free trial. Enjoying Trey? ${link("Set up your subscription")}.`;
  } else {
    msg = `You're on your free trial — ${link("set up your subscription")} whenever you're ready.`;
  }
  return bar(msg);
}

// YYYY-MM of the last COMPLETE calendar month (the default when m is omitted).
function lastCompleteMonth(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCDate(0); // -> last day of previous month
  return d.toISOString().slice(0, 7);
}

// "2026-07" -> "2026-06" (the calendar month before ym).
function prevMonthKey(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return ym;
  const d = new Date(Date.UTC(y, m - 1, 1)); // first day of ym
  d.setUTCDate(0); // step back to the last day of the previous month
  return d.toISOString().slice(0, 7);
}

// "2026-07" -> "July 2026".
function monthLabel(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return String(ym);
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${names[m - 1]} ${y}`;
}

// Ratings render as 4, 4.3 etc — never "4.30" or "4.0".
function fmtRating(r) {
  if (r === null || r === undefined || r === "") return null;
  const n = Number(r); // onboarding may store ratings as strings ("4.5")
  if (!isFinite(n)) return null;
  return (Math.round(n * 10) / 10).toString();
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// The Trey logo at the top of every page. If TREY_LOGO_URL is set we render
// that image; otherwise we inline the official "trey" logo (from
// docs/trey_logo_2.svg) as a single-colour vector that recolours per theme —
// white on the green background, slate on the light theme. Inline (not an
// external image) so the page stays fully self-contained and loads instantly.
function treyMarkHtml() {
  const logo = process.env.TREY_LOGO_URL;
  if (logo) {
    return `<img class="treylogo" src="${escapeHtml(logo)}" alt="Trey" referrerpolicy="no-referrer">`;
  }
  return `<svg class="treylogo-svg" viewBox="54 88 228 192" role="img" aria-label="Trey" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <g id="ripArcs">
        <path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.32"/>
        <path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.6"/>
        <path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
      </g>
      <g id="mark">
        <use href="#ripArcs" transform="rotate(-20 50 50)"/>
        <rect x="37" y="39" width="26" height="8" rx="2" fill="currentColor"/>
        <rect x="46" y="39" width="8" height="25" rx="2" fill="currentColor"/>
      </g>
    </defs>
    <g transform="translate(165,181) scale(1.18) translate(-165,-181)">
      <use href="#mark" transform="translate(74,105) scale(1.4)"/>
      <text x="206" y="244" font-size="48" font-weight="800" letter-spacing="-1.7" fill="currentColor" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">trey</text>
    </g>
  </svg>`;
}

// The small square "app icon" Trey badge (indigo squircle, white tilted-ripple
// mark) shown inline next to Trey-branded lines. Self-contained SVG so it
// recolours cleanly and needs no external image.
function treyBadgeSvg(cls) {
  return `<svg class="${cls}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Trey"><rect width="100" height="100" rx="24" fill="#4338ca"/><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.32"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.6"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="#fff"/><rect x="46" y="39" width="8" height="25" rx="2" fill="#fff"/></svg>`;
}

// A small helper page for the not-authorised / not-found / no-data cases, in
// the same green visual language as the real report.
function noticePage(statusCode, title, message) {
  const body = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box}
  html{background:#4338ca}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#4338ca;background-image:linear-gradient(165deg,#4f46e5 0%,#4338ca 42%,#3730a3 100%);background-repeat:no-repeat;color:${SLATE};display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .wrap{max-width:420px;width:100%;text-align:center}
  .treylockup{display:inline-flex;align-items:center;gap:9px;margin-bottom:20px}
  .treytile{width:34px;height:34px;border-radius:10px;background:#fff;color:${GREEN};display:inline-flex;align-items:center;justify-content:center;font-size:17px}
  .treyword{font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px}
  .treylogo{max-height:44px;max-width:150px;object-fit:contain;margin-bottom:20px}
  .treylogo-svg{height:58px;width:auto;color:#fff;margin-bottom:20px}
  .card{width:100%;background:#fff;border-radius:16px;padding:36px 26px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.12)}
  h1{font-size:20px;margin:0 0 10px;color:${SLATE}}
  p{font-size:15px;color:#64748b;line-height:1.55;margin:0}
  .foot{margin-top:22px;font-size:12px;color:rgba(255,255,255,0.85)}
</style></head>
<body><div class="wrap">
  ${treyMarkHtml()}
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  <div class="foot">Powered by Trey</div>
</div></body></html>`;
  return { statusCode, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
}

// Pull everything the page needs for one client + month.
async function loadReportData(locationId, month) {
  const clientsStore = blobsStore("clients");
  const client = await clientsStore.get(locationId, { type: "json" });
  if (!client) return { client: null };

  const taptally = blobsStore("taptally");
  const reviewtally = blobsStore("reviewtally");
  const statsStore = blobsStore("stats");
  const reviewsStore = blobsStore("reviews");

  const tapMonth = (await taptally.get(`${locationId}:${month}`, { type: "json" })) || { taps: 0 };
  const revMonth = (await reviewtally.get(`${locationId}:${month}`, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };
  const stats = (await statsStore.get(locationId, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };

  // Monthly Google-rating snapshots power the hero's true month-over-month
  // change. Snapshots are written by monthly-google-sync (see
  // refresh-google-stats.js); here we read this month's and last month's, and
  // backfill this month from the live rating if a snapshot isn't there yet so
  // history starts accumulating from the first report.
  const ratingHistory = blobsStore("ratinghistory");
  const num = (v) => (v && typeof v.rating === "number" ? v.rating : null);
  let monthRating = num(await ratingHistory.get(`${locationId}:${month}`, { type: "json" }));
  const liveRating = Number(client.googleRating);
  if (monthRating === null && isFinite(liveRating)) {
    monthRating = liveRating;
    // Only persist a backfilled snapshot for the current or just-ended month.
    // Never write today's live rating into an OLD month that a saved link
    // requested — that would fabricate history and skew later month-over-month
    // deltas.
    const bnow = new Date();
    const currentMonth = bnow.toISOString().slice(0, 7);
    if (month === currentMonth || month === lastCompleteMonth(bnow)) {
      try {
        await ratingHistory.setJSON(`${locationId}:${month}`, {
          rating: monthRating, source: "report-backfill", capturedAt: new Date().toISOString(),
        });
      } catch (e) { console.error("[report] rating snapshot backfill failed:", e.message); }
    }
  }
  const prevMonthRating = num(await ratingHistory.get(`${locationId}:${prevMonthKey(month)}`, { type: "json" }));

  // Optional highlight: the most recent glowing (5★, then 4★) review from this
  // month that left a comment.
  let highlight = null;
  try {
    const { blobs } = await reviewsStore.list({ prefix: `review:${locationId}:${month}:` });
    const monthly = (await Promise.all(
      blobs.map((b) => reviewsStore.get(b.key, { type: "json" }))
    )).filter((r) => r && r.comment && String(r.comment).trim());
    const byNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    const hasReply = (r) => r.finalReply && String(r.finalReply).trim();
    // Prefer a glowing review that already has Trey's approved reply (so we can
    // show the reply too), then fall back to any glowing review.
    const tiers = [
      monthly.filter((r) => Number(r.rating) >= 5 && hasReply(r)),
      monthly.filter((r) => Number(r.rating) >= 4 && hasReply(r)),
      monthly.filter((r) => Number(r.rating) >= 5),
      monthly.filter((r) => Number(r.rating) >= 4),
    ];
    for (const tier of tiers) {
      const pick = tier.sort(byNewest)[0];
      if (pick) { highlight = pick; break; }
    }
  } catch (e) {
    console.error("[report] highlight lookup failed:", e.message);
  }

  return { client, tapMonth, revMonth, stats, highlight, monthRating, prevMonthRating };
}

function renderReport(locationId, month, data, theme) {
  const { client, tapMonth, revMonth, stats, highlight, monthRating, prevMonthRating } = data;

  const businessName = escapeHtml(client.businessName || "Your business");
  const logoUrl = client.logoUrl ? escapeHtml(client.logoUrl) : "";

  // --- Trey mark (logo image if TREY_LOGO_URL set, else the ✨ lockup) ---
  const treyLockup = treyMarkHtml();

  // --- Client's own logo, sat in a clean chip under their name ---
  const clientLogo = logoUrl
    ? `<div class="clogo"><img src="${logoUrl}" alt="${businessName}" referrerpolicy="no-referrer"></div>`
    : "";

  // --- "Since you joined" figures (lifetime): sign-up rating -> current ---
  const initR = fmtRating(client.initialGoogleRating);
  const nowR = fmtRating(client.googleRating);

  // --- Hero: this month's rating movement (this month vs last month) ---
  const curR = fmtRating(monthRating);       // this month's snapshot (fallback: live rating)
  const prevR = fmtRating(prevMonthRating);   // last month's snapshot
  // Did the rating actually improve this month? (mDelta below is block-scoped;
  // this outer flag is what the referral line keys off.)
  const ratingImproved = curR !== null && prevR !== null &&
    Math.round((monthRating - prevMonthRating) * 10) / 10 > 0;
  let hero;
  if (curR !== null && prevR !== null) {
    const mDelta = Math.round((monthRating - prevMonthRating) * 10) / 10;
    if (mDelta > 0) {
      hero = `
      <div class="ratingrow">
        <span class="rfrom">${prevR}<span class="star">★</span></span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="rto">${curR}<span class="star">★</span></span>
      </div>
      <div class="badge">▲ +${fmtRating(mDelta)} this month</div>
      <div class="herosub">compared with last month</div>`;
    } else if (mDelta === 0) {
      hero = `
      <div class="ratingrow"><span class="rto">${curR}<span class="star">★</span></span></div>
      <div class="badge flat">Holding steady this month</div>`;
    } else {
      hero = `
      <div class="ratingrow">
        <span class="rfrom">${prevR}<span class="star">★</span></span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="rto">${curR}<span class="star">★</span></span>
      </div>
      <div class="badge flat">Now at ${curR}★</div>
      <div class="herosub">compared with last month</div>`;
    }
  } else if (curR !== null) {
    hero = `
      <div class="ratingrow"><span class="rto">${curR}<span class="star">★</span></span></div>
      <div class="herosub">Your month&#8209;on&#8209;month change appears from next month</div>`;
  } else {
    hero = `<div class="ratingrow"><span class="rto muted">Rating syncing…</span></div>`;
  }

  // --- Stat tiles ---
  const taps = Number(tapMonth.taps || 0);
  const newReviews = Number(revMonth.tapReviews || 0) + Number(revMonth.organicReviews || 0);
  const tiles = `
    <div class="tile"><div class="tnum">${taps}</div><div class="tlabel">${taps === 1 ? "Tap" : "Taps"} this month</div></div>
    <div class="tile"><div class="tnum">${newReviews}</div><div class="tlabel">New Google ${newReviews === 1 ? "review" : "reviews"} this month</div></div>`;

  // --- Trey's contribution (the money line) ---
  const treyReviews = Number(revMonth.tapReviews || 0);
  let contribution = "";
  if (newReviews > 0) {
    contribution = `
    <div class="card contribution">
      <p class="big">Trey brought in <strong>${treyReviews}</strong> of your <strong>${newReviews}</strong> new ${newReviews === 1 ? "review" : "reviews"} this month.</p>
      <div class="splitbar">
        <div class="via" style="flex:${treyReviews || 0.0001}"></div>
        <div class="direct" style="flex:${(newReviews - treyReviews) || 0.0001}"></div>
      </div>
      <div class="splitkey">
        <span><i class="dot via"></i>${plural(treyReviews, "via Trey", "via Trey")}</span>
        <span><i class="dot direct"></i>${plural(newReviews - treyReviews, "direct", "direct")}</span>
      </div>
    </div>`;
  }

  // --- Since you joined ---
  const joined = client.createdAt ? new Date(client.createdAt) : null;
  const joinedLabel = joined ? monthLabel(joined.toISOString().slice(0, 7)) : null;
  const initCount = Number(client.initialReviewCount);
  const nowCount = Number(client.reviewCount);
  let reviewsGained = null;
  if (isFinite(initCount) && isFinite(nowCount) && nowCount >= initCount) {
    reviewsGained = nowCount - initCount;
  } else {
    const cum = Number(stats.tapReviews || 0) + Number(stats.organicReviews || 0);
    reviewsGained = cum > 0 ? cum : null;
  }
  const jstar = `<span class="jstar">★</span>`;
  const journeyRatingLine =
    initR !== null && nowR !== null && initR !== nowR
      ? `Rating <span class="jfrom">${initR}</span>${jstar} → ${nowR}${jstar}`
      : nowR !== null
      ? `Rating holding at ${nowR}${jstar}`
      : null;
  const journeyLines = [];
  if (reviewsGained !== null) {
    journeyLines.push(`<div class="jline"><span class="jnum">${reviewsGained}</span> more ${reviewsGained === 1 ? "review" : "reviews"}</div>`);
  }
  if (journeyRatingLine) journeyLines.push(`<div class="jline jrating">${journeyRatingLine}</div>`);
  const totalTrey = Number(stats.tapReviews || 0);
  const sinceJoined = journeyLines.length
    ? `<div class="card journey">
        <div class="section-label">Since you joined${joinedLabel ? ` in ${escapeHtml(joinedLabel)}` : ""}</div>
        ${journeyLines.join("")}
        ${totalTrey > 0 ? `<div class="treytotal">${treyBadgeSvg("tt-mark")} Trey's brought you <span class="tt-num">${totalTrey}</span> ${totalTrey === 1 ? "review" : "reviews"} in total</div>` : ""}
      </div>`
    : "";

  // --- Customer highlight (optional) ---
  let highlightBlock = "";
  if (highlight) {
    const stars = "★".repeat(Math.max(1, Math.min(5, Number(highlight.rating) || 5)));
    const who = highlight.reviewerName ? escapeHtml(highlight.reviewerName) : "A happy customer";
    const reply = highlight.finalReply && String(highlight.finalReply).trim();
    const replyBlock = reply
      ? `<div class="treyreply">
          <div class="tr-head">${treyBadgeSvg("tr-mark")} Trey's reply</div>
          <p class="tr-body">${escapeHtml(String(highlight.finalReply).trim())}</p>
        </div>`
      : "";
    highlightBlock = `
    <div class="card highlight">
      <div class="section-label">A recent highlight</div>
      <div class="qstars">${stars}</div>
      <blockquote>“${escapeHtml(String(highlight.comment).trim())}”</blockquote>
      <div class="qwho">— ${who}</div>
      ${replyBlock}
    </div>`;
  }

  // --- "Your asking" coaching -------------------------------------------------
  // The stand doesn't ask — a person does. Taps are counted separately from
  // reviews precisely so we can see whether that's happening and coach it, which
  // is the single biggest lever on whether a trial converts. Only rendered when
  // there's something worth saying (severity > 0) OR the asking is going well
  // enough to be worth the encouragement.
  const ah = askHealthLib.askHealth({
    client,
    taps,
    reviews: Number(revMonth.tapReviews || 0),
    weeks: 4.3,                                  // one month
    trade: audit.tradeOf(client.businessType),
  });
  const askTone = ah.severity === 2 ? "ask-act" : ah.severity === 1 ? "ask-soft" : "ask-good";
  const askBlock = (ah.state === "waiting" || ah.state === "not_activated")
    ? ""
    : `<div class="card asking ${askTone}">
        <div class="section-label">Your asking</div>
        <p class="askhead">${escapeHtml(ah.headline)}</p>
        <p class="askdetail">${escapeHtml(ah.detail)}</p>
        ${ah.tipRelevant ? `<p class="asktip"><b>The line that works:</b> ${escapeHtml(ah.tip)}</p>` : ""}
        <p class="askstat">${taps} ${taps === 1 ? "tap" : "taps"} this month${ah.conversion !== null ? ` &middot; ${ah.conversion}% became reviews` : ""}</p>
      </div>`;

  // --- Footer: optional link to their Google profile ---
  const profileUrl = client.placeId
    ? `https://search.google.com/local/reviews?placeid=${encodeURIComponent(client.placeId)}`
    : "";
  const footerLink = profileUrl
    ? `<a class="glink" href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener">View your Google reviews →</a>`
    : "";

  // Link into the review Inbox (same signed key, so still no login).
  const inboxBase = process.env.URL || "https://treyv1.netlify.app";
  const inboxLink = `<a class="glink" href="${inboxBase}/.netlify/functions/inbox?loc=${encodeURIComponent(locationId)}&k=${linkKey("inbox", locationId)}">See &amp; reply to your reviews →</a>`;

  // --- Referral line ---------------------------------------------------------
  // Deliberately restrained: we only ask on a month that actually went well, so
  // it reads as "pleased with this? pass it on" rather than a monthly plea. A
  // good month = at least 3 new reviews, OR the rating went up. Everyone else
  // sees nothing at all. It's one quiet line under the footer, never a banner.
  const goodMonth = newReviews >= 3 || ratingImproved;
  const referLine = goodMonth
    ? `<div class="refer"><a class="glink" href="${inboxBase}/.netlify/functions/refer?loc=${encodeURIComponent(locationId)}&k=${linkKey("refer", locationId)}">Know another business who'd want a month like this? Send them your link →</a></div>`
    : "";

  const title = `${businessName} — Your month with Trey`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
  *{box-sizing:border-box}
  :root{--green:${GREEN};--slate:${SLATE}}
  html{min-height:100%}
  body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#e4eefc;color:var(--slate);-webkit-font-smoothing:antialiased}
  .wrap{max-width:460px;margin:0 auto;padding:20px 16px 40px}
  .card{background:#fff;border-radius:18px;padding:22px 20px;margin:14px 0;box-shadow:0 6px 20px rgba(15,23,42,0.06)}
  .head{text-align:center;padding:14px 0 6px}
  .treylockup{display:inline-flex;align-items:center;gap:9px;margin-bottom:16px}
  .treytile{width:34px;height:34px;border-radius:10px;background:var(--green);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:17px}
  .treyword{font-size:24px;font-weight:800;color:var(--slate);letter-spacing:-0.5px}
  .treylogo{max-height:56px;max-width:180px;object-fit:contain;display:block;margin:0 auto 16px}
  .treylogo-svg{height:64px;width:auto;display:block;margin:0 auto 14px;color:var(--slate)}
  .bname{font-size:22px;font-weight:800;letter-spacing:-0.4px;margin:0}
  .clogo{display:inline-block;background:#fff;border-radius:14px;padding:11px 18px;margin:0 auto 18px;box-shadow:0 4px 14px rgba(15,23,42,0.08)}
  .clogo img{max-height:60px;max-width:200px;object-fit:contain;display:block}
  .subtitle{font-size:14px;color:#64748b;margin:12px 0 0}
  .hero{text-align:center;padding:26px 20px}
  .hero .section-label{margin-bottom:14px}
  .ratingrow{display:flex;align-items:center;justify-content:center;gap:14px;font-weight:800;letter-spacing:-1px}
  .rfrom{font-size:34px;color:#94a3b8}
  .rto{font-size:52px;color:var(--slate)}
  .rto.muted{font-size:24px;color:#94a3b8;font-weight:600}
  .arrow{font-size:30px;color:#cbd5e1}
  .star{font-size:0.55em;color:#f59e0b;margin-left:2px}
  .badge{display:inline-block;margin-top:16px;background:#d1fae5;color:#047857;font-weight:700;font-size:15px;padding:8px 16px;border-radius:999px}
  .badge.flat{background:#f1f5f9;color:#475569}
  .herosub{font-size:13px;color:#64748b;margin-top:12px}
  .tiles{display:flex;gap:14px}
  .tiles .tile{flex:1;background:#fff;border-radius:18px;padding:22px 14px;text-align:center;box-shadow:0 6px 20px rgba(15,23,42,0.06)}
  .tnum{font-size:40px;font-weight:800;color:var(--slate);line-height:1;letter-spacing:-1px}
  .tlabel{font-size:13px;color:#64748b;margin-top:8px;line-height:1.35}
  .section-label{font-size:12px;font-weight:700;letter-spacing:0.6px;color:var(--green)}
  .refer{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:13px;opacity:.85}
  .asking{border-left:4px solid #94a3b8}
  .asking.ask-act{border-left-color:#f59e0b;background:#fffbeb}
  .asking.ask-soft{border-left-color:#6366f1;background:#eef2ff}
  .asking.ask-good{border-left-color:#16a34a;background:#f0fdf4}
  .askhead{font-size:17px;font-weight:800;margin:6px 0 4px;letter-spacing:-.3px}
  .askdetail{font-size:14px;color:#475569;margin:0 0 8px;line-height:1.55}
  .asktip{font-size:14px;color:#0f172a;margin:0 0 8px;line-height:1.55;background:rgba(255,255,255,.75);border-radius:8px;padding:9px 11px}
  .askstat{font-size:12.5px;color:#64748b;margin:0}
  .big{font-size:19px;line-height:1.45;margin:10px 0 0;color:var(--slate)}
  .big strong{color:var(--green)}
  .sub{font-size:14px;color:#64748b;margin:10px 0 0}
  .contribution .big{margin-top:0}
  .splitbar{display:flex;height:12px;border-radius:999px;overflow:hidden;margin:18px 0 10px;background:#e2e8f0}
  .splitbar .via{background:var(--green)}
  .splitbar .direct{background:#cbd5e1}
  .splitkey{display:flex;gap:18px;font-size:13px;color:#64748b}
  .splitkey .dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
  .dot.via{background:var(--green)}
  .dot.direct{background:#cbd5e1}
  .journey .big{margin-top:8px}
  .journey .jline{font-size:19px;line-height:1.4;margin:8px 0 0;color:var(--slate);font-weight:600}
  .journey .jnum{color:var(--green);font-weight:800}
  .journey .jrating{font-weight:600;white-space:nowrap}
  .jstar{color:#f59e0b}
  .journey .jfrom{color:#94a3b8}
  .treytotal{margin-top:16px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;padding:12px 14px;font-size:15px;color:#3730a3;font-weight:600;line-height:1.4;display:flex;align-items:center;flex-wrap:wrap;gap:2px}
  .treytotal .tt-mark{width:22px;height:22px;border-radius:6px;margin-right:7px;object-fit:cover;flex:0 0 auto}
  .treytotal .tt-num{color:var(--green);font-weight:800;font-size:18px;margin:0 3px}
  .highlight .qstars{color:#f59e0b;font-size:18px;margin:10px 0 6px;letter-spacing:2px}
  blockquote{margin:0;font-size:18px;line-height:1.5;color:var(--slate);font-weight:500}
  .qwho{font-size:14px;color:#64748b;margin-top:12px}
  .treyreply{margin-top:16px;padding:14px 16px;background:#eef2ff;border-radius:12px;border-left:3px solid var(--green)}
  .treyreply .tr-head{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;letter-spacing:0.6px;color:var(--green)}
  .treyreply .tr-mark{width:20px;height:20px;border-radius:5px;object-fit:cover}
  .treyreply .tr-body{margin:8px 0 0;font-size:15px;line-height:1.5;color:#475569}
  .foot{text-align:center;padding:26px 12px 0;color:#94a3b8;font-size:13px}
  .foot .powered{font-weight:700;color:#64748b}
  .glink{display:inline-block;margin-top:10px;color:var(--green);text-decoration:none;font-weight:600;font-size:14px}
  /* green background theme — solid fallback + gradient that covers the full
     document height (no background-attachment:fixed, which breaks on mobile
     browsers and leaves everything below the first screen white) */
  html:has(body.theme-green){background:#4338ca}
  body.theme-green{background-color:#4338ca;background-image:linear-gradient(165deg,#4f46e5 0%,#4338ca 42%,#3730a3 100%);background-repeat:no-repeat}
  body.theme-green .treylogo-svg{color:#fff}
  body.theme-green .treytile{background:#fff;color:var(--green)}
  body.theme-green .treyword{color:#fff}
  body.theme-green .bname{color:#fff}
  body.theme-green .subtitle{color:rgba(255,255,255,0.85)}
  body.theme-green .foot .powered{color:#fff}
  body.theme-green .foot .glink{color:#fff;text-decoration:underline}
</style></head>
<body class="${theme === "green" ? "theme-green" : ""}">
${trialBanner(client, locationId)}
  <div class="wrap">
    <div class="head">
      ${treyLockup}
      ${clientLogo}
      <h1 class="bname">${businessName}</h1>
      <p class="subtitle">Your month with Trey — ${escapeHtml(monthLabel(month))}</p>
    </div>

    <div class="card hero">
      <div class="section-label">Your Google rating this month</div>
      ${hero}
    </div>

    <div class="tiles">${tiles}</div>

    ${askBlock}

    ${contribution}
    ${sinceJoined}
    ${highlightBlock}

    <div class="foot">
      <div class="powered">Powered by Trey</div>
      ${inboxLink}
      ${footerLink}
      ${referLine}
    </div>
  </div>
</body></html>`;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const locationId = params.loc;
  const now = new Date();
  const month = params.m || lastCompleteMonth(now);

  if (!locationId) {
    return noticePage(400, "Report unavailable", "This report link is missing a location. Please use the link from your monthly Trey message.");
  }

  // --- Key generator (admin-only): mint the signed link to send. ---
  if (params.gen) {
    const gh = event.headers || {};
    const provided = (gh.authorization || gh.Authorization || "").replace(/^Bearer\s+/i, "").trim() || params.token || "";
    const expected = process.env.CLIENT_ADMIN_TOKEN || "";
    const authOk = !!expected && provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!authOk) {
      return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    if (!process.env.TREY_REPORT_SECRET) {
      return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "TREY_REPORT_SECRET is not set on Netlify" }) };
    }
    const key = linkKey("report", locationId);
    const base = process.env.URL || "https://treyv1.netlify.app";
    const url = `${base}/.netlify/functions/report?loc=${encodeURIComponent(locationId)}&m=${encodeURIComponent(month)}&k=${key}`;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loc: locationId, month, key, url }),
    };
  }

  // --- Access gate: non-guessable per-client key required. ---
  if (!process.env.TREY_REPORT_SECRET) {
    console.error("[report] TREY_REPORT_SECRET is not set");
    return noticePage(500, "Report unavailable", "This report isn't set up yet. Please try again later.");
  }
  if (!keyValid(locationId, params.k)) {
    return noticePage(403, "Report unavailable", "This link isn't valid or has expired. Please use the most recent link from your monthly Trey message.");
  }

  let data;
  try {
    data = await loadReportData(locationId, month);
  } catch (err) {
    console.error("[report] data load failed:", err.message);
    return noticePage(500, "Report unavailable", "We couldn't load your report just now. Please try again in a moment.");
  }

  if (!data.client) {
    return noticePage(404, "Report unavailable", "We couldn't find this account. Please check the link from your monthly Trey message.");
  }

  // Green is the default theme; &bg=light is an escape hatch for comparison.
  const theme = params.bg === "light" ? "light" : "green";
  const html = renderReport(locationId, month, data, theme);
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: html,
  };
};
