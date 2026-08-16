// TEST HELPER (admin-gated) — fires a review ALERT (the single-link flow) at a
// phone number so you can walk the real approve page end to end without a live
// Google review. Delete this file once you've finished testing.
//
//   GET /.netlify/functions/test-review-alert?to=+447941052034&token=ADMIN_TOKEN
//        [&loc=trey-demo]        which client's data the alert belongs to
//        [&reviewId=demo-0]      alert on a SPECIFIC existing review
//
// With loc/reviewId it alerts on a real review that already lives in that
// client's Inbox — so tapping the link opens that review's approve page, and
// "Back to your reviews" shows the client's full list. Default loc is
// "trey-demo" (the seeded showcase). If no matching review is found it falls
// back to creating a synthetic one so the helper still works standalone.
//
// The recipient must have messaged the Trey WhatsApp number within the last 24h
// — the alert is sent as a free-form session message, so no template is needed.

const { getStore } = require("@netlify/blobs");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Identity, not a yes/no — see admin-auth.js. Shared so auth can't drift.
const { adminIdentity } = require("./admin-auth.js");

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  if (!adminIdentity(event, null, params)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const digits = (params.to || "").replace(/\D/g, "");
  if (!digits) return { statusCode: 400, body: JSON.stringify({ error: "pass ?to=+44..." }) };
  const to = "+" + digits;

  if (!process.env.TREY_REPORT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: "TREY_REPORT_SECRET not set" }) };

  const base = process.env.URL || "https://treyv1.netlify.app";
  const loc = (params.loc || "trey-demo").trim();
  const reviewsStore = blobsStore("reviews");

  // Prefer a real, existing review so the alert links into the client's real
  // Inbox. Order: an explicit reviewId, then the first waiting review in loc,
  // then a synthetic fallback.
  let record = null;
  if (params.reviewId) {
    record = await reviewsStore.get(`pending:${params.reviewId}`, { type: "json" });
  }
  if (!record) {
    try {
      const { blobs } = await reviewsStore.list({ prefix: `review:${loc}:` });
      const recs = (await Promise.all(blobs.map((b) => reviewsStore.get(b.key, { type: "json" })))).filter(Boolean);
      record = recs
        .filter((r) => r.status !== "approved" && r.status !== "skipped")
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0] || null;
    } catch (e) {
      console.error("[test-review-alert] list failed:", e.message);
    }
  }
  if (!record) {
    // Synthetic fallback — create a demo pending review under `loc`.
    const now = new Date();
    const reviewId = `test-${now.getTime()}`;
    const monthKey = now.toISOString().slice(0, 7);
    record = {
      reviewId, locationId: loc, businessName: "Mik's Cars", reviewerName: "Sarah J",
      rating: 5, comment: "Brilliant service, car was ready early!",
      replyDraft: "Hi Sarah, thanks so much — really glad we got you sorted quickly. See you next time! — Mik",
      status: "pending", recordKey: `review:${loc}:${monthKey}:${reviewId}`,
      createdAt: now.toISOString(), demo: true,
    };
    await reviewsStore.setJSON(`pending:${reviewId}`, record);
    await reviewsStore.setJSON(record.recordKey, record);
  }

  const snippet = (t, max = 140) => {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, "").trim() + "…" : s;
  };
  const hasComment = record.comment && String(record.comment).trim();
  const reviewLine = hasComment ? `"${snippet(record.comment)}"` : "(rating only — no written review)";

  const approveSig = require("crypto").createHmac("sha256", process.env.TREY_REPORT_SECRET).update("approve:" + String(record.reviewId)).digest("hex").slice(0, 32);
  const approveUrl = `${base}/.netlify/functions/approve?reviewId=${encodeURIComponent(record.reviewId)}&sig=${approveSig}`;
  // Mirror the production alert (review-webhook): short review preview + link,
  // no AI draft — the full review and the draft live on the approve page.
  const body =
    `⭐ *New review — ${record.businessName || "your business"}* ⭐\n` +
    `📌 *Via ${record.source || "Google"}*\n\n` +
    `*Rating:* ${record.rating} ⭐\n` +
    `*Reviewer:* ${record.reviewerName || "A customer"}\n` +
    `*Review:* ${reviewLine}\n\n` +
    `👉 Read it all & approve your reply:\n${approveUrl}`;

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

  return { statusCode: 200, body: JSON.stringify({ sent: true, to, loc, reviewId: record.reviewId, hasComment: !!hasComment, approveUrl, sid: out.sid }) };
};
