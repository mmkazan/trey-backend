const { getStore } = require("@netlify/blobs");

// Leads CRM store. Protected by the same CLIENT_ADMIN_TOKEN as the rest.
//
// GET  /.netlify/functions/leads?token=...              -> all leads (+ isClient flag)
// POST /.netlify/functions/leads  {token, lead:{...}}   -> add/update one
// POST /.netlify/functions/leads  {token, leads:[...]}  -> bulk add/update (CSV import)
// POST /.netlify/functions/leads  {token, delete:"id"}  -> delete one
//
// Each lead is matched against the clients store so the UI can flag anyone
// already onboarded ("Client ✓") and you don't chase existing customers.

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Admin auth: token from the Authorization: Bearer header (preferred) or the
// JSON body — never the query string (URLs leak via logs/history/referrers).
// Constant-time comparison.
function adminAuthorized(event, body) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim() || (body && body.token) || "";
  const expected = process.env.CLIENT_ADMIN_TOKEN || "";
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && require("crypto").timingSafeEqual(a, b);
}

const norm = (s) => (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");

function leadKey(lead) {
  if (lead.id) return lead.id;
  if (lead.placeId) return "p_" + norm(lead.placeId);
  const base = norm(lead.businessName) + "_" + norm(lead.phone);
  if (base && base !== "_") return "l_" + base;
  // No stable identifier — synthesise a unique key so several same-millisecond
  // bulk-imported rows don't collide and silently overwrite each other.
  return "l_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

exports.handler = async (event) => {
  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch (e) { /* ignore */ } }
  if (!adminAuthorized(event, body)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const leadsStore = blobsStore("leads");
  const clientsStore = blobsStore("clients");

  async function clientMatchers() {
    const byPlace = new Set(), byName = new Set(), byPhone = new Set();
    try {
      const { blobs } = await clientsStore.list();
      await Promise.all(blobs.map(async (b) => {
        const c = await clientsStore.get(b.key, { type: "json" });
        if (!c) return;
        if (c.placeId) byPlace.add(norm(c.placeId));
        if (c.businessName) byName.add(norm(c.businessName));
        if (c.phone) byPhone.add(norm(c.phone));
      }));
    } catch (e) { /* clients store may be empty */ }
    return { byPlace, byName, byPhone };
  }
  function isClient(l, m) {
    return !!((l.placeId && m.byPlace.has(norm(l.placeId))) ||
              (l.businessName && m.byName.has(norm(l.businessName))) ||
              (l.phone && m.byPhone.has(norm(l.phone))));
  }

  if (event.httpMethod === "GET") {
    const m = await clientMatchers();
    const { blobs } = await leadsStore.list();
    const leads = await Promise.all(blobs.map(async (b) => {
      const l = await leadsStore.get(b.key, { type: "json" });
      return l ? { ...l, id: b.key, isClient: isClient(l, m) } : null;
    }));
    return { statusCode: 200, body: JSON.stringify(leads.filter(Boolean)) };
  }

  if (event.httpMethod === "POST") {
    if (body.delete) {
      await leadsStore.delete(body.delete);
      return { statusCode: 200, body: JSON.stringify({ success: true, deleted: body.delete }) };
    }
    const now = new Date().toISOString();
    const incoming = Array.isArray(body.leads) ? body.leads : (body.lead ? [body.lead] : []);
    if (!incoming.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "No lead(s) provided" }) };
    }
    await Promise.all(incoming.map(async (raw) => {
      const key = leadKey(raw);
      const existing = (await leadsStore.get(key, { type: "json" })) || {};
      const record = {
        ...existing, ...raw, id: key,
        outreachStatus: raw.outreachStatus || existing.outreachStatus || "New",
        createdAt: existing.createdAt || now,
        updatedAt: now,
      };
      delete record.token;
      delete record.isClient;
      await leadsStore.setJSON(key, record);
    }));
    return { statusCode: 200, body: JSON.stringify({ success: true, saved: incoming.length }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
};
