const { getStore } = require("@netlify/blobs");

// Simple admin endpoint to add, update, and list client records in
// Netlify Blobs. Protected by the same secret token used elsewhere.
//
// GET  /.netlify/functions/client?token=...&locationId=...   -> one client
// GET  /.netlify/functions/client?token=...                  -> all clients
// POST /.netlify/functions/client                             -> add/update
//      body: { token, locationId, businessName, businessType, phone,
//               email, googleAccountId, voicePerspective, publicSignOffName }

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

  const clientsStore = getStore({ name: "clients", siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

  if (event.httpMethod === "POST") {
    const { locationId } = requestBody;
    if (!locationId) {
      return { statusCode: 400, body: JSON.stringify({ error: "locationId is required" }) };
    }
    const existing = (await clientsStore.get(locationId, { type: "json" })) || {};
    const record = {
      ...existing,
      ...requestBody,
      updatedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
    };
    delete record.token;
    await clientsStore.setJSON(locationId, record);
    return { statusCode: 200, body: JSON.stringify({ success: true, client: record }) };
  }

  if (event.httpMethod === "GET") {
    const locationId = (event.queryStringParameters || {}).locationId;
    if (locationId) {
      const client = await clientsStore.get(locationId, { type: "json" });
      if (!client) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      return { statusCode: 200, body: JSON.stringify(client) };
    }
    const { blobs } = await clientsStore.list();
    const clients = await Promise.all(
      blobs.map((b) => clientsStore.get(b.key, { type: "json" }))
    );
    return { statusCode: 200, body: JSON.stringify(clients) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
};
