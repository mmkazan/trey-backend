const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

// The client-facing review INBOX — a login-free web page listing one client's
// reviews by status (Needs reply / Replied). Same signed-key model as report.js:
// access needs k = HMAC-SHA256(locationId, TREY_REPORT_SECRET) truncated, so the
// link is private per client, needs no password, and is safe to send over
// WhatsApp. The "Respond" buttons deep-link into approve.js.
//
//   GET /inbox?loc=<locationId>&k=<key>           -> the inbox page
//   GET /inbox?loc=<locationId>&gen=1&token=ADMIN -> mint the signed link (admin)

const KEY_LEN = 32;
const INDIGO = "#4338ca";
const INDIGO2 = "#4f46e5";
const ACCENT = "#6366f1";
const SLATE = "#0f172a";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

function reportKey(locationId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update(String(locationId)).digest("hex").slice(0, KEY_LEN);
}
function keyValid(locationId, provided) {
  if (!provided || provided.length !== KEY_LEN) return false;
  try {
    const a = Buffer.from(reportKey(locationId)), b = Buffer.from(provided);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  const d = new Date(iso || 0);
  if (isNaN(d)) return "";
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${m[d.getUTCMonth()]}`;
}
function starRow(r) {
  const n = Math.max(0, Math.min(5, Math.round(Number(r) || 0)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}
function isUrgent(r) {
  const n = Number(r.rating) || 0;
  return n > 0 && n <= 3;
}
// Which source badge to show: a direct Google review vs one driven by a Trey tap.
function viaGoogle(r) {
  const s = String(r.source || "");
  return /google|direct|organic/i.test(s) && !/trey|tappy|tap\b/i.test(s);
}

// Reusable brand marks (inlined once per page). Trey mark keeps the official
// tilted-ripple + lowercase-t geometry (matches docs/trey_logo_2_indigo.svg),
// recoloured via currentColor.
const SVG_DEFS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="treyMark" viewBox="0 0 100 100">
    <g transform="rotate(-20 50 50)">
      <path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.30"/>
      <path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.58"/>
      <path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
    </g>
    <rect x="37" y="39" width="26" height="8" rx="2" fill="currentColor"/>
    <rect x="46" y="39" width="8" height="25" rx="2" fill="currentColor"/>
  </symbol>
  <symbol id="googleG" viewBox="0 0 48 48">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </symbol>
</svg>`;

const treyBadge = `<span class="badge tbadge" title="Came in via a Trey tap"><svg viewBox="0 0 100 100" style="width:20px;height:20px;color:#fff"><use href="#treyMark"/></svg></span>`;
const googleBadge = `<span class="badge gbadge" title="Direct Google review"><svg viewBox="0 0 48 48" style="width:17px;height:17px"><use href="#googleG"/></svg></span>`;
// Icon + a small "Review via" label, so the client knows the badge shows where
// the review came from (their Trey stand vs. straight from Google).
const sourceBadge = (r) => `<span class="src"><span class="srclbl">Review via</span>${viaGoogle(r) ? googleBadge : treyBadge}</span>`;

// --- Onboarding banners ------------------------------------------------------
// The gap between "I signed up" and "my stand arrived" is several days long, and
// until now the inbox said nothing about it — a new client opened their link,
// saw an empty review list, and had no idea whether anything was happening.
// (Found on the first real signup, 15 Aug.)
//
// Two states, driven entirely by the record so nobody has to remember to switch
// a message off:
//   not dispatched     -> "we'll call you shortly"    (we're still setting up)
//   dispatched         -> "it's in the post, tap it"  (admin has sent it)
//   trialStartedAt set -> nothing; they've tapped, they're live
//
// "Dispatched" reads TWO signals on purpose. standMode === "ship" is the switch
// the admin already flips when a stand is packed ("Ready to send"), so this
// works today with no extra step and nothing new to remember. hardwareDispatchedAt
// is the explicit date field for when that needs to be recorded precisely.
// Either one is enough.
//
// Deliberately gated on trialStartsOnTap: legacy clients predate this flow, have
// no hardwareDispatchedAt, and would otherwise be told forever that we're about
// to ring them.
function onboardingBanner(client) {
  if (!client) return "";
  if (!client.trialStartsOnTap) return "";
  if (String(client.subscriptionStatus || "").toLowerCase() !== "trial") return "";
  if (client.trialStartedAt) return "";

  const hw = client.hardware === "keyfob" ? "key fob" : "stand";
  const bar = (inner) =>
    `<div style="background:#eef2ff;border-bottom:1px solid #c7d2fe;color:#3730a3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.45;text-align:center;padding:10px 14px">${inner}</div>`;

  const dispatched = !!client.hardwareDispatchedAt || client.standMode === "ship";
  if (dispatched) {
    return bar(`&#128238; Your Trey ${hw} is in the post. When it arrives, hold it against your phone &mdash; one tap activates it and starts your free trial.`);
  }
  return bar(`&#128222; Trey will call you shortly to finish setting up your account. Your ${hw} goes in the post straight after.`);
}

// A gentle "days of free trial left + Subscribe" banner (coral, so it stands out
// without shouting). Shows only while the client is on trial (or lapsed); nothing
// once they're subscribed. Needs STRIPE_PAYMENT_LINK set.
// `onboarding` is the already-rendered onboardingBanner() output, passed in so
// the two bars can't disagree about which phase the client is in.
function trialBanner(client, locationId, onboarding) {
  if (!client) return "";
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
  const payBase = process.env.STRIPE_PAYMENT_LINK || "";
  const payUrl = payBase ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "") : "";
  const bar = (inner) => `<div style="background:#fff1f2;border-bottom:1px solid #fecdd3;color:#9f1239;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.45;text-align:center;padding:10px 14px">${inner}</div>`;
  const link = (t) => (payUrl ? `<a href="${escapeHtml(payUrl)}" style="color:${INDIGO2};font-weight:800;text-decoration:underline;white-space:nowrap">${t}</a>` : `<strong>${t}</strong>`);
  // On-tap trial that hasn't started yet — waiting on the first tap. For a
  // client still in onboarding, onboardingBanner() says this better and with
  // the right noun, so don't stack two bars saying the same thing.
  if (onTrial && startedMs === null) {
    if (onboarding) return "";
    const hw = client.hardware === "keyfob" ? "key fob" : "stand";
    return bar(`Your ${TRIAL_DAYS}-day free trial starts once you activate your Trey ${hw}.`);
  }
  let daysLeft = null;
  if (startedMs !== null) daysLeft = Math.ceil((startedMs + TRIAL_DAYS * 86400000 - Date.now()) / 86400000);
  const ended = status === "paused" || status === "past_due" || status === "cancelled" || status === "canceled" || (onTrial && daysLeft !== null && daysLeft <= 0);
  if (!onTrial && !ended) return ""; // grandfathered / unknown → no banner
  let msg;
  if (ended) {
    msg = `Your Trey ${client.hardware === "keyfob" ? "key fob" : "stand"} is paused — ${link("resubscribe")} to switch it back on.`;
  } else if (daysLeft !== null && daysLeft <= 3) {
    msg = `Just ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left of your free trial — ${link("keep Trey going")} whenever you're ready.`;
  } else if (daysLeft !== null) {
    msg = `${daysLeft} days left of your free trial. Enjoying Trey? ${link("Set up your subscription")}.`;
  } else {
    msg = `You're on your free trial — ${link("set up your subscription")} whenever you're ready.`;
  }
  return bar(msg);
}

function shell(title, inner) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#e4eefc;color:${SLATE}}
  .top{background:linear-gradient(165deg,${INDIGO2},${INDIGO});color:#fff;padding:22px 20px 26px}
  .top .wrap,.main{max-width:560px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:-.3px}
  .brand svg{height:30px;width:30px;display:block}
  h1{font-size:21px;margin:14px 0 2px;letter-spacing:-.4px}
  .sub{font-size:13.5px;opacity:.9}
  .main{padding:18px 16px 60px}
  .sec{font-size:12px;letter-spacing:.07em;color:#64748b;margin:22px 4px 10px;font-weight:700}
  .card{background:#f3f8ff;border:1px solid #cfe0f6;border-radius:14px;padding:14px 15px;margin-bottom:11px}
  .card.urgent{border-color:#fecaca;background:#fff7f7}
  .row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .name{font-weight:700;font-size:15px}
  .stars{color:#f59e0b;font-size:13px;letter-spacing:1px;margin-top:2px}
  .date{color:#8091ad;font-size:11px;margin-top:3px}
  .meta{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0}
  .chip{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap;border:1px solid}
  .chip.need{background:#fffbeb;color:#b45309;border-color:#fde68a}
  .chip.urgent{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
  .chip.done{background:#ecfdf5;color:#047857;border-color:#a7f3d0}
  .badge{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center}
  .badge.tbadge{background:${INDIGO}}
  .badge.gbadge{background:#fff;border:1px solid #e2e8f0}
  .src{display:flex;align-items:center;gap:6px}
  .srclbl{font-size:10px;color:#8091ad;font-weight:700;letter-spacing:.03em;white-space:nowrap}
  .comment{font-size:14px;color:#334155;line-height:1.5;margin:11px 0 0;font-style:italic}
  .nocomment{font-size:13px;color:#8091ad;line-height:1.5;margin:11px 0 0;font-style:italic}
  .reply{font-size:13px;color:#334155;background:#e9f1fe;border:1px solid #cfe0f6;border-radius:10px;padding:10px 12px;margin-top:11px;white-space:pre-line}
  .reply b{color:#6b7c99;font-weight:600;font-size:11px;letter-spacing:.04em;display:block;margin-bottom:3px}
  .respond{display:inline-block;margin-top:12px;background:${ACCENT};color:#fff;text-decoration:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:700}
  .allgood{background:#f3f8ff;border:1px dashed #b6cdf0;border-radius:14px;padding:26px 16px;text-align:center;color:#64748b;font-size:14px}
  .xlink{display:block;text-align:center;margin-top:24px;color:${ACCENT};font-weight:700;text-decoration:none;font-size:14px}
  .foot{text-align:center;color:#8091ad;font-size:12px;margin-top:26px}
</style></head><body>${SVG_DEFS}${inner}</body></html>`,
  };
}

function noticePage(statusCode, title, message) {
  const r = shell(title, `<div class="top"><div class="wrap"><div class="brand"><svg viewBox="0 0 100 100" style="color:#eef2ff"><use href="#treyMark"/></svg>trey</div></div></div>
    <div class="main"><div class="allgood"><strong style="color:${SLATE}">${escapeHtml(title)}</strong><br>${escapeHtml(message)}</div></div>`);
  r.statusCode = statusCode;
  return r;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const loc = params.loc;
  if (!loc) return noticePage(400, "Inbox unavailable", "This link is missing a location.");

  // Admin: mint the signed inbox link.
  if (params.gen) {
    const h = event.headers || {};
    const provided = (h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim() || params.token || "";
    const expected = process.env.CLIENT_ADMIN_TOKEN || "";
    const ok = !!expected && provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    if (!process.env.TREY_REPORT_SECRET) return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "TREY_REPORT_SECRET not set" }) };
    const key = reportKey(loc);
    const base = process.env.URL || "https://treyv1.netlify.app";
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loc, key, url: `${base}/.netlify/functions/inbox?loc=${encodeURIComponent(loc)}&k=${key}` }) };
  }

  if (!process.env.TREY_REPORT_SECRET) return noticePage(500, "Inbox unavailable", "This isn't set up yet. Please try again later.");
  if (!keyValid(loc, params.k)) return noticePage(403, "Inbox unavailable", "This link isn't valid or has expired. Please use the most recent link from Trey.");

  const client = await blobsStore("clients").get(loc, { type: "json" });
  const businessName = (client && client.businessName) || "your business";
  // Rendered once and reused: the banner itself, the trial bar's decision not to
  // repeat it, and the empty-state wording all have to agree.
  const onboarding = onboardingBanner(client);

  const reviewsStore = blobsStore("reviews");
  let records = [];
  try {
    const { blobs } = await reviewsStore.list({ prefix: `review:${loc}:` });
    records = (await Promise.all(blobs.map((b) => reviewsStore.get(b.key, { type: "json" })))).filter(Boolean);
  } catch (e) {
    console.error("[inbox] list failed:", e.message);
  }
  records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const pending = records.filter((r) => r.status !== "approved" && r.status !== "skipped");
  const replied = records.filter((r) => r.status === "approved");
  // Urgent (low-star) reviews rise to the top of the waiting list.
  pending.sort((a, b) => (isUrgent(b) - isUrgent(a)) || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));

  const base = process.env.URL || "https://treyv1.netlify.app";
  // Per-review signature — each Respond link only works for its own review
  // (matches signReview() in approve.js). No shared token in the URL.
  const approveSig = (id) => crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "").update("approve:" + String(id)).digest("hex").slice(0, 32);
  const respondUrl = (id) => `${base}/.netlify/functions/approve?reviewId=${encodeURIComponent(id)}&sig=${approveSig(id)}`;

  const commentBlock = (r) => (r.comment
    ? `<p class="comment">"${escapeHtml(r.comment)}"</p>`
    : `<p class="nocomment">Rating only — no comment left</p>`);

  const pendingCard = (r) => {
    const urgent = isUrgent(r);
    const chip = urgent
      ? `<span class="chip urgent">&#9888; Urgent reply</span>`
      : `<span class="chip need">Needs reply</span>`;
    return `
    <div class="card${urgent ? " urgent" : ""}">
      <div class="row">
        <div><div class="name">${escapeHtml(r.reviewerName || "A customer")}</div><div class="stars">${starRow(r.rating)}</div><div class="date">${fmtDate(r.createdAt)}</div></div>
        <div class="meta">${chip}${sourceBadge(r)}</div>
      </div>
      ${commentBlock(r)}
      <a class="respond" href="${respondUrl(r.reviewId)}">Respond &rarr;</a>
    </div>`;
  };

  const repliedCard = (r) => `
    <div class="card">
      <div class="row">
        <div><div class="name">${escapeHtml(r.reviewerName || "A customer")}</div><div class="stars">${starRow(r.rating)}</div><div class="date">${fmtDate(r.createdAt)}</div></div>
        <div class="meta"><span class="chip done">&#10003; Replied</span>${sourceBadge(r)}</div>
      </div>
      ${commentBlock(r)}
      ${r.finalReply ? `<div class="reply"><b>Your reply</b>${escapeHtml(r.finalReply)}</div>` : ""}
    </div>`;

  // "You're all caught up 🎉" is a lie to somebody who has never had a review
  // and is still waiting for their stand — it reads as though the system has
  // been running and found nothing.
  const emptyState = onboarding && !records.length
    ? `This is where your reviews will land. It stays quiet until your Trey ${client && client.hardware === "keyfob" ? "key fob" : "stand"} is activated &mdash; nothing to do here yet.`
    : `You're all caught up &mdash; no reviews waiting. 🎉`;
  const pendingBlock = pending.length
    ? `<div class="sec">Needs your reply (${pending.length})</div>${pending.map(pendingCard).join("")}`
    : `<div class="sec">Needs your reply</div><div class="allgood">${emptyState}</div>`;

  const repliedBlock = replied.length
    ? `<div class="sec">Replied</div>${replied.map(repliedCard).join("")}`
    : "";

  const inner = `
    ${onboarding}
    ${trialBanner(client, loc, onboarding)}
    <div class="top"><div class="wrap">
      <div class="brand"><svg viewBox="0 0 100 100" style="color:#eef2ff"><use href="#treyMark"/></svg>trey</div>
      <h1>${escapeHtml(businessName)} &mdash; your reviews</h1>
      <div class="sub">${pending.length} waiting &middot; ${replied.length} replied</div>
    </div></div>
    <div class="main">
      ${pendingBlock}
      ${repliedBlock}
      <a class="xlink" href="${base}/.netlify/functions/report?loc=${encodeURIComponent(loc)}&k=${params.k}">View your monthly report &rarr;</a>
      <a class="xlink" href="${base}/.netlify/functions/account?loc=${encodeURIComponent(loc)}&k=${params.k}">Update your account details &rarr;</a>
      <a class="xlink" href="${base}/.netlify/functions/profile-check?loc=${encodeURIComponent(loc)}&k=${params.k}">Tune your Google profile &rarr;</a>
      <a class="xlink" href="${base}/.netlify/functions/refer?loc=${encodeURIComponent(loc)}&k=${params.k}">Refer a business, get a month free &rarr;</a>
      <div class="foot">Powered by Trey</div>
    </div>`;

  return shell(`${businessName} — reviews`, inner);
};
