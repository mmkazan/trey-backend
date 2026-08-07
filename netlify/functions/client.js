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

exports.handler = async (event) => {
  let requestBody = {};
  if (event.body) {
    try {
      requestBody = JSON.parse(event.body);
    } catch (err) {
      // ignore, handled by required-field checks below
    }
  }

  const token = (event.queryStringParameters || {}).token || requestBody.token;
  if (!token || token !== process.env.CLIENT_ADMIN_TOKEN) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const clientsStore = blobsStore("clients");
  const statsStore = blobsStore("stats");
  const tapTallyStore = blobsStore("taptally");

  async function withStats(client) {
    if (!client) return client;
    const stats = (await statsStore.get(client.locationId, { type: "json" })) || {};
    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
    const tally = (await tapTallyStore.get(`${client.locationId}:${monthKey}`, { type: "json" })) || {};
    const total = (await tapTallyStore.get(`${client.locationId}:total`, { type: "json" })) || {};
    return {
      ...client,
      tapReviews: stats.tapReviews || 0,
      organicReviews: stats.organicReviews || 0,
      tapsThisMonth: tally.taps || 0,
      tapsSinceSignup: total.taps || 0,
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
    // Brand-new sign-ups start on the 14-day trial clock enforced by tap.js.
    // Pre-existing clients keep whatever they have (no status = grandfathered
    // active), so no live stand pauses unexpectedly when this ships.
    if (isNewClient && !record.subscriptionStatus) {
      record.subscriptionStatus = "trial";
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
