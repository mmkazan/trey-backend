// Client-facing GOOGLE POST approval page (login-free, per-post signed link).
// Shown from the monthly WhatsApp nudge. The owner reads the AI-drafted post,
// tweaks it if they like, and either:
//   • one-tap PUBLISHES it to their Google profile (once the Business Profile
//     API is live — google-api.isEnabled()), or
//   • copies it to paste into their profile themselves (until then).
//
//   GET  /google-post?p=<postId>&sig=<sig>   -> the post + Copy / Approve
//   POST /google-post   (p, sig, summary)     -> publish (or mark copied) + done

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const googleApi = require("./google-api.js");

const KEY_LEN = 32;
const INDIGO = "#4338ca", ACCENT = "#4f46e5", SLATE = "#0f172a";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}
function signPost(postId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update("post:" + String(postId)).digest("hex").slice(0, KEY_LEN);
}
function sigValid(postId, provided) {
  if (!postId || !process.env.TREY_REPORT_SECRET) return false;
  const expected = signPost(postId);
  const got = String(provided || "");
  if (got.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch (e) { return false; }
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function parseBody(event) {
  const raw = event.body || "";
  const ct = ((event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "").toLowerCase();
  if (ct.includes("application/json")) { try { return JSON.parse(raw) || {}; } catch (e) { return {}; } }
  const out = {}; for (const [k, v] of new URLSearchParams(raw).entries()) out[k] = v; return out;
}

const MARK = `<svg viewBox="0 0 100 100" width="30" height="30" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Trey"><rect width="100" height="100" rx="24" fill="#4338ca"/><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.32"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.6"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="#fff"/><rect x="46" y="39" width="8" height="25" rx="2" fill="#fff"/></svg>`;

function page(inner, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Trey — Google Post</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#e4eefc;color:${SLATE}}
  .wrap{max-width:440px;margin:0 auto;padding:20px 16px 48px}
  .brand{display:flex;align-items:center;gap:9px;padding:8px 0 16px;font-weight:800;font-size:17px;letter-spacing:-.3px}
  .card{background:#fff;border:1px solid #f1f5f9;border-radius:16px;padding:18px;box-shadow:0 8px 24px rgba(15,23,42,.05)}
  h1{font-size:18px;margin:0 0 4px}
  .sub{font-size:14px;color:#64748b;margin:0 0 16px}
  label{font-size:13px;font-weight:700;color:#334155}
  textarea{width:100%;margin-top:6px;border:1px solid #e2e8f0;border-radius:14px;padding:14px;font-size:15px;color:#334155;line-height:1.5;font-family:inherit;min-height:150px}
  .btn{display:block;width:100%;text-align:center;border:0;border-radius:12px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;text-decoration:none}
  .primary{background:${INDIGO};color:#fff;margin-top:14px}
  .ghost{background:#eef2ff;color:${INDIGO};margin-top:10px;border:1px solid #d7defe}
  .hint{font-size:12.5px;color:#64748b;margin-top:14px;line-height:1.55;background:#eef3fc;border:1px dashed #b6cdf0;border-radius:12px;padding:12px 14px}
  .ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:12px;padding:14px;font-size:14px;font-weight:600;text-align:center}
  .foot{text-align:center;color:#94a3b8;font-size:12px;margin-top:22px}
</style></head><body><div class="wrap">
  <div class="brand">${MARK}trey</div>
  ${inner}
  <div class="foot">Powered by Trey</div>
</div></body></html>`,
  };
}
function notice(title, msg, code = 200) {
  return page(`<div class="card" style="text-align:center"><h1>${escapeHtml(title)}</h1><p class="sub" style="margin:8px 0 0">${escapeHtml(msg)}</p></div>`, code);
}

exports.handler = async (event) => {
  const params = event.httpMethod === "POST" ? parseBody(event) : (event.queryStringParameters || {});

  // The link arrives in one of two shapes:
  //   ?p=<postId>&sig=<sig>   — explicit, used by the approve form's own POST
  //   ?r=<sig><postId>        — combined, used by the WhatsApp button
  //
  // The combined form exists because a WhatsApp template's URL button takes ONE
  // variable and Meta expects it to be a plain suffix. A variable holding a whole
  // query string ("p=…&sig=…") is a common cause of template rejection, and a URL
  // ending in a bare "?" looks malformed to their reviewer. One opaque token
  // avoids both. approve.js already does exactly this — same pattern, same reason.
  let postId = params.p;
  let sig = params.sig;
  if (!postId && params.r) {
    sig = String(params.r).slice(0, KEY_LEN);
    postId = String(params.r).slice(KEY_LEN);
  }

  if (!postId || !sigValid(postId, sig)) {
    return notice("Link not valid", "This link isn't valid or has expired. Please use the most recent link from your WhatsApp.", 403);
  }

  const postsStore = blobsStore("posts");
  const pending = await postsStore.get(`pending:${postId}`, { type: "json" });
  if (!pending) return notice("Not found", "We couldn't find this post. It may have expired.", 404);

  if (pending.status === "posted" || pending.status === "copied") {
    const done = pending.status === "posted"
      ? "This post is already live on your Google profile. Nothing more to do. ✅"
      : "You've already handled this one. ✅";
    return page(`<div class="card"><div class="ok">${done}</div>
      <div class="hint" style="margin-top:14px">${escapeHtml(pending.summary || "")}</div></div>`);
  }

  // Publishing needs BOTH ids — a client record predating googleAccountId would
  // otherwise show an Approve button that throws. Those fall back to copy/paste.
  const canPublish = googleApi.isEnabled() && !!pending.accountId && !!pending.locationId;

  if (event.httpMethod === "POST") {
    const text = String(params.summary || pending.summary || "").trim();
    try {
      if (canPublish) {
        await googleApi.createLocalPost({ accountId: pending.accountId, locationId: pending.locationId }, text);
        await postsStore.setJSON(`pending:${postId}`, { ...pending, summary: text, status: "posted", postedAt: new Date().toISOString() });
        return page(`<div class="card"><div class="ok">✅ Posted to your Google profile.</div>
          <p class="sub" style="margin-top:14px">Here's what went live:</p>
          <div class="hint">${escapeHtml(text)}</div></div>`);
      }
      // Not live yet — mark as handled so the link doesn't nag.
      await postsStore.setJSON(`pending:${postId}`, { ...pending, summary: text, status: "copied", copiedAt: new Date().toISOString() });
      return page(`<div class="card"><div class="ok">✅ Nice one.</div>
        <p class="sub" style="margin-top:14px">Paste it into your Google profile under <b>Posts</b> and you're done.</p>
        <div class="hint">${escapeHtml(text)}</div>
        <a class="btn ghost" href="https://business.google.com/posts" target="_blank" rel="noopener noreferrer">Open Google Business Profile &rarr;</a></div>`);
    } catch (err) {
      console.error("[google-post] publish failed:", err.message);
      return notice("Couldn't post", "Something went wrong posting to Google. Please try again in a moment, or copy the text and post it yourself.", 500);
    }
  }

  // GET — render the editable post + action.
  const bn = escapeHtml(pending.businessName || "your business");
  const copyBtn = `<button type="button" class="btn ghost" onclick="(function(b){var t=document.getElementById('pt');t.select();document.execCommand&&document.execCommand('copy');navigator.clipboard&&navigator.clipboard.writeText(t.value);b.textContent='Copied ✓';})(this)">Copy the post</button>`;

  const action = canPublish
    ? `<button type="submit" class="btn primary">✓ Approve &amp; post to Google</button>${copyBtn}`
    : `${copyBtn}
       <a class="btn primary" href="https://business.google.com/posts" target="_blank" rel="noopener noreferrer">Open Google to paste it &rarr;</a>
       <div class="hint">Tip: tap <b>Copy the post</b>, then <b>Open Google</b> → <b>Add update</b> → paste → Post. Takes 20 seconds, and it keeps your profile active in Google's eyes. <br><br>Soon Trey will post these for you in one tap — that switches on once your Google connection is approved.</div>
       <input type="hidden" name="_ack" value="1">`;

  return page(`
    <h1 style="margin:0 0 4px">Your ${escapeHtml(pending.month ? "" : "")}Google post — ${bn}</h1>
    <p class="sub">Fresh posts help you show up. Here's one ready to go — tweak it if you like.</p>
    <form method="POST" action="/.netlify/functions/google-post" autocomplete="off">
      <input type="hidden" name="p" value="${escapeHtml(postId)}">
      <input type="hidden" name="sig" value="${escapeHtml(sig)}">
      <div class="card">
        <label for="pt">Your Google post</label>
        <textarea id="pt" name="summary">${escapeHtml(pending.summary || "")}</textarea>
        ${action}
      </div>
    </form>`);
};
