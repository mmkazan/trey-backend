const { getStore } = require("@netlify/blobs");

// Replaces the old Make.com "02 - Review Webhook & Approval" scenario.
// Matches an incoming Google review to a recent NFC tap, looks up the
// client record, generates an AI reply draft, stores it for approval,
// and sends a short WhatsApp alert with a link to the approve page.

const TAP_WINDOW_MINUTES = 10;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
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

  const tapsStore = blobsStore("taps");
  const clientsStore = blobsStore("clients");
  const statsStore = blobsStore("stats");
  const reviewsStore = blobsStore("reviews");

  // 1. Check for a recent, unprocessed tap for this location.
  let source = "Organic Review";
  const tap = await tapsStore.get(locationId, { type: "json" });

  if (tap && !tap.processed) {
    const tapTime = new Date(tap.timestamp).getTime();
    const ageMinutes = (Date.now() - tapTime) / 60000;
    if (ageMinutes >= 0 && ageMinutes <= TAP_WINDOW_MINUTES) {
      source = "Trey Tappy Stand \ud83c\udfb4";
      await tapsStore.setJSON(locationId, { ...tap, processed: true });
    }
  }

  // 2. Look up the client record.
  const client = await clientsStore.get(locationId, { type: "json" });
  if (!client) {
    console.error(`No client onboarded for locationId: ${locationId}`);
    return { statusCode: 404, body: JSON.stringify({ error: "Unknown location" }) };
  }

  // 3. Update simple tap-vs-organic stats.
  const stats = (await statsStore.get(locationId, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };
  if (source.startsWith("Trey Tappy")) {
    stats.tapReviews += 1;
  } else {
    stats.organicReviews += 1;
  }
  await statsStore.setJSON(locationId, stats);

  // 4. Generate the AI reply draft by calling the existing generate-reply function.
  const siteUrl = process.env.URL || "https://treyv1.netlify.app";
  let replyDraft;
  try {
    const replyResponse = await fetch(`${siteUrl}/.netlify/functions/generate-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  // 5. Save the pending approval (looked up by approve.js) and the
  //    permanent review record (used by the monthly report page).
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
    createdAt: new Date().toISOString(),
  };

  await reviewsStore.setJSON(`pending:${reviewId}`, reviewRecord);

  const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  await reviewsStore.setJSON(`review:${locationId}:${monthKey}:${reviewId}`, reviewRecord);

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

  try {
    const twilioResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: `whatsapp:${client.phone}`,
          From: twilioFrom,
          Body: messageBody,
        }),
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
