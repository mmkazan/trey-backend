const { getStore } = require("@netlify/blobs");
const { toE164 } = require("./phone");

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

  // reviewId becomes part of a BLOB KEY (`pending:<id>` and
  // `review:<loc>:<month>:<id>`). Unvalidated, a caller holding the webhook
  // secret could write to arbitrary keys in the reviews store, including
  // overwriting another location's records. Constrain it to the shape Google
  // actually uses before it is ever concatenated into a key.
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(reviewId))) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid reviewId" }) };
  }
  // Bound the free-text fields too: `comment` goes straight into the Gemini
  // prompt (cost + prompt-injection surface) and `rating` is rendered.
  if (comment != null && String(comment).length > 4000) {
    return { statusCode: 400, body: JSON.stringify({ error: "Comment too long" }) };
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
  //
  //    FIXED 17 Aug 2026 — this guard and the retry guard used to cancel each
  //    other out, and the review alert was the thing that got lost.
  //
  //    The pending record was written BEFORE the Twilio send. So: run 1 wrote
  //    the record, the send failed, we returned 502, and fetch-reviews.mjs
  //    correctly declined to mark the review seen. Fifteen minutes later the
  //    poller retried — and this guard found the record run 1 had written,
  //    returned `deduped: true`, and fetch-reviews marked the review seen and
  //    counted it as sent. The owner never got the alert, the log said it was
  //    sent, and the review was excluded from every future poll.
  //
  //    A record only means "handled" once the alert actually went out, which is
  //    what alertSentAt records. A record without it means the side effects were
  //    committed but the message never left — so resend, and ONLY resend: the
  //    tap, the counters and the draft must not be redone.
  let priorRecord = null;
  if (body.reviewId) {
    const already = await reviewsStore.get(`pending:${reviewId}`, { type: "json" });
    if (already && already.alertSentAt) {
      return { statusCode: 200, body: JSON.stringify({ success: true, deduped: true, reviewId }) };
    }
    if (already) {
      priorRecord = already;
      console.warn(`[review-webhook] ${reviewId} was committed but never alerted — resending only.`);
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
  if (priorRecord) {
    // Resend path: keep the draft already saved. Regenerating would spend
    // another Gemini call and could hand the owner a different reply than the
    // one sitting in their inbox — and if generation failed here we would 502
    // again and the alert would never be resent at all.
    replyDraft = priorRecord.replyDraft;
  } else try {
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
  //
  // Every mutation below is guarded by `!priorRecord`. On a resend these have
  // already happened, and repeating them would consume the tap twice and count
  // the same review twice in the stats the customer's report is built from.
  const isTap = source.startsWith("Trey Tappy");
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7); // YYYY-MM

  // Save the pending approval (looked up by approve.js) and the permanent review
  // record (used by the monthly report page). The record key is stored on the
  // pending record so approve.js can write finalReply to the SAME month bucket
  // even if approval happens after a month boundary.
  const recordKey = priorRecord ? priorRecord.recordKey : `review:${locationId}:${monthKey}:${reviewId}`;
  const reviewRecord = priorRecord ? { ...priorRecord } : {
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
    // Null until the WhatsApp actually leaves. The idempotency guard at the top
    // keys off this, so it is the difference between "handled" and "half done".
    alertSentAt: null,
  };

  // COMMIT ORDER (2026-08-18 security review, M5/M7). The pending record is the
  // idempotency anchor — the guard at the top of this handler resends-only when
  // it finds a record with no alertSentAt. It MUST be written BEFORE the tap is
  // consumed and the counters are incremented. Previously it was written last:
  // if the function died after consuming the tap (processed:true) but before
  // writing the record, the 15-minute retry found no priorRecord, saw the tap
  // already processed, re-derived source as "Organic", and re-incremented the
  // counters — double-counting the review and permanently flipping its
  // attribution in the customer's report. Writing the anchor first means a crash
  // anywhere below re-enters the resend-only path: at worst one review is
  // under-counted by one, and the tap-vs-organic attribution is never corrupted.
  if (!priorRecord) {
    await reviewsStore.setJSON(`pending:${reviewId}`, reviewRecord);
    await reviewsStore.setJSON(recordKey, reviewRecord);
  }

  if (!priorRecord && tapToConsume) {
    await tapsStore.setJSON(locationId, { ...tapToConsume, processed: true });
  }

  if (!priorRecord) {
    const stats = (await statsStore.get(locationId, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };
    if (isTap) stats.tapReviews += 1;
    else stats.organicReviews += 1;
    await statsStore.setJSON(locationId, stats);
  }

  // Period buckets (this week Mon-Sun + this month) for the reports. Wrapped so
  // a tally hiccup never blocks the reply + WhatsApp alert below.
  if (!priorRecord) try {
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

  // 6. Send the WhatsApp alert via Twilio — short message, link only.
  //
  // HONOUR THE OPT-OUT. Until 17 Aug this function checked no opt-out at all —
  // not `reportsOptOut`, not `nudgesOptOut`, not the `suppressed` list. Every
  // other sender checked; this one, the most frequent message Trey sends, did
  // not. So a client who replied STOP kept receiving review alerts while
  // whatsapp-inbound.js told them "you won't get any more messages from Trey".
  // The promise was false, and failing to honour an opt-out is the classic PECR
  // enforcement trigger.
  //
  // The review is still RECORDED and the reply still DRAFTED — only the WhatsApp
  // is suppressed. Their inbox link keeps working, so nothing is lost; they just
  // have to come and look. That is the honest meaning of "messages off".
  const optedOut = client.reportsOptOut === true || client.nudgesOptOut === true;
  if (optedOut) {
    const record = { ...reviewRecord, alertSentAt: null, alertSuppressed: "opted-out" };
    await reviewsStore.setJSON(`pending:${reviewId}`, record);
    await reviewsStore.setJSON(recordKey, record);
    console.warn(`[review-webhook] ${locationId} has opted out — review stored, alert suppressed.`);
    return { statusCode: 200, body: JSON.stringify({ success: true, reviewId, alert: "suppressed: opted out" }) };
  }

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

  // ADDED 17 Aug 2026. Twilio returns 201 on ACCEPT, not on delivery — and the
  // two most common WhatsApp failures (error 63016, outside Meta's 24-hour
  // window; and ordinary undeliverable) both happen asynchronously, AFTER that
  // 201. Nothing anywhere recorded them, so "sent" in our logs and "arrived on
  // the owner's phone" were completely different claims. This callback closes
  // that gap: twilio-status.js writes the real outcome to the `messagestatus`
  // store, keyed by message SID.
  twilioParams.StatusCallback = `${siteUrl}/.netlify/functions/twilio-status`;

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
      // Truncated: the request Body we sent contains the signed approve link,
      // and Twilio's error payload can echo request fields back.
      throw new Error(`Twilio returned ${twilioResp.status}: ${String(errText).slice(0, 200)}`);
    }

    // The alert is away — NOW the record counts as handled. Until this stamp
    // exists, the guard at the top of this function treats the review as
    // half-done and resends rather than deduping it into silence.
    //
    // Note this is a 202-from-Twilio, not a delivery confirmation: Twilio
    // returns 201 and can still fail asynchronously (error 63016, outside
    // Meta's 24-hour window, is the common one). That is what the StatusCallback
    // above is for — twilio-status.js records the real outcome.
    let twilioSid_ = "";
    try { twilioSid_ = ((await twilioResp.clone().json()) || {}).sid || ""; } catch (e) {}
    const sentRecord = { ...reviewRecord, alertSentAt: new Date().toISOString(), alertSid: twilioSid_ };
    await reviewsStore.setJSON(`pending:${reviewId}`, sentRecord);
    await reviewsStore.setJSON(recordKey, sentRecord);
  } catch (err) {
    console.error(
      `Error sending WhatsApp message for ${reviewId} — the record stays unstamped so the next poll resends it:`,
      err.message
    );
    return { statusCode: 502, body: JSON.stringify({ error: "Failed to send WhatsApp message" }) };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, source, reviewId }),
  };
};
