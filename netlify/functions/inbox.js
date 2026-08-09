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
const GREEN = "#059669";
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

// A gentle "days of free trial left + Subscribe" banner. Shows only while the
// client is on trial (or lapsed); nothing once they're subscribed. Kept
// deliberately soft so it nudges without nagging. Needs STRIPE_PAYMENT_LINK set.
function trialBanner(client, locationId) {
  if (!client) return "";
  const status = client.subscriptionStatus;
  if (status === "active") return "";
  const TRIAL_DAYS = 14;
  let daysLeft = null;
  if (client.createdAt) {
    const ends = new Date(client.createdAt).getTime() + TRIAL_DAYS * 86400000;
    if (!isNaN(ends)) daysLeft = Math.ceil((ends - Date.now()) / 86400000);
  }
  const onTrial = status === "trial";
  const ended = status === "paused" || status === "cancelled" || (onTrial && daysLeft !== null && daysLeft <= 0);
  if (!onTrial && !ended) return ""; // grandfathered / unknown → no banner
  const payBase = process.env.STRIPE_PAYMENT_LINK || "";
  const payUrl = payBase ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "") : "";
  const link = (t) => (payUrl ? `<a href="${escapeHtml(payUrl)}" style="color:#065f46;font-weight:700">${t}</a>` : `<strong>${t}</strong>`);
  let msg;
  if (ended) {
    msg = `Your free trial has ended — ${link("resubscribe")} to switch Trey back on.`;
  } else if (daysLeft !== null && daysLeft <= 3) {
    msg = `Just ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left of your free trial — ${link("keep Trey going")} whenever you're ready.`;
  } else if (daysLeft !== null) {
    msg = `${daysLeft} days left of your free trial. Enjoying Trey? ${link("Set up your subscription")}.`;
  } else {
    msg = `You're on your free trial — ${link("set up your subscription")} whenever you're ready.`;
  }
  return `<div style="background:#ecfdf5;border-bottom:1px solid #a7f3d0;color:#065f46;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.45;text-align:center;padding:9px 14px">${msg}</div>`;
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
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f6f8fa;color:${SLATE}}
  .top{background:${GREEN};background-image:linear-gradient(165deg,#0b8a5e,#059669 55%,#047857);color:#fff;padding:22px 20px 26px}
  .top .wrap,.main{max-width:560px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:16px;opacity:.95}
  .brand .dot{width:26px;height:26px;border-radius:8px;background:#fff;color:${GREEN};display:flex;align-items:center;justify-content:center}
  h1{font-size:21px;margin:14px 0 2px;letter-spacing:-.4px}
  .sub{font-size:13.5px;opacity:.9}
  .main{padding:18px 16px 60px}
  .sec{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin:22px 4px 10px;font-weight:700}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px 15px;margin-bottom:11px}
  .row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .name{font-weight:600;font-size:15px}
  .stars{color:#f59e0b;font-size:13px;letter-spacing:1px}
  .chip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
  .chip.need{background:#fef3c7;color:#92400e}
  .chip.done{background:#dcfce7;color:#166534}
  .date{color:#94a3b8;font-size:11px;margin-top:2px}
  .comment{font-size:14px;color:#475569;line-height:1.5;margin:10px 0 0}
  .reply{font-size:13px;color:#334155;background:#f8fafc;border-left:3px solid ${GREEN};border-radius:0 8px 8px 0;padding:8px 11px;margin-top:10px;white-space:pre-line}
  .reply b{color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:3px}
  .respond{display:inline-block;margin-top:12px;background:${GREEN};color:#fff;text-decoration:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600}
  .allgood{background:#fff;border:1px dashed #cbd5e1;border-radius:14px;padding:26px 16px;text-align:center;color:#64748b;font-size:14px}
  .foot{text-align:center;color:#94a3b8;font-size:12px;margin-top:26px}
</style></head><body>${inner}</body></html>`,
  };
}

function noticePage(statusCode, title, message) {
  const r = shell(title, `<div class="top"><div class="wrap"><div class="brand"><span class="dot">t</span>Trey</div></div></div>
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

  const approveToken = process.env.TREY_TAPPY_SECRET_TOKEN || "";
  const base = process.env.URL || "https://treyv1.netlify.app";
  const respondUrl = (id) => `${base}/.netlify/functions/approve?reviewId=${encodeURIComponent(id)}&token=${encodeURIComponent(approveToken)}`;

  const pendingCard = (r) => `
    <div class="card">
      <div class="row">
        <div><div class="name">${escapeHtml(r.reviewerName || "A customer")}</div><div class="stars">${starRow(r.rating)}</div><div class="date">${fmtDate(r.createdAt)}</div></div>
        <span class="chip need">Needs reply</span>
      </div>
      ${r.comment ? `<p class="comment">"${escapeHtml(r.comment)}"</p>` : ""}
      <a class="respond" href="${respondUrl(r.reviewId)}">Respond &rarr;</a>
    </div>`;

  const repliedCard = (r) => `
    <div class="card">
      <div class="row">
        <div><div class="name">${escapeHtml(r.reviewerName || "A customer")}</div><div class="stars">${starRow(r.rating)}</div><div class="date">${fmtDate(r.createdAt)}</div></div>
        <span class="chip done">&#10003; Replied</span>
      </div>
      ${r.comment ? `<p class="comment">"${escapeHtml(r.comment)}"</p>` : ""}
      ${r.finalReply ? `<div class="reply"><b>Your reply</b>${escapeHtml(r.finalReply)}</div>` : ""}
    </div>`;

  const pendingBlock = pending.length
    ? `<div class="sec">Needs your reply (${pending.length})</div>${pending.map(pendingCard).join("")}`
    : `<div class="sec">Needs your reply</div><div class="allgood">You're all caught up &mdash; no reviews waiting. 🎉</div>`;

  const repliedBlock = replied.length
    ? `<div class="sec">Replied</div>${replied.map(repliedCard).join("")}`
    : "";

  const inner = `
    ${trialBanner(client, loc)}
    <div class="top"><div class="wrap">
      <div class="brand"><span class="dot">t</span>Trey</div>
      <h1>${escapeHtml(businessName)} &mdash; your reviews</h1>
      <div class="sub">${pending.length} waiting &middot; ${replied.length} replied</div>
    </div></div>
    <div class="main">
      ${pendingBlock}
      ${repliedBlock}
      <div style="text-align:center;margin-top:24px"><a href="${base}/.netlify/functions/report?loc=${encodeURIComponent(loc)}&k=${params.k}" style="color:${GREEN};font-weight:600;text-decoration:none;font-size:14px">View your monthly report &rarr;</a></div>
      <div class="foot">Powered by Trey</div>
    </div>`;

  return shell(`${businessName} — reviews`, inner);
};
