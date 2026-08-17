// twilio-status.js — records what actually happened to a message we sent.
//
// WHY THIS EXISTS (added 17 Aug 2026, from an audit finding)
// ---------------------------------------------------------
// Every Twilio sender in this repo treated HTTP 201 as success. It isn't. 201
// means Twilio ACCEPTED the message for delivery. The two most common WhatsApp
// failures both happen afterwards, asynchronously:
//
//   * error 63016 — freeform message sent outside Meta's 24-hour session
//     window. This is the normal outcome for any message we send to a client
//     who hasn't messaged us recently, which is nearly all of them, and it is
//     exactly what happens today for the activation alert because
//     TWILIO_ACTIVATED_CONTENT_SID has never been set.
//   * ordinary undeliverable — wrong number, no WhatsApp on that number, the
//     recipient blocked the sender.
//
// Neither produced any record anywhere: not in a store, not in admin.html, not
// in the backup. The log said "sent" and the owner's phone stayed silent. That
// is the house defect — a thing that silently does not happen — applied to the
// single most important message the product sends.
//
// Twilio POSTs here on every status transition. We keep the terminal ones.
//
// SETUP: nothing to configure. Senders pass StatusCallback pointing at this
// function, so it starts receiving as soon as it is deployed.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

function rawBody(event) {
  if (!event || !event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function parseBody(event) {
  const out = {};
  try { for (const [k, v] of new URLSearchParams(rawBody(event)).entries()) out[k] = v; } catch (e) {}
  return out;
}

// Same scheme and same reasoning as whatsapp-inbound.js — see the long comment
// there. Without this, anyone could POST fake delivery failures and make a
// working alert look broken (or a broken one look fine).
function candidateUrls(event) {
  const out = [];
  if (process.env.TWILIO_STATUS_CALLBACK_URL) out.push(process.env.TWILIO_STATUS_CALLBACK_URL);
  if (event && event.rawUrl) out.push(event.rawUrl);
  const h = (event && event.headers) || {};
  const host = h["x-forwarded-host"] || h.host || h.Host;
  const path = (event && event.path) || "";
  if (host && path) out.push(`https://${host}${path}${event.rawQuery ? `?${event.rawQuery}` : ""}`);
  return out.filter(Boolean);
}

function signatureValid(event) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const h = (event && event.headers) || {};
  const provided = h["x-twilio-signature"] || h["X-Twilio-Signature"] || "";
  if (!provided) return false;

  const params = parseBody(event);
  const suffix = Object.keys(params).sort().map((k) => k + params[k]).join("");
  for (const url of candidateUrls(event)) {
    try {
      const expected = crypto.createHmac("sha1", token)
        .update(Buffer.from(url + suffix, "utf8")).digest("base64");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(provided, "utf8");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch (e) { /* try the next candidate */ }
  }
  return false;
}

// Statuses worth keeping. Twilio also sends queued/sending/sent, which are
// noise — we only care about where a message ended up.
const TERMINAL = ["delivered", "read", "undelivered", "failed"];
const BAD = ["undelivered", "failed"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  if (!signatureValid(event)) {
    console.error("[twilio-status] REJECTED unsigned/invalid status callback");
    return { statusCode: 403, body: "Forbidden" };
  }

  const p = parseBody(event);
  const sid = String(p.MessageSid || p.SmsSid || "").slice(0, 64);
  const status = String(p.MessageStatus || p.SmsStatus || "").toLowerCase();

  if (!sid || !TERMINAL.includes(status)) {
    // Not an outcome we keep. 200 so Twilio doesn't retry.
    return { statusCode: 200, body: "ok" };
  }

  const record = {
    sid,
    status,
    // To is a phone number — personal data — so store only the last 4 digits.
    // Enough to identify which client this was without holding another copy of
    // everyone's phone number in a third store.
    toTail: String(p.To || "").replace(/\D/g, "").slice(-4),
    errorCode: String(p.ErrorCode || ""),
    errorMessage: String(p.ErrorMessage || "").slice(0, 300),
    at: new Date().toISOString(),
  };

  try {
    await blobsStore("messagestatus").setJSON(sid, record);
  } catch (e) {
    console.error("[twilio-status] could not record status for", sid, e.message);
    // Still 200 — a storage failure is ours, and making Twilio retry won't fix it.
    return { statusCode: 200, body: "ok" };
  }

  if (BAD.includes(status)) {
    // Loud on purpose. A message that never arrived is the failure this whole
    // file exists to make visible. 63016 = outside Meta's 24-hour window, which
    // means a template is needed rather than a freeform send.
    console.error(
      `[twilio-status] MESSAGE NOT DELIVERED — sid=${sid} status=${status} ` +
      `errorCode=${record.errorCode || "(none)"} to=***${record.toTail} ${record.errorMessage}`
    );
  }

  return { statusCode: 200, body: "ok" };
};
