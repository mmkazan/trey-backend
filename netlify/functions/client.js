const { getStore } = require("@netlify/blobs");

// Simple admin endpoint to add, update, and list client records in
// Netlify Blobs. Protected by the same secret token used elsewhere.
//
// GET  /.netlify/functions/client?token=...&locationId=... -> one client
// GET  /.netlify/functions/client?token=...                 -> all clients
// POST /.netlify/functions/client                            -> add/update
//      body: { token, locationId, businessName, businessType, phone,
//               email, googleAccountId, voicePerspective, publicSignOffName,
//               initialGoogleRating, initialReviewCount }
//
// GET responses are enriched with tapReviews / organicReviews counts
// (tracked by review-webhook.js) so the admin UI can show review
// volume broken down by source since sign-up.

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Admin auth: the token comes from the Authorization: Bearer header (preferred)
// or the JSON body — never the query string, because URLs leak through server,
// CDN and proxy logs, browser history and Referer headers. Compared in constant
// time so a wrong token can't be recovered by timing.
function adminAuthorized(event, body) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim() || (body && body.token) || "";
  const expected = process.env.CLIENT_ADMIN_TOKEN || "";
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && require("crypto").timingSafeEqual(a, b);
}

// Coerce a rating/count field to a finite number (or undefined) so every write
// path stores numbers — the report page and senders expect numbers, but some
// onboarding forms post strings.
function numOrUndef(v) {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

// Monday (UTC) of the given date's week, as YYYY-MM-DD — the weekly key.
function weekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun .. 6=Sat
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  let requestBody = {};
  if (event.body) {
    try {
      requestBody = JSON.parse(event.body);
    } catch (err) {
      // ignore, handled by required-field checks below
    }
  }

  if (!adminAuthorized(event, requestBody)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const clientsStore = blobsStore("clients");
  const statsStore = blobsStore("stats");
  const tapTallyStore = blobsStore("taptally");
  const reviewTallyStore = blobsStore("reviewtally");

  async function withStats(client) {
    if (!client) return client;
    const now = new Date();
    const monthKey = now.toISOString().slice(0, 7); // YYYY-MM
    const wKey = weekKey(now);
    const stats = (await statsStore.get(client.locationId, { type: "json" })) || {};
    const tally = (await tapTallyStore.get(`${client.locationId}:${monthKey}`, { type: "json" })) || {};
    const weekTally = (await tapTallyStore.get(`${client.locationId}:week:${wKey}`, { type: "json" })) || {};
    const total = (await tapTallyStore.get(`${client.locationId}:total`, { type: "json" })) || {};
    const weekReviews = (await reviewTallyStore.get(`${client.locationId}:week:${wKey}`, { type: "json" })) || {};
    const monthReviews = (await reviewTallyStore.get(`${client.locationId}:${monthKey}`, { type: "json" })) || {};
    return {
      ...client,
      tapReviews: stats.tapReviews || 0,
      organicReviews: stats.organicReviews || 0,
      tapsThisMonth: tally.taps || 0,
      tapsThisWeek: weekTally.taps || 0,
      tapsSinceSignup: total.taps || 0,
      tapReviewsThisWeek: weekReviews.tapReviews || 0,
      organicReviewsThisWeek: weekReviews.organicReviews || 0,
      tapReviewsThisMonth: monthReviews.tapReviews || 0,
      organicReviewsThisMonth: monthReviews.organicReviews || 0,
    };
  }

  if (event.httpMethod === "POST") {
    const { locationId } = requestBody;
    if (!locationId) {
      return { statusCode: 400, body: JSON.stringify({ error: "locationId is required" }) };
    }
    const existing = (await clientsStore.get(locationId, { type: "json" })) || {};
    const isNewClient = !existing.createdAt;
    const record = {
      ...existing,
      ...requestBody,
      updatedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
    };
    // Store ratings/counts as numbers regardless of how the form posted them,
    // so the report page and monthly sender read consistent types.
    for (const f of ["initialGoogleRating", "googleRating", "initialReviewCount", "reviewCount"]) {
      if (f in requestBody) {
        const n = numOrUndef(record[f]);
        if (n === undefined) delete record[f];
        else record[f] = n;
      }
    }
    // Brand-new sign-ups start on the 14-day trial clock enforced by tap.js.
    // Pre-existing clients keep whatever they have (no status = grandfathered
    // active), so no live stand pauses unexpectedly when this ships.
    if (isNewClient && !record.subscriptionStatus) {
      record.subscriptionStatus = "trial";
    }
    // New clients use the on-tap trial model: the clock starts on the stand's
    // first tap once a go-live date is set (tap.js), not at creation. Existing
    // clients keep whatever they have, so no live stand's clock shifts.
    if (isNewClient && record.trialStartsOnTap === undefined) {
      record.trialStartsOnTap = true;
    }
    delete record.token;
    await clientsStore.setJSON(locationId, record);
    return { statusCode: 200, body: JSON.stringify({ success: true, client: record }) };
  }

  if (event.httpMethod === "GET") {
    const locationId = (event.queryStringParameters || {}).locationId;
    if (locationId) {
      const client = await clientsStore.get(locationId, { type: "json" });
      if (!client) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      return { statusCode: 200, body: JSON.stringify(await withStats(client)) };
    }
    const { blobs } = await clientsStore.list();
    const clients = await Promise.all(
      blobs.map(async (b) => withStats(await clientsStore.get(b.key, { type: "json" })))
    );
    return { statusCode: 200, body: JSON.stringify(clients) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
};
