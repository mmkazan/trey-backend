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
// Identity, not a yes/no — see admin-auth.js. One shared implementation so the
// four back-office endpoints can never drift apart on who may do what.
const { adminIdentity, can, unauthorized, forbidden } = require("./admin-auth.js");

// --- DELETE a client and everything keyed to it -------------------------------
//
//   POST { token, action: "delete", locationId, confirmName }
//
// A client isn't one record. Its history is spread across sixteen blob stores,
// and a naive delete of just the `clients` entry leaves orphaned taps, reviews
// and tallies that quietly inflate later reports and can never be traced back to
// anything. So this removes the lot, and reports exactly what it removed.
//
// TYPE-TO-CONFIRM. `confirmName` must equal the stored businessName. This is
// irreversible — there is no undo and no soft-delete tier — and the whole reason
// it exists is to clean up NEAR-DUPLICATES, which is precisely the situation
// where deleting the wrong one is easiest and most costly. Making you type the
// name is cheap insurance against removing a live customer's review history.
//
// Also worth knowing: this is what makes a GDPR erasure request answerable. Trey
// is a UK data controller holding owner names and phone numbers, so "delete
// everything you hold on me" has to be a thing the system can actually do.
const DELETE_PREFIXES = [
  // [store, (loc) => [prefixes...]]
  ["taptally",     (l) => [`${l}:`]],
  ["reviewtally",  (l) => [`${l}:`]],
  ["ratinghistory",(l) => [`${l}:`]],
  ["reviews",      (l) => [`review:${l}:`]],
  ["reportssent",  (l) => [`monthly:${l}:`, `weekly:${l}:`]],
  ["postsent",     (l) => [`post:${l}:`]],
  ["photosent",    (l) => [`photo:${l}:`]],
  ["posts",        (l) => [`pending:${l}:`]],
  // NOTE: only `${l}:` goes here. The baseline key is `baseline:<loc>` with NO
  // trailing delimiter, so a prefix sweep on "baseline:aqua-rhythm" would also
  // match "baseline:aqua-rhythm-467fe7" and wipe a DIFFERENT, surviving client's
  // marker. fetch-reviews.mjs then treats that client as a first run and
  // re-baselines its whole review set as "seen" — every unanswered review
  // silently swallowed, never drafted, never alerted. It is deleted as an EXACT
  // key in DELETE_EXACT_PREFIXED instead.
  ["reviewsseen",  (l) => [`${l}:`]],
];
const DELETE_EXACT = ["clients", "taps", "stats"];
// Exact keys that are prefixed by something, so they cannot be swept safely.
const DELETE_EXACT_PREFIXED = [["reviewsseen", (l) => `baseline:${l}`]];
// Indexes keyed by something else entirely, whose VALUE points back at us.
const DELETE_BY_VALUE = ["refcodes", "stripecustomers", "photoreq", "approvalpending"];

async function deleteClient(locationId, confirmName) {
  const clients = blobsStore("clients");
  const client = await clients.get(locationId, { type: "json" });
  if (!client) return { statusCode: 404, body: JSON.stringify({ error: "Unknown client" }) };

  const expected = String(client.businessName || "").trim();
  if (String(confirmName || "").trim() !== expected) {
    return { statusCode: 400, body: JSON.stringify({
      error: `To delete this client, type its business name exactly: "${expected}"`,
    }) };
  }

  const removed = {};
  const bump = (store, n) => { if (n) removed[store] = (removed[store] || 0) + n; };

  // Reviews are special: the per-review "pending:<reviewId>" record is NOT keyed
  // by locationId, so it can only be found by reading the review first.
  try {
    const reviews = blobsStore("reviews");
    const { blobs } = await reviews.list({ prefix: `review:${locationId}:` });
    for (const b of blobs) {
      const rec = await reviews.get(b.key, { type: "json" }).catch(() => null);
      if (rec && rec.reviewId) await reviews.delete(`pending:${rec.reviewId}`).catch(() => {});
    }
  } catch (e) { console.error("[client] pending review sweep failed:", e.message); }

  for (const [name, prefixesFor] of DELETE_PREFIXES) {
    const store = blobsStore(name);
    for (const prefix of prefixesFor(locationId)) {
      try {
        const { blobs } = await store.list({ prefix });
        for (const b of blobs) { await store.delete(b.key).catch(() => {}); bump(name, 1); }
      } catch (e) { console.error(`[client] delete ${name}/${prefix} failed:`, e.message); }
    }
  }

  for (const name of DELETE_EXACT) {
    try { await blobsStore(name).delete(locationId); bump(name, 1); }
    catch (e) { /* absent is fine */ }
  }

  for (const [name, keyFor] of DELETE_EXACT_PREFIXED) {
    try { await blobsStore(name).delete(keyFor(locationId)); bump(name, 1); }
    catch (e) { /* absent is fine */ }
  }

  for (const name of DELETE_BY_VALUE) {
    try {
      const store = blobsStore(name);
      const { blobs } = await store.list();
      for (const b of blobs) {
        const v = await store.get(b.key, { type: "json" }).catch(() => null);
        if (v && v.locationId === locationId) { await store.delete(b.key).catch(() => {}); bump(name, 1); }
      }
    } catch (e) { console.error(`[client] delete ${name} by value failed:`, e.message); }
  }

  console.warn(`[client] DELETED "${expected}" (${locationId}) — removed: ${JSON.stringify(removed)}`);
  return { statusCode: 200, body: JSON.stringify({ success: true, deleted: locationId, businessName: expected, removed }) };
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

  const who = adminIdentity(event, requestBody);
  if (!who) {
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

  if (event.httpMethod === "POST" && requestBody && requestBody.action === "delete") {
    // This wipes the business across sixteen stores and cannot be undone. The
    // role check passes trivially today — there is one user and they are the
    // owner — but it EXISTS, so the day somebody else holds a token nobody has
    // to remember to add it while under pressure. See admin-auth.js.
    if (!can(who, "delete_client")) return forbidden("delete_client");
    if (!requestBody.locationId) {
      return { statusCode: 400, body: JSON.stringify({ error: "locationId is required" }) };
    }
    console.warn(`[client] DESTRUCTIVE DELETE of ${requestBody.locationId} by ${who.id}`);
    return await deleteClient(requestBody.locationId, requestBody.confirmName);
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
    // Provenance fields, set once on creation and never overwritten afterwards.
    // See admin-auth.js: retrofitting ownership onto records that never carried
    // it is impossible, so it goes on now while it costs a line.
    if (isNewClient) {
      record.ownerId = record.ownerId || who.id;
      record.country = record.country || "GB";
    } else {
      record.ownerId = existing.ownerId != null ? existing.ownerId : (record.ownerId || "");
      record.country = existing.country || record.country || "GB";
    }
    // Preserve the number as typed, for the same reason as signup.js.
    if (requestBody.phone && !requestBody.phoneRaw) {
      record.phoneRaw = existing.phoneRaw || String(requestBody.phone);
    }
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
