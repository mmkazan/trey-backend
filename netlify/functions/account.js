const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

// Normalise a phone number to E.164 for Twilio. See signup.js for the full
// story: a display-formatted number ("+44 7933189216") is a hard Twilio failure.


// The client-facing ACCOUNT DETAILS page — a login-free settings form letting a
// business owner update the handful of profile fields that are safe for them to
// change themselves. Same signed-key model as inbox.js / report.js: access needs
// k = HMAC-SHA256(locationId, TREY_REPORT_SECRET) truncated, so the link is
// private per client, needs no password, and is safe to send over WhatsApp.
//
//   GET  /account?loc=<locationId>&k=<key>   -> the pre-filled settings form
//   POST /account   (body: loc, k, <whitelisted fields>)  -> save + confirm
//
// SECURITY: only the whitelisted fields below can ever be written through this
// endpoint. The Google connection (placeId / googleAccountId), billing state
// (subscriptionStatus / trial fields) and rating baselines are deliberately NOT
// editable here — those change the review pipeline or billing and must go
// through the admin (contact info@trey.today). The signed key gates writes at
// exactly the same trust level as viewing the inbox.

const KEY_LEN = 32;
const INDIGO = "#4338ca";
const INDIGO2 = "#4f46e5";
const ACCENT = "#6366f1";
const SLATE = "#0f172a";
const SUPPORT_EMAIL = "info@trey.today";

// Fields a client may edit themselves, with light validation. Anything not in
// this map is ignored, no matter what the POST body contains.
const EDITABLE = {
  businessName:      { label: "Business name",                 type: "text",  max: 120 },
  businessType:      { label: "Type of business",              type: "text",  max: 80  },
  phone:             { label: "WhatsApp number for approvals",  type: "tel",   max: 24  },
  email:             { label: "Contact email",                 type: "email", max: 160 },
  publicSignOffName: { label: "Replies signed off by",         type: "text",  max: 60  },
  voicePerspective:  { label: "Reply voice",                   type: "voice"           },
  logoUrl:           { label: "Logo image URL",                type: "url",   max: 500 },
};

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}
const { linkKey, linkValid, secretConfigured } = require("./link-keys");
const { toE164 } = require("./phone");

// This page's own purpose. Its key opens THIS page and nothing else — see
// link-keys.js for why. A key minted for another page will not validate here.
const LINK_PURPOSE = "account";

// Kept as a thin wrapper so existing call sites read the same. All the real
// work (constant-time compare, fail-closed on an unset secret, byte-length
// check before timingSafeEqual) lives in link-keys.js.
function keyValid(locationId, provided) {
  return linkValid(LINK_PURPOSE, locationId, provided);
}
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Coerce a submitted value for one field into a clean, safe value to store,
// or null to mean "leave whatever's there / clear it".
function cleanField(name, raw) {
  const spec = EDITABLE[name];
  if (!spec) return undefined;
  let v = String(raw == null ? "" : raw).trim();
  if (spec.type === "voice") {
    // Only two shapes matter downstream: "Individual" (I) vs anything else (we).
    return /^ind/i.test(v) ? "Individual" : "Team";
  }
  if (spec.max) v = v.slice(0, spec.max);
  if (spec.type === "url") {
    if (v === "") return "";                       // allow clearing the logo
    if (!/^https:\/\/\S+$/i.test(v)) return null;  // https only — no js:/data:/http
    return v;
  }
  if (spec.type === "email") {
    if (v === "") return "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
    return v;
  }
  if (spec.type === "tel") {
    // Keep digits and a single leading +; approve.js strips to digits anyway.
    v = v.replace(/[^\d+]/g, "");
    v = v.replace(/(?!^)\+/g, "");
    return v;
  }
  return v;
}

const MARK = `<svg viewBox="0 0 100 100" aria-hidden="true"><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.30"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.58"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="currentColor"/><rect x="46" y="39" width="8" height="25" rx="2" fill="currentColor"/></svg>`;

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
  .brand svg{height:30px;width:30px;display:block;color:#eef2ff}
  h1{font-size:21px;margin:14px 0 2px;letter-spacing:-.4px}
  .sub{font-size:13.5px;opacity:.9}
  .main{padding:18px 16px 60px}
  .card{background:#f3f8ff;border:1px solid #cfe0f6;border-radius:14px;padding:16px 15px;margin-bottom:14px}
  label{display:block;font-size:13px;font-weight:700;color:#334155;margin:0 0 5px}
  .hint{font-weight:500;color:#64748b;font-size:12px;margin-top:4px}
  input,select{width:100%;font-size:15px;padding:11px 12px;border:1px solid #cfe0f6;border-radius:10px;background:#fff;color:${SLATE};font-family:inherit}
  input:focus,select:focus{outline:none;border-color:${ACCENT};box-shadow:0 0 0 3px rgba(99,102,241,.15)}
  .field{margin-bottom:15px}
  .field:last-child{margin-bottom:0}
  .save{width:100%;background:${INDIGO};color:#fff;border:0;border-radius:11px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}
  .save:active{transform:translateY(1px)}
  .locked{font-size:12.5px;color:#64748b;line-height:1.55;background:#eef3fc;border:1px dashed #b6cdf0;border-radius:12px;padding:13px 14px}
  .locked b{color:${SLATE}}
  .locked a{color:${INDIGO2};font-weight:700}
  .sec{font-size:12px;letter-spacing:.07em;color:#64748b;margin:20px 4px 10px;font-weight:700}
  .xlink{display:block;text-align:center;margin-top:22px;color:${ACCENT};font-weight:700;text-decoration:none;font-size:14px}
  .foot{text-align:center;color:#8091ad;font-size:12px;margin-top:26px}
  .saved{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:12px;padding:14px 15px;font-size:14px;font-weight:600;text-align:center;margin-bottom:14px}
  .errbox{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:12px;padding:13px 15px;font-size:13.5px;margin-bottom:14px}
</style></head><body>
  <div class="top"><div class="wrap"><div class="brand">${MARK}trey</div>
    <h1>Account details</h1><div class="sub">Update your business info &mdash; changes apply straight away.</div>
  </div></div>
  <div class="main">${inner}</div>
</body></html>`,
  };
}

function noticePage(statusCode, title, message) {
  const r = shell(title, `<div class="card" style="text-align:center">
    <strong style="color:${SLATE}">${escapeHtml(title)}</strong><br><span style="color:#64748b;font-size:14px">${escapeHtml(message)}</span></div>`);
  r.statusCode = statusCode;
  return r;
}

function voiceSelect(current) {
  const isInd = String(current || "").toLowerCase() === "individual";
  return `<select name="voicePerspective" id="voicePerspective">
    <option value="Individual"${isInd ? " selected" : ""}>Just me (reply as "I")</option>
    <option value="Team"${isInd ? "" : " selected"}>A team (reply as "we")</option>
  </select>`;
}

function formPage(loc, k, client, opts) {
  opts = opts || {};
  const v = (name) => escapeHtml(client[name]);
  const fieldRow = (name, extraHint) => {
    const spec = EDITABLE[name];
    if (spec.type === "voice") {
      return `<div class="field"><label for="${name}">${spec.label}</label>${voiceSelect(client[name])}
        <div class="hint">${escapeHtml(extraHint || "How your replies read — as a person or as a team.")}</div></div>`;
    }
    const ph = name === "logoUrl" ? ' placeholder="https://..."' : "";
    return `<div class="field"><label for="${name}">${spec.label}</label>
      <input type="${spec.type}" name="${name}" id="${name}" value="${v(name)}" maxlength="${spec.max}"${ph}>
      ${extraHint ? `<div class="hint">${escapeHtml(extraHint)}</div>` : ""}</div>`;
  };

  const banner = opts.saved
    ? `<div class="saved">&#10003; Saved. Your details are updated.</div>`
    : (opts.error ? `<div class="errbox">${escapeHtml(opts.error)}</div>` : "");

  const placeId = client.placeId || client.googleAccountId || "";
  const base = process.env.URL || "https://treyv1.netlify.app";
  const inboxUrl = `${base}/.netlify/functions/inbox?loc=${encodeURIComponent(loc)}&k=${encodeURIComponent(k)}`;

  const inner = `
    ${banner}
    <form method="POST" action="/.netlify/functions/account" autocomplete="off">
      <input type="hidden" name="loc" value="${escapeHtml(loc)}">
      <input type="hidden" name="k" value="${escapeHtml(k)}">
      <div class="card">
        ${fieldRow("businessName", "Shown at the top of your reports and reviews.")}
        ${fieldRow("businessType", "e.g. garage, café, salon — helps Trey word replies naturally.")}
      </div>
      <div class="sec">How Trey reaches &amp; signs off for you</div>
      <div class="card">
        ${fieldRow("phone", "The number your review approvals are sent to on WhatsApp. Include the country code, e.g. +44…")}
        ${fieldRow("email", "Where your monthly report and any account emails go.")}
        ${fieldRow("publicSignOffName", "The name reviewers see at the end of each reply, e.g. Mik.")}
        ${fieldRow("voicePerspective")}
      </div>
      <div class="sec">Branding</div>
      <div class="card">
        ${fieldRow("logoUrl", "A direct https:// link to your logo — appears on your monthly report. Leave blank for none.")}
      </div>
      <button type="submit" class="save">Save changes</button>
    </form>

    <div class="sec">Managed by Trey</div>
    <div class="locked">
      Your <b>Google connection</b>${placeId ? ` (<code>${escapeHtml(String(placeId))}</code>)` : ""}, your <b>subscription &amp; billing</b>, and your <b>free-trial status</b> are looked after on our side, so they're not editable here.
      Need to change one of those, move Trey to a different location, or anything else? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll sort it.
    </div>

    <a class="xlink" href="${escapeHtml(inboxUrl)}">&larr; Back to your reviews</a>
    <div class="foot">Powered by Trey</div>`;
  return shell("Account details — Trey", inner);
}

// Parse an application/x-www-form-urlencoded (or JSON) POST body into a flat map.
function parseBody(event) {
  const raw = event.body || "";
  const ct = ((event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  const out = {};
  const sp = new URLSearchParams(raw);
  for (const [key, val] of sp.entries()) out[key] = val;
  return out;
}

exports.handler = async (event) => {
  if (!process.env.TREY_REPORT_SECRET) return noticePage(500, "Not available", "This isn't set up yet. Please try again later.");

  if (event.httpMethod === "POST") {
    const body = parseBody(event);
    const loc = body.loc;
    const k = body.k;
    if (!loc || !keyValid(loc, k)) return noticePage(403, "Link expired", "This link isn't valid any more. Please use the most recent link from Trey.");

    const clientsStore = blobsStore("clients");
    const existing = await clientsStore.get(loc, { type: "json" });
    if (!existing) return noticePage(404, "Account not found", "We couldn't find this account. Please use the most recent link from Trey.");

    const patch = {};
    const errors = [];
    for (const name of Object.keys(EDITABLE)) {
      if (!(name in body)) continue;             // field not submitted → leave as-is
      const cleaned = cleanField(name, body[name]);
      if (cleaned === null) { errors.push(`"${EDITABLE[name].label}" doesn't look right — please check it.`); continue; }
      if (cleaned !== undefined) patch[name] = cleaned;
    }

    if (errors.length) {
      // Re-render with the attempted values so nothing the owner typed is lost.
      const preview = { ...existing };
      for (const name of Object.keys(EDITABLE)) if (name in body) preview[name] = body[name];
      return formPage(loc, k, preview, { error: errors[0] });
    }

    // Phone is stored in E.164 — no spaces, no brackets. "+44 7933 189216" is
    // perfectly readable but Twilio rejects it outright (21211), and the owner
    // would never find out: their review alerts would just silently stop.
    // Same normalisation signup.js applies on write.
    if (typeof patch.phone === "string" && patch.phone) patch.phone = toE164(patch.phone);

    // Re-read immediately before the write and merge onto the FRESHEST copy, not
    // the one read at the top of the handler. A stripe-webhook status write (or a
    // tap activation stamping trialStartedAt) can land while the owner fills in
    // this form; taking the protected fields from `fresh` preserves it, where
    // taking them from the stale `existing` would silently revert it. The owner
    // still cannot edit protected fields — they are overwritten from `fresh`.
    // (2026-08-18 security review, H2.)
    const fresh = (await clientsStore.get(loc, { type: "json" })) || existing;
    const record = { ...fresh, ...patch, updatedAt: new Date().toISOString() };
    // Belt-and-braces: never let this path touch protected fields.
    for (const guarded of ["locationId", "placeId", "googleAccountId", "subscriptionStatus", "trialStartsOnTap", "trialStartedAt", "standMode", "initialGoogleRating", "initialReviewCount", "token"]) {
      record[guarded] = fresh[guarded];
      if (record[guarded] === undefined) delete record[guarded];
    }
    record.locationId = fresh.locationId || loc;
    await clientsStore.setJSON(loc, record);
    return formPage(loc, k, record, { saved: true });
  }

  // GET → render the pre-filled form.
  const params = event.queryStringParameters || {};
  const loc = params.loc;
  const k = params.k;
  if (!loc) return noticePage(400, "Account unavailable", "This link is missing a location.");
  if (!keyValid(loc, k)) return noticePage(403, "Account unavailable", "This link isn't valid or has expired. Please use the most recent link from Trey.");

  const client = await blobsStore("clients").get(loc, { type: "json" });
  if (!client) return noticePage(404, "Account not found", "We couldn't find this account. Please use the most recent link from Trey.");

  return formPage(loc, k, client, {});
};
