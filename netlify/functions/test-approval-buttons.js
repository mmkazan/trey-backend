// Trial helper (admin-gated): sends the quick-reply approval buttons to a phone
// number so you can see them on your phone and test the tap round-trip, BEFORE
// the buttons template is submitted for WhatsApp approval.
//
//   GET /.netlify/functions/test-approval-buttons?to=+447941052034
//   (with the admin token in an Authorization: Bearer header, or ?token=)
//
// IMPORTANT: the recipient must have messaged the Trey WhatsApp number within
// the last 24 hours first. Quick-reply buttons can be sent unapproved ONLY
// inside that 24-hour session window; outside it, the template must be approved.

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

  const to = (params.to || "").replace(/[^\d+]/g, "");
  if (!to) return { statusCode: 400, body: JSON.stringify({ error: "pass ?to=+44..." }) };

  const contentSid = process.env.TWILIO_APPROVAL_BUTTONS_CONTENT_SID;
  if (!contentSid) {
    return { statusCode: 500, body: JSON.stringify({ error: "TWILIO_APPROVAL_BUTTONS_CONTENT_SID is not set" }) };
  }

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const msgService = process.env.TWILIO_MESSAGING_SERVICE_SID;

  // Demo review content for the button message's variables.
  const vars = {
    1: "Mik's Cars",
    2: "Sarah J",
    3: "5",
    4: "Brilliant service, car was ready early!",
    5: "Hi Sarah, thanks so much — really glad we got you sorted quickly. See you next time! — Mik",
  };

  const twilioParams = msgService
    ? { To: `whatsapp:${to}`, MessagingServiceSid: msgService }
    : { To: `whatsapp:${to}`, From: from };
  twilioParams.ContentSid = contentSid;
  twilioParams.ContentVariables = JSON.stringify(vars);

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

  // Give the tap something to act on: a pending mapping + a demo review record.
  const demoReviewId = `test-${Date.now()}`;
  await blobsStore("approvalpending").setJSON(to, { reviewId: demoReviewId, sentAt: new Date().toISOString(), demo: true });
  await blobsStore("reviews").setJSON(`pending:${demoReviewId}`, {
    reviewId: demoReviewId, businessName: vars["1"], reviewerName: vars["2"], rating: vars["3"],
    comment: vars["4"], replyDraft: vars["5"], status: "pending", demo: true, createdAt: new Date().toISOString(),
  });

  return { statusCode: 200, body: JSON.stringify({ sent: true, to, sid: out.sid, demoReviewId }) };
};
