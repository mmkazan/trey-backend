const { getStore } = require("@netlify/blobs");

// Pulls the live Google rating + review count for each client from the
// Places API (New) and writes them onto the client record so the admin
// page can show "at sign-up -> now".
//
// Usage:
//   GET  /.netlify/functions/refresh-google-stats?token=ADMIN_TOKEN
//        -> refreshes every client that has a placeId, returns a summary
//   GET  /.netlify/functions/refresh-google-stats?token=ADMIN_TOKEN&placeId=ChIJ...
//        -> TEST MODE: fetches that one place and returns its numbers,
//           writes nothing. Handy for checking the key works.
//
// Requires env vars: GOOGLE_PLACES_API_KEY, CLIENT_ADMIN_TOKEN,
// and the usual NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN used elsewhere.

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// YYYY-MM of the last complete calendar month. A monthly sync running on the
// 1st records the rating that the month just ended on.
function lastCompleteMonth(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCDate(0);
  return d.toISOString().slice(0, 7);
}

async function fetchGooglePlace(placeId) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "rating,userRatingCount",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Places API HTTP ${res.status}`);
  }
  return {
    rating: typeof data.rating === "number" ? data.rating : null,
    reviewCount: typeof data.userRatingCount === "number" ? data.userRatingCount : null,
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { /* ignore */ }
  }
  const token = params.token || body.token;

  // Netlify scheduled invocations set this header; allow those through too.
  const headers = event.headers || {};
  const isScheduled = !!(headers["x-nf-scheduled"] || headers["X-Nf-Scheduled"]);

  if (!isScheduled && token !== process.env.CLIENT_ADMIN_TOKEN) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "GOOGLE_PLACES_API_KEY is not set on Netlify" }) };
  }

  // TEST MODE: single placeId, no writes.
  const testPlaceId = params.placeId || body.placeId;
  if (testPlaceId) {
    try {
      const r = await fetchGooglePlace(testPlaceId);
      return { statusCode: 200, body: JSON.stringify({ test: true, placeId: testPlaceId, rating: r.rating, reviewCount: r.reviewCount }) };
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: e.message }) };
    }
  }

  // FULL MODE: refresh every client that has a placeId.
  const clientsStore = blobsStore("clients");
  const ratingHistory = blobsStore("ratinghistory");
  const snapshotMonth = lastCompleteMonth(new Date());
  const { blobs } = await clientsStore.list();
  const results = [];
  for (const b of blobs) {
    const client = await clientsStore.get(b.key, { type: "json" });
    if (!client || !client.placeId) continue;
    try {
      const r = await fetchGooglePlace(client.placeId);
      const updated = {
        ...client,
        googleRating: r.rating,
        reviewCount: r.reviewCount,
        lastGoogleSync: new Date().toISOString(),
      };
      await clientsStore.setJSON(client.locationId, updated);

      // Record the just-ended month's rating for the monthly report's
      // month-over-month hero. Write-if-absent so a mid-month manual refresh
      // never overwrites the snapshot the scheduled 1st-of-month sync took.
      if (typeof r.rating === "number") {
        const snapKey = `${client.locationId}:${snapshotMonth}`;
        const existing = await ratingHistory.get(snapKey, { type: "json" });
        if (!existing) {
          await ratingHistory.setJSON(snapKey, {
            rating: r.rating, source: "monthly-sync", capturedAt: new Date().toISOString(),
          });
        }
      }
      results.push({ locationId: client.locationId, rating: r.rating, reviewCount: r.reviewCount });
    } catch (e) {
      results.push({ locationId: client.locationId, error: e.message });
    }
  }
  return { statusCode: 200, body: JSON.stringify({ refreshed: results.length, results }) };
};
