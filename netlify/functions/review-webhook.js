const { getStore } = require("@netlify/blobs");

// Receives an incoming Google review (POSTed by whatever review source feeds
// this endpoint), matches it to a recent NFC tap, looks up the client record,
// generates an AI reply draft, stores it for approval, and sends a short
// WhatsApp alert with a link to the approve page.

const TAP_WINDOW_MINUTES = 60;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Monday (UTC) of the given date's week, as YYYY-MM-DD — the weekly key.
function weekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun .. 6=Sat
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { locationId, reviewerName, rating, comment } = body;
  const reviewId = body.reviewId || `rev_${Date.now()}`;

  if (!locationId) {
    return { statusCode: 400, body: JSON.stringify({ error: "locationId is required" }) };
  }

  // Authenticate the caller. If TREY_WEBHOOK_SECRET is set on Netlify, require
  // it (as the X-Trey-Signature header or a `secret` body field) so nobody who
  // knows a public locationId can forge reviews or trigger WhatsApp sends. If
  // it's unset, allow but warn — so the live flow keeps working until you've
  // added the secret to the upstream caller (whatever posts reviews here), then
  // set the env var.
  const webhookSecret = process.env.TREY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const h = event.headers || {};
    const provided = h["x-trey-signature"] || h["X-Trey-Signature"] || body.secret || "";
    const a = Buffer.from(String(provided)), b = Buffer.from(String(webhookSecret));
    const ok = a.length === b.length && require("crypto").timingSafeEqual(a, b);
    if (!ok) {
      return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
    }
  } else {
    console.warn("[review-webhook] TREY_WEBHOOK_SECRET not set — webhook is unauthenticated. Set it and send it from the upstream caller to lock this down.");
  }

  const tapsStore = blobsStore("taps");
  const clientsStore = blobsStore("clients");
  const statsStore = blobsStore("stats");
  const reviewsStore = blobsStore("reviews");

  // 1. Look up the client record first.
  const client = await clientsStore.get(locationId, { type: "json" });
  if (!client) {
    console.error(`No client onboarded for locationId: ${locationId}`);
    return { statusCode: 404, body: JSON.stringify({ error: "Unknown location" }) };
  }

  // 2. Idempotency: if this reviewId was already processed, don't double-count
  //    or re-alert. (Only possible when the caller sends a stable reviewId; an
  //    auto-generated rev_<timestamp> id is unique per call.)
  if (body.reviewId) {
    const already = await reviewsStore.get(`pending:${reviewId}`, { type: "json" });
    if (already) {
      return { statusCode: 200, body: JSON.stringify({ success: true, deduped: true, reviewId }) };
    }
  }

  // 3. Decide tap-vs-organic now, but DON'T consume the tap yet. All side
  //    effects (tap consume, counters, records) are committed together after
  //    the reply is generated, so a failed run can be retried without
  //    mis-counting or flipping the attribution.
  let source = "Organic Review";
  let tapToConsume = null;
  const tap = await tapsStore.get(locationId, { type: "json" });
  if (tap && !tap.processed) {
    const ageMinutes = (Date.now() - new Date(tap.timestamp).getTime()) / 60000;
    if (ageMinutes >= 0 && ageMinutes <= TAP_WINDOW_MINUTES) {
      source = "Trey Tappy Stand \ud83c\udfb4";
      tapToConsume = tap;
    }
  }

  // 4. Generate the AI reply draft (internal call \u2014 send the shared secret).
  const siteUrl = process.env.URL || "https://treyv1.netlify.app";
  let replyDraft;
  try {
    const replyResponse = await fetch(`${siteUrl}/.netlify/functions/generate-reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trey-Internal": process.env.TREY_TAPPY_SECRET_TOKEN || "",
      },
      body: JSON.stringify({
        businessName: client.businessName,
        businessType: client.businessType,
        voicePerspective: client.voicePerspective,
        publicSignOffName: client.publicSignOffName,
        businessPhone: client.phone,
        reviewerName,
        rating,
        comment,
        source,
      }),
    });

    if (!replyResponse.ok) {
      const errText = await replyResponse.text();
      throw new Error(`generate-reply returned ${replyResponse.status}: ${errText}`);
    }

    const replyData = await replyResponse.json();
    replyDraft = replyData.replyDraft;
  } catch (err) {
    console.error("Error generating reply:", err);
    return { statusCode: 502, body: JSON.stringify({ error: "Failed to generate reply" }) };
  }

  // 5. Commit side effects together, now that the reply exists.
  const isTap = source.startsWith("Trey Tappy");
  if (tapToConsume) {
    await tapsStore.setJSON(locationId, { ...tapToConsume, processed: true });
  }

  const stats = (await statsStore.get(locationId, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };
  if (isTap) stats.tapReviews += 1;
  else stats.organicReviews += 1;
  await statsStore.setJSON(locationId, stats);

  // Period buckets (this week Mon-Sun + this month) for the reports. Wrapped so
  // a tally hiccup never blocks the reply + WhatsApp alert below.
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7); // YYYY-MM
  try {
    const reviewTallyStore = blobsStore("reviewtally");
    const periodKeys = [`${locationId}:week:${weekKey(now)}`, `${locationId}:${monthKey}`];
    for (const pKey of periodKeys) {
      const bucket = (await reviewTallyStore.get(pKey, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };
      if (isTap) bucket.tapReviews += 1;
      else bucket.organicReviews += 1;
      await reviewTallyStore.setJSON(pKey, bucket);
    }
  } catch (err) {
    console.error("Review tally error:", err);
  }

  // Save the pending approval (looked up by approve.js) and the permanent
  // review record (used by the monthly report page). The record key is stored
  // on the pending record so approve.js can write finalReply to the SAME month
  // bucket even if approval happens after a month boundary.
  const recordKey = `review:${locationId}:${monthKey}:${reviewId}`;
  const reviewRecord = {
    reviewId,
    locationId,
    accountId: client.googleAccountId || "",
    businessName: client.businessName,
    reviewerName,
    rating,
    comment,
    source,
    replyDraft,
    status: "pending",
    recordKey,
    createdAt: now.toISOString(),
  };

  await reviewsStore.setJSON(`pending:${reviewId}`, reviewRecord);
  await reviewsStore.setJSON(recordKey, reviewRecord);

  // 6. Send the WhatsApp alert via Twilio — short message, link only.
  const approveUrl =
    `${siteUrl}/.netlify/functions/approve?reviewId=${encodeURIComponent(reviewId)}` +
    `&token=${encodeURIComponent(process.env.TREY_TAPPY_SECRET_TOKEN)}`;

  const messageBody =
    `\u2b50 *New review \u2014 ${client.businessName}* \u2b50\n` +
    `\ud83d\udccc *Via ${source}*\n\n` +
    `*Rating:* ${rating} \u2b50\n` +
    `*Reviewer:* ${reviewerName}\n` +
    `*Review:* "${comment}"\n\n` +
    `\ud83d\udc49 View & approve reply:\n${approveUrl}\n\n` +
    `\u2014 Trey`;

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_WHATSAPP_FROM;
  const contentSid = process.env.TWILIO_APPROVAL_CONTENT_SID;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  // WhatsApp template variables must be single-line (no newlines/tabs, no runs
  // of 4+ spaces) and reasonably short, or Twilio rejects the send.
  const clean = (v, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  // Choose sender: a Messaging Service (if configured) or the WhatsApp number.
  // From and MessagingServiceSid are mutually exclusive.
  const twilioParams = messagingServiceSid
    ? { To: `whatsapp:${client.phone}`, MessagingServiceSid: messagingServiceSid }
    : { To: `whatsapp:${client.phone}`, From: twilioFrom };

  if (contentSid) {
    // Approved template path — delivers reliably outside the 24h session
    // window and renders the "View & approve" CTA button. Variable order must
    // match the template definition in whatsapp-template.json.
    twilioParams.ContentSid = contentSid;
    twilioParams.ContentVariables = JSON.stringify({
      1: clean(client.businessName, 60),
      2: clean(source, 60),
      3: clean(rating, 12),
      4: clean(reviewerName, 60),
      5: clean(comment, 500) || "(no comment left)",
      // Appended verbatim to the button URL's ?reviewId= — pre-encode so any
      // special characters in a Google review id survive the round-trip.
      6: encodeURIComponent(reviewId),
    });
  } else {
    // Fallback: freeform session message. Only delivers if the client has
    // messaged the Trey number within the last 24 hours.
    twilioParams.Body = messageBody;
  }

  try {
    const twilioResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(twilioParams),
      }
    );

    if (!twilioResp.ok) {
      const errText = await twilioResp.text();
      throw new Error(`Twilio returned ${twilioResp.status}: ${errText}`);
    }
  } catch (err) {
    console.error("Error sending WhatsApp message:", err);
    return { statusCode: 502, body: JSON.stringify({ error: "Failed to send WhatsApp message" }) };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, source, reviewId }),
  };
};
