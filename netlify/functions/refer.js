const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

// The client-facing REFERRAL page — login-free, same signed-key model as
// report.js / inbox.js: access needs k = HMAC-SHA256(locationId, TREY_REPORT_SECRET)
// truncated, so the link is private per client and safe to send over WhatsApp.
//
//   GET /refer?loc=<locationId>&k=<key>            -> the referral page
//   GET /refer?loc=<locationId>&gen=1&token=ADMIN  -> mint the signed link (admin)
//
// The offer (decided 2026-08-14):
//   • the REFERRER gets a free month once the business they sent subscribes
//   • the REFERRED business gets a 30-day trial instead of 14
//
// Reward timing matters: credit is earned when the new business actually
// SUBSCRIBES, never at signup. Crediting on signup would let anyone farm free
// months by submitting fake businesses.
//
// Stripe isn't wired to apply credits automatically yet (webhook is on the
// backlog), so this page reports status and admin.html surfaces what's owed for
// Matthew to apply by hand. Nothing here touches billing.

const KEY_LEN = 32;
const CODE_LEN = 8;
const INDIGO = "#4338ca";
const INDIGO2 = "#4f46e5";
const ACCENT = "#6366f1";
const SLATE = "#0f172a";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

const { linkKey, linkValid, secretConfigured, safeEqual } = require("./link-keys");

// This page's own purpose. Its key opens THIS page and nothing else — see
// link-keys.js for why. A key minted for another page will not validate here.
const LINK_PURPOSE = "refer";

// Kept as a thin wrapper so existing call sites read the same. All the real
// work (constant-time compare, fail-closed on an unset secret, byte-length
// check before timingSafeEqual) lives in link-keys.js.
function keyValid(locationId, provided) {
  return linkValid(LINK_PURPOSE, locationId, provided);
}

// A short, stable, non-guessable referral code for a client. Deterministic, so
// it never needs storing to be regenerated — but we DO write a code->location
// index (below) so signup.js can resolve it with a single blob read instead of
// scanning every client.
function refCode(locationId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update("ref:" + String(locationId)).digest("hex").slice(0, CODE_LEN);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const MARK = `<svg viewBox="0 0 100 100" style="width:30px;height:30px;color:#eef2ff" aria-hidden="true">
  <g transform="rotate(-20 50 50)">
    <path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.30"/>
    <path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.58"/>
    <path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
  </g>
  <rect x="37" y="39" width="26" height="8" rx="2" fill="currentColor"/>
  <rect x="46" y="39" width="8" height="25" rx="2" fill="currentColor"/>
</svg>`;

function shell(title, inner) {
  return {
    statusCode: 200,
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
  h1{font-size:21px;margin:14px 0 2px;letter-spacing:-.4px}
  .sub{font-size:13.5px;opacity:.9;line-height:1.5}
  .main{padding:18px 16px 60px}
  .card{background:#f3f8ff;border:1px solid #cfe0f6;border-radius:14px;padding:16px 16px;margin-bottom:12px}
  .lbl{font-size:12px;color:#64748b;font-weight:700;margin-bottom:7px}
  .linkbox{display:flex;gap:8px;align-items:stretch}
  .linkbox input{flex:1;min-width:0;font-size:13px;padding:11px 12px;border:1px solid #cfe0f6;border-radius:10px;background:#fff;color:${SLATE};font-family:inherit}
  .btn{display:inline-block;background:${ACCENT};color:#fff;text-decoration:none;border:none;border-radius:10px;padding:11px 16px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit}
  .btn.wa{background:#25D366;width:100%;text-align:center;margin-top:10px;padding:13px}
  .btn.ghost{background:#fff;color:${INDIGO};border:1px solid #cfe0f6}
  .how{display:grid;gap:10px;margin:2px 0 0}
  .how div{font-size:14px;color:#334155;line-height:1.5;padding-left:26px;position:relative}
  .how div b{color:${SLATE}}
  .how div:before{content:"";position:absolute;left:0;top:6px;width:13px;height:13px;border-radius:50%;background:#dbeafe;border:2px solid ${ACCENT}}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:2px}
  .stat{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:13px 8px;text-align:center}
  .stat .n{font-size:24px;font-weight:800;color:${INDIGO};letter-spacing:-.5px}
  .stat .l{font-size:11.5px;color:#64748b;margin-top:2px}
  .rows{margin-top:10px}
  .row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #e2e8f0;font-size:13.5px}
  .row:first-child{border-top:none}
  .chip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;border:1px solid}
  .chip.on{background:#ecfdf5;color:#047857;border-color:#a7f3d0}
  .chip.wait{background:#fffbeb;color:#b45309;border-color:#fde68a}
  .none{font-size:13.5px;color:#64748b;line-height:1.55}
  .foot{text-align:center;color:#8091ad;font-size:12px;margin-top:24px;line-height:1.6}
  .back{display:block;text-align:center;margin-top:20px;color:${ACCENT};font-weight:700;text-decoration:none;font-size:14px}
  .ok{display:none;color:#047857;font-weight:700;font-size:12.5px;margin-top:7px}
</style></head><body>${inner}</body></html>`,
  };
}

function noticePage(statusCode, title, message) {
  const r = shell(title, `<div class="top"><div class="wrap"><div class="brand">${MARK}trey</div></div></div>
    <div class="main"><div class="card"><strong>${escapeHtml(title)}</strong><br><span class="none">${escapeHtml(message)}</span></div></div>`);
  r.statusCode = statusCode;
  return r;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const loc = params.loc;
  if (!loc) return noticePage(400, "Page unavailable", "This link is missing a location.");

  // Admin: mint the signed referral link.
  if (params.gen) {
    const h = event.headers || {};
    const provided = (h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim() || params.token || "";
    const expected = process.env.CLIENT_ADMIN_TOKEN || "";
    // safeEqual compares BYTES and swallows its own errors, so the try/catch
    // that used to wrap this is no longer doing any work.
    const ok = safeEqual(provided, expected);
    if (!ok) return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    if (!process.env.TREY_REPORT_SECRET) return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "TREY_REPORT_SECRET not set" }) };
    const base = process.env.URL || "https://treyv1.netlify.app";
    return {
      statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loc, code: refCode(loc), url: `${base}/.netlify/functions/refer?loc=${encodeURIComponent(loc)}&k=${linkKey("refer", loc)}` }),
    };
  }

  if (!process.env.TREY_REPORT_SECRET) return noticePage(500, "Page unavailable", "This isn't set up yet. Please try again later.");
  if (!keyValid(loc, params.k)) return noticePage(403, "Page unavailable", "This link isn't valid or has expired. Please use the most recent link from Trey.");

  const clientsStore = blobsStore("clients");
  const client = await clientsStore.get(loc, { type: "json" });
  const businessName = (client && client.businessName) || "your business";
  const code = refCode(loc);

  // Write the code -> location index so signup.js resolves a referral with one
  // read. Idempotent, and only ever written for a client who has actually opened
  // their own signed page (i.e. someone about to share the link).
  try {
    await blobsStore("refcodes").setJSON(code, { locationId: loc, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[refer] refcode index write failed:", e.message);
    // Non-fatal: signup.js falls back to scanning clients.
  }

  // Who has come in on this client's code?
  let referred = [];
  try {
    const { blobs } = await clientsStore.list();
    const all = await Promise.all(blobs.map((b) => clientsStore.get(b.key, { type: "json" }).catch(() => null)));
    referred = all.filter((c) => c && c.referredBy === loc);
  } catch (e) {
    console.error("[refer] list failed:", e.message);
  }
  const joined = referred.length;
  const subscribed = referred.filter((c) => c.subscriptionStatus === "active").length;

  const base = process.env.URL || "https://treyv1.netlify.app";
  const shareUrl = `${base}/signup.html?ref=${encodeURIComponent(code)}`;
  // Pre-written so there's nothing for them to compose — they just pick a contact.
  const shareText =
    `I've been using Trey to get more Google reviews - it's a little tap card, ` +
    `the customer taps it and it takes them straight to the review page. ` +
    `Worth a look if you want more reviews without the chasing. ` +
    `This link gives you a 30-day free trial instead of the usual 14: ${shareUrl}`;
  const waHref = "https://wa.me/?text=" + encodeURIComponent(shareText);

  const rowsHtml = referred.length
    ? referred
        .slice()
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .map((c) => {
          const on = c.subscriptionStatus === "active";
          return `<div class="row"><span>${escapeHtml(c.businessName || "A business")}</span>` +
            `<span class="chip ${on ? "on" : "wait"}">${on ? "Free month earned" : "On trial"}</span></div>`;
        })
        .join("")
    : `<div class="none">No one yet. When someone joins on your link they'll show up here.</div>`;

  const inner = `
    <div class="top"><div class="wrap">
      <div class="brand">${MARK}trey</div>
      <h1>Know another business who'd want this?</h1>
      <div class="sub">Send them your link. They get a 30-day free trial instead of 14 &mdash; and when they subscribe, your next month is on us.</div>
    </div></div>
    <div class="main">

      <div class="card">
        <div class="lbl">Your link</div>
        <div class="linkbox">
          <input id="lnk" type="text" readonly value="${escapeHtml(shareUrl)}" onclick="this.select()">
          <button class="btn" type="button" onclick="copyLink()">Copy</button>
        </div>
        <div class="ok" id="ok">Copied &mdash; paste it anywhere.</div>
        <a class="btn wa" href="${escapeHtml(waHref)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      </div>

      <div class="card">
        <div class="lbl">How it works</div>
        <div class="how">
          <div>You send your link to a business you rate.</div>
          <div>They get <b>30 days free</b> instead of 14 &mdash; more time to see it working.</div>
          <div>When they subscribe, <b>your next month is free</b>. No limit on how many.</div>
        </div>
      </div>

      <div class="card">
        <div class="lbl">Your referrals</div>
        <div class="stats">
          <div class="stat"><div class="n">${joined}</div><div class="l">joined on your link</div></div>
          <div class="stat"><div class="n">${subscribed}</div><div class="l">free month${subscribed === 1 ? "" : "s"} earned</div></div>
        </div>
        <div class="rows">${rowsHtml}</div>
      </div>

      <a class="back" href="${base}/.netlify/functions/inbox?loc=${encodeURIComponent(loc)}&k=${encodeURIComponent(params.k)}">&larr; Back to your reviews</a>
      <div class="foot">Free months are applied to your next bill. Questions? <a href="mailto:info@trey.today" style="color:#8091ad">info@trey.today</a></div>
    </div>
    <script>
      function copyLink(){
        var i=document.getElementById('lnk'); i.select(); i.setSelectionRange(0,99999);
        var done=function(){ var o=document.getElementById('ok'); o.style.display='block'; setTimeout(function(){o.style.display='none';},2500); };
        if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(i.value).then(done,function(){try{document.execCommand('copy');done();}catch(e){}}); }
        else { try{document.execCommand('copy');done();}catch(e){} }
      }
    </script>`;

  return shell(`${businessName} — refer a business`, inner);
};
