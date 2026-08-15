const { getStore } = require("@netlify/blobs");

// Normalise a stored phone number to E.164 for Twilio.
//
// WHY — 15 Aug, Raven Holistics' first real review alert died on Twilio 21211,
// "The 'To' number whatsapp:+44 7933189216 is not a valid phone number." The
// self-serve signup form formats numbers for READING ("+44 7933189216"), and
// that single space is enough for Twilio to reject the send. Every outbound
// WhatsApp to a self-serve signup was affected; it only surfaced now because
// Naomi is the first. Admin-created clients had numbers typed without a space.
//
// Normalising at SEND time as well as on write means records already saved with
// a space are fixed too, with no data migration.
function toE164(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const d = raw.replace(/[^\d]/g, "");
  if (!d) return "";
  if (raw.startsWith("+")) return "+" + d;   // already international — trust it
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith("0")) return "+44" + d.slice(1);  // UK national
  if (d.startsWith("44")) return "+" + d;
  return "+" + d;
}


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

// A short, single-line preview of a review for the WhatsApp nudge. The full
// review AND the AI draft live on the approve page, so the message stays short
// no matter how long the review is. Collapses whitespace (WhatsApp templates
// reject newlines/tabs) and trims on a word boundary with an ellipsis.
function reviewSnippet(text, max = 140) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "").trim() + "…" : t;
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
  // Auto-generated IDs get real randomness (not just a timestamp) so a
  // `pending:<id>` record can't be enumerated/guessed on the approve route.
  const reviewId = body.reviewId || `rev_${Date.now()}_${require("crypto").randomBytes(8).toString("hex")}`;

  if (!locationId) {
    return { statusCode: 400, body: JSON.stringify({ error: "locationId is required" }) };
  }

  // Authenticate the caller with TREY_WEBHOOK_SECRET, sent either as the
  // X-Trey-Signature header or a `secret` body field. Without it, anyone who
  // knows a locationId — which is printed on the stand — could forge reviews,
  // move a client's stats and trigger WhatsApp sends in their name.
  //
  // FAILS CLOSED, changed 15 Aug. This guard used to read:
  //     if (secret) { enforce } else { warn and carry on }
  // and because the env var had never been set, the "else" was the branch that
  // actually ran — this endpoint was publicly writable for weeks and the only
  // trace was one console.warn nobody reads. A missing secret is now a 500, so
  // the failure is loud and safe instead of quiet and open. Same rule
  // stripe-webhook.js already follows.
  const webhookSecret = process.env.TREY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[review-webhook] TREY_WEBHOOK_SECRET is not set — refusing all requests.");
    return { statusCode: 500, body: JSON.stringify({ error: "Webhook not configured" }) };
  }
  {
    const h = event.headers || {};
    const provided = h["x-trey-signature"] || h["X-Trey-Signature"] || body.secret || "";
    // Length check first: timingSafeEqual throws on a length mismatch, and
    // lengths aren't secret.
    const a = Buffer.from(String(provided)), b = Buffer.from(String(webhookSecret));
    const ok = a.length === b.length && require("crypto").timingSafeEqual(a, b);
    if (!ok) {
      console.warn("[review-webhook] rejected a request with a bad or missing signature.");
      return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
    }
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

  // 3b. What have we already said publicly for this business?
  //
  // Every reply used to be drafted in isolation, so the model repeated its own
  // opening and its favourite phrase from the brand voice on every review. Two
  // replies sitting one above the other on Raven Holistics' profile both opened
  // "Thank you so much for your lovely review!" and both named her "tranquil
  // garden treatment room" \u2014 lovely individually, obviously templated together.
  //
  // Prefer finalReply (what was actually published, possibly edited by the
  // owner) over replyDraft. Best-effort: a failure here costs variety, not the
  // reply, so it must never block the alert.
  let recentReplies = [];
  try {
    const { blobs } = await reviewsStore.list({ prefix: `review:${locationId}:` });
    const recs = (await Promise.all(
      blobs.slice(-12).map((b) => reviewsStore.get(b.key, { type: "json" }).catch(() => null))
    )).filter(Boolean);
    recentReplies = recs
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map((r) => r.finalReply || r.replyDraft)
      .filter(Boolean)
      .slice(0, 4);
  } catch (e) {
    console.error("[review-webhook] couldn't load recent replies (reply variety may suffer):", e.message);
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
        brandVoice: client.brandVoice,
        businessPhone: client.phone,
        reviewerName,
        rating,
        comment,
        source,
        recentReplies,
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
  // Per-review signature — the approve link only works for this one review
  // (replaces the old shared token). Must match signReview() in approve.js.
  const approveSig = require("crypto")
    .createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update("approve:" + String(reviewId))
    .digest("hex")
    .slice(0, 32);
  const approveUrl =
    `${siteUrl}/.netlify/functions/approve?reviewId=${encodeURIComponent(reviewId)}` +
    `&sig=${approveSig}`;

  const messageBody =
    `\u2b50 *New review \u2014 ${client.businessName}* \u2b50\n` +
    `\ud83d\udccc *Via ${source}*\n\n` +
    `*Rating:* ${rating} \u2b50\n` +
    `*Reviewer:* ${reviewerName}\n` +
    `*Review:* ${comment && comment.trim() ? `"${reviewSnippet(comment)}"` : "(rating only \u2014 no written review)"}\n\n` +
    `\ud83d\udc49 Read it all & approve your reply:\n${approveUrl}\n\n` +
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
    ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
    : { To: `whatsapp:${toE164(client.phone)}`, From: twilioFrom };

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
      5: reviewSnippet(comment, 150) || "(rating only — no written review)",
      // Combined sig + reviewId for the template button's single URL variable.
      // The Twilio template's button URL must be updated to: .../approve?r={{6}}
      6: approveSig + reviewId,
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
