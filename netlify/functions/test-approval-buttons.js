// Trial helper (admin-gated): sends the quick-reply approval buttons to a phone
// number so you can see them on your phone and test the tap round-trip, BEFORE
// the buttons template is submitted for WhatsApp approval.
//
//   GET /.netlify/functions/test-approval-buttons?to=+447941052034&token=ADMIN
//   (or send the admin token as an Authorization: Bearer header)
//
// The FIRST time it runs it creates the quick-reply Content template in your
// Twilio account (via the Content API, using the Twilio creds already in your
// Netlify env) and caches the resulting ContentSid in a "config" blob — so
// there's nothing to set up in the Twilio Console by hand. You can still
// override it with a TWILIO_APPROVAL_BUTTONS_CONTENT_SID env var if you prefer.
//
// IMPORTANT: the recipient must have messaged the Trey WhatsApp number within
// the last 24 hours first. Quick-reply buttons can be sent unapproved ONLY
// inside that 24-hour session window; outside it, the template needs approval.

const { getStore } = require("@netlify/blobs");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Identity, not a yes/no — see admin-auth.js. Shared so auth can't drift.
const { adminIdentity } = require("./admin-auth.js");

// The quick-reply template. Variables: 1 business, 2 reviewer, 3 rating,
// 4 comment, 5 suggested reply. Button titles contain the words the inbound
// handler (whatsapp-inbound-test.js) matches on: Approve / Edit / Skip.
const TEMPLATE = {
  friendly_name: "trey_review_approval_buttons",
  language: "en",
  variables: { 1: "Business", 2: "Reviewer", 3: "5", 4: "Comment", 5: "Reply" },
  types: {
    "twilio/quick-reply": {
      body: "New review for {{1}}\n\n{{3}}⭐ from {{2}}\n\"{{4}}\"\n\nSuggested reply:\n{{5}}\n\nTap below 👇",
      actions: [
        { id: "approve", title: "Approve" },
        { id: "edit", title: "Edit" },
        { id: "skip", title: "Skip" },
      ],
    },
  },
};

// Return the ContentSid for the buttons template, creating it on first use.
async function getButtonsContentSid() {
  if (process.env.TWILIO_APPROVAL_BUTTONS_CONTENT_SID) {
    return process.env.TWILIO_APPROVAL_BUTTONS_CONTENT_SID;
  }
  const cfg = blobsStore("config");
  const cached = await cfg.get("buttonsContentSid", { type: "json" });
  if (cached && cached.sid) return cached.sid;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const r = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(TEMPLATE),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.sid) {
    throw new Error("template create failed: " + JSON.stringify(j).slice(0, 300));
  }
  await cfg.setJSON("buttonsContentSid", { sid: j.sid, createdAt: new Date().toISOString() });
  return j.sid;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  if (!adminIdentity(event, null, params)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const digits = (params.to || "").replace(/\D/g, ""); // tolerate a "+" that arrived as a space
  if (!digits) return { statusCode: 400, body: JSON.stringify({ error: "pass ?to=+44..." }) };
  const to = "+" + digits;

  let contentSid;
  try {
    contentSid = await getButtonsContentSid();
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "could not get/create buttons template", detail: e.message }) };
  }

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const msgService = process.env.TWILIO_MESSAGING_SERVICE_SID;

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
    return { statusCode: 502, body: JSON.stringify({ error: "Twilio " + resp.status, detail: out, contentSid }) };
  }

  // Give a tap something to act on: a pending mapping + a demo review record.
  const demoReviewId = `test-${Date.now()}`;
  await blobsStore("approvalpending").setJSON(digits, { reviewId: demoReviewId, sentAt: new Date().toISOString(), demo: true });
  await blobsStore("reviews").setJSON(`pending:${demoReviewId}`, {
    reviewId: demoReviewId, businessName: vars["1"], reviewerName: vars["2"], rating: vars["3"],
    comment: vars["4"], replyDraft: vars["5"], status: "pending", demo: true, createdAt: new Date().toISOString(),
  });

  return { statusCode: 200, body: JSON.stringify({ sent: true, to, sid: out.sid, contentSid, demoReviewId }) };
};
