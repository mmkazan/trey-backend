// TEST HELPER (admin-gated) — fires a fake review ALERT (the single-link flow)
// at a phone number so you can walk the real approve page end to end without a
// live Google review. Delete this file once you've finished testing.
//
//   GET /.netlify/functions/test-review-alert?to=+447941052034&token=ADMIN_TOKEN
//
// The recipient must have messaged the Trey WhatsApp number within the last 24h
// — the alert is sent as a free-form session message, so no template is needed.

const { getStore } = require("@netlify/blobs");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

function adminAuthorized(event, params) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim() || (params && params.token) || "";
  const expected = process.env.CLIENT_ADMIN_TOKEN || "";
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && require("crypto").timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  if (!adminAuthorized(event, params)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const digits = (params.to || "").replace(/\D/g, "");
  if (!digits) return { statusCode: 400, body: JSON.stringify({ error: "pass ?to=+44..." }) };
  const to = "+" + digits;

  const approveToken = process.env.TREY_TAPPY_SECRET_TOKEN;
  if (!approveToken) return { statusCode: 500, body: JSON.stringify({ error: "TREY_TAPPY_SECRET_TOKEN not set" }) };

  // Create a demo pending review (+ its permanent record) so the approve page
  // has something real to load.
  const base = process.env.URL || "https://treyv1.netlify.app";
  const now = new Date();
  const reviewId = `test-${now.getTime()}`;
  const monthKey = now.toISOString().slice(0, 7);
  const record = {
    reviewId,
    locationId: "trey-test",
    businessName: "Mik's Cars",
    reviewerName: "Sarah J",
    rating: 5,
    comment: "Brilliant service, car was ready early!",
    replyDraft: "Hi Sarah, thanks so much — really glad we got you sorted quickly. See you next time! — Mik",
    status: "pending",
    recordKey: `review:trey-test:${monthKey}:${reviewId}`,
    createdAt: now.toISOString(),
    demo: true,
  };
  const reviewsStore = blobsStore("reviews");
  await reviewsStore.setJSON(`pending:${reviewId}`, record);
  await reviewsStore.setJSON(record.recordKey, record);

  const approveUrl = `${base}/.netlify/functions/approve?reviewId=${reviewId}&token=${encodeURIComponent(approveToken)}`;
  const body =
    `New review for ${record.businessName}\n\n` +
    `${record.rating}⭐ from ${record.reviewerName}\n"${record.comment}"\n\n` +
    `Suggested reply:\n${record.replyDraft}\n\n` +
    `Review & respond 👉 ${approveUrl}`;

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const msgService = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const twilioParams = msgService
    ? { To: `whatsapp:${to}`, MessagingServiceSid: msgService, Body: body }
    : { To: `whatsapp:${to}`, From: from, Body: body };

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(twilioParams),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: "Twilio " + resp.status, detail: out }) };
  }

  return { statusCode: 200, body: JSON.stringify({ sent: true, to, reviewId, approveUrl, sid: out.sid }) };
};
