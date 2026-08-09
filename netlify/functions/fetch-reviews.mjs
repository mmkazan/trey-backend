// Netlify Scheduled Function — the "review detector".
//
// This is the piece that the old Make.com scenario used to do: watch each
// client's Google Business Profile for new reviews and hand any it hasn't seen
// to review-webhook (which drafts the AI reply and sends the WhatsApp approval).
// With this in place the ENTIRE review pipeline lives inside the app — no
// external automation tool.
//
//   tap.js  ->  customer leaves a Google review  ->  [THIS] detects it  ->
//   review-webhook.js (draft + WhatsApp approve)  ->  approve.js (post reply)
//
// Schedule: every 15 minutes. Adjust the cron below to taste.
//
// GOOGLE ACCOUNT/LOCATION MAPPING — the one thing to confirm before going live:
// this uses the SAME assumption approve.js already makes —
//     account  = client.googleAccountId
//     location = client.locationId   (the app's locationId is used directly as
//                the Google Business Profile *location id*)
// So onboarding must set each client's `locationId` to their real GBP location
// id (and `googleAccountId` to the account id). If the app's locationId is a
// friendly slug instead, both this poller AND approve.js's reply URL are wrong
// in the same way — fix it in one place (onboarding) and both work.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (already
// used by approve.js), TREY_WEBHOOK_SECRET (to authenticate to review-webhook),
// URL, NETLIFY_SITE_ID, NETLIFY_BLOBS_TOKEN.

import { getStore } from "@netlify/blobs";

export const config = { schedule: "*/15 * * * *" };

// Google's star rating is an enum, not a number.
const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Exchange the long-lived refresh token for a short-lived access token — same
// call approve.js makes.
async function googleAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `token HTTP ${res.status}`);
  return data.access_token;
}

async function listReviews(accessToken, accountId, locationId) {
  // Page through ALL reviews (Google returns ~50 per page). Without this the
  // baseline would only remember the 50 most-recently-updated reviews, and an
  // edited old review could later resurface as "new".
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 40; i++) { // safety cap (~2000 reviews)
    const base = `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews`;
    const url = pageToken ? `${base}?pageToken=${encodeURIComponent(pageToken)}` : base;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `reviews HTTP ${res.status}`);
    if (Array.isArray(data.reviews)) out.push(...data.reviews);
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
}

export default async () => {
  for (const v of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
    if (!process.env[v]) {
      console.error(`[fetch-reviews] ${v} is not set — cannot poll Google.`);
      return new Response("missing google creds", { status: 500 });
    }
  }
  const base = process.env.URL || "https://treyv1.netlify.app";
  const webhookSecret = process.env.TREY_WEBHOOK_SECRET || "";

  let accessToken;
  try {
    accessToken = await googleAccessToken();
  } catch (e) {
    console.error("[fetch-reviews] Google token failed:", e.message);
    return new Response("token failed", { status: 502 });
  }

  const clientsStore = blobsStore("clients");
  const seenStore = blobsStore("reviewsseen");
  const summary = { clients: 0, newReviews: 0, sent: 0, failed: 0, baselined: 0 };

  let blobs = [];
  try {
    ({ blobs } = await clientsStore.list());
  } catch (e) {
    console.error("[fetch-reviews] could not list clients:", e.message);
    return new Response("no clients");
  }

  for (const b of blobs) {
    let client;
    try { client = await clientsStore.get(b.key, { type: "json" }); } catch { continue; }
    if (!client || !client.googleAccountId || !client.locationId) continue; // not GBP-connected
    summary.clients++;

    // Wrapped per-client so one flaky Google call or blob write can't starve
    // the remaining clients this run.
    try {
      const reviews = await listReviews(accessToken, client.googleAccountId, client.locationId);

      // First time we ever poll a location, record its EXISTING reviews as seen
      // WITHOUT replying — so activation doesn't fire the whole back-catalogue of
      // old reviews at the owner. Only reviews that arrive after this baseline
      // trigger the flow. The baseline marker is written only AFTER all seen-keys,
      // so a partial baseline can never leak the back-catalogue.
      const baselineKey = `baseline:${client.locationId}`;
      const isFirstRun = !(await seenStore.get(baselineKey));

      for (const rv of reviews) {
        const reviewId = rv.reviewId || (rv.name || "").split("/").pop();
        if (!reviewId) continue;
        const seenKey = `${client.locationId}:${reviewId}`;

        if (isFirstRun) {
          await seenStore.setJSON(seenKey, { at: new Date().toISOString(), baseline: true });
          summary.baselined++;
          continue;
        }

        if (rv.reviewReply) continue;               // already replied (in or outside Trey)
        if (await seenStore.get(seenKey)) continue; // already handled

        summary.newReviews++;
        const payload = {
          locationId: client.locationId,
          reviewId, // stable Google id → review-webhook's dedupe keys on this
          reviewerName: (rv.reviewer && rv.reviewer.displayName) || "A customer",
          rating: STAR[rv.starRating] || 5, // default 5 if Google leaves it unspecified (rare) so alerts never show "null"
          comment: rv.comment || "",
        };
        try {
          const res = await fetch(`${base}/.netlify/functions/review-webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Trey-Signature": webhookSecret },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            // Mark seen only on success, so a transient failure (or a config fix)
            // gets retried next run rather than silently dropped.
            await seenStore.setJSON(seenKey, { at: new Date().toISOString() });
            summary.sent++;
          } else {
            summary.failed++;
            console.error(`[fetch-reviews] review-webhook ${res.status} for ${reviewId}`);
          }
        } catch (e) {
          summary.failed++;
          console.error(`[fetch-reviews] webhook post failed for ${reviewId}:`, e.message);
        }
      }

      if (isFirstRun) {
        await seenStore.setJSON(baselineKey, { at: new Date().toISOString(), count: reviews.length });
      }
    } catch (e) {
      summary.failed++;
      console.error(`[fetch-reviews] ${client.locationId} failed:`, e.message);
    }
  }

  console.log("[fetch-reviews] done:", JSON.stringify(summary));
  return new Response("ok");
};
