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
import runlogMod from "./runlog.js";
const { recordFailure } = runlogMod;

export const config = { schedule: "*/15 * * * *" };

// Google's star rating is an enum, not a number.
const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// WHY THIS ISN'T A PLAIN for-LOOP ANY MORE.
//
// It used to poll every client strictly one at a time, and each client can be
// several paged Google calls. When the run ran out of time part-way down the
// list it simply died — no summary, no record — and the clients it never
// reached had their reviews go undetected. Worse than the report senders,
// because list() hands back the SAME ORDER every run: the same tail was starved
// every 15 minutes, indefinitely. Their reviews were never replied to at all.
//
// So: a worker pool, a deadline, a rotating start offset so the tail moves, and
// a run log plus a summary that always prints.

// Eight at a time. These are Google reads, not messages to a customer, so this
// can run wider than the Twilio senders — but not so wide that a hundred clients
// hit the Business Profile API at once.
const POLL_CONCURRENCY = 8;

// This reruns every 15 minutes, so it does NOT need the platform's full 15
// minute allowance — one minute of work, then stop dispatching and let the next
// run (starting from where this one stopped) take the rest.
const TIME_BUDGET_MS = 60_000;

// The run record has to stay small however badly a run goes, so cap the list of
// failures it carries.
const MAX_FAILED_IDS = 50;

// Where the next run starts. Kept alongside the run records because it is the
// same question — what did this run actually get to.
const CURSOR_KEY = "fetch-reviews:cursor";

// Every run leaves a record — including a truncated one — so "whose reviews
// aren't being polled" is answerable after the fact instead of being a guess.
async function writeRunLog(record) {
  try {
    await blobsStore("runlog").setJSON(`fetch-reviews:${record.finishedAt}`, record);
  } catch (e) {
    console.error("[fetch-reviews] run log write failed:", e.message);
  }
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
  const START = Date.now();
  const DEADLINE = START + TIME_BUDGET_MS;

  // A FAILED RUN MUST LEAVE A TRACE.
  //
  // Found 18 Aug by the daily digest, on its first ever send: "fetch-reviews —
  // no run ever recorded". Not a false alarm — this function has FOUR exits, and
  // until now the two FAILURE ones returned without writing a run log while both
  // success paths wrote one. So a function scheduled every 15 minutes could fail
  // 96 times a day, forever, and be indistinguishable from one that had simply
  // never been deployed. The one system built to notice was blind to it.
  //
  // The failure records below carry `ok:false` and a reason, so the digest can
  // say "last run failed: google token" instead of "no run ever recorded" — the
  // difference between a question and an answer.
  // Shared with every other scheduler — see runlog.js. This was a local copy
  // for a few hours on 18 Aug; three more functions then turned out to need
  // the same thing, which is how eight copies of toE164 started.
  const failRun = (reason, detail) =>
    recordFailure("fetch-reviews", reason, detail, new Date(START).toISOString());

  for (const v of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
    if (!process.env[v]) {
      console.error(`[fetch-reviews] ${v} is not set — cannot poll Google.`);
      await failRun("missing-credentials", `${v} is not set`);
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
    await failRun("google-token", e.message);
    return new Response("token failed", { status: 502 });
  }

  const clientsStore = blobsStore("clients");
  const seenStore = blobsStore("reviewsseen");
  const runlogStore = blobsStore("runlog");
  const summary = { clients: 0, newReviews: 0, sent: 0, failed: 0, baselined: 0, skipped: 0 };
  const failedLocationIds = [];
  const noteFailure = (loc) => { if (failedLocationIds.length < MAX_FAILED_IDS) failedLocationIds.push(loc); };

  let blobs = [];
  try {
    ({ blobs } = await clientsStore.list());
  } catch (e) {
    console.error("[fetch-reviews] could not list clients:", e.message);
    // A failed list means nobody was polled at all this run. Record it — a
    // string of these is the difference between "quiet" and "broken".
    await writeRunLog({
      fn: "fetch-reviews",
      startedAt: new Date(START).toISOString(), finishedAt: new Date().toISOString(),
      processed: 0, sent: 0, failed: 0, skipped: 0, remaining: 0,
      ok: false, reason: "client-list", timedOut: false, listFailed: true, failedLocationIds: [],
    });
    return new Response("no clients");
  }

  // FAIRNESS. list() returns the same order every time, so a run that always
  // runs out of time at the same point starves the same tail of clients every
  // 15 minutes — forever. Start each run where the last one stopped and wrap
  // around, so every client is reached eventually even if no single run gets
  // all the way through the list.
  let offset = 0;
  try {
    const saved = await runlogStore.get(CURSOR_KEY, { type: "json" });
    const n = Number(saved && saved.offset);
    if (Number.isFinite(n) && n >= 0 && blobs.length) offset = Math.floor(n) % blobs.length;
  } catch {
    // No cursor yet, or the store hiccuped. Starting at 0 is only ever as unfair
    // as the old behaviour, never worse.
  }

  // One client, start to finish. This is the old loop body verbatim; the only
  // change is that "continue" is now "return".
  async function handleOne(b) {
    let client;
    try { client = await clientsStore.get(b.key, { type: "json" }); } catch { summary.skipped++; return; }
    if (!client || !client.googleAccountId || !client.locationId) { summary.skipped++; return; } // not GBP-connected
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
      noteFailure(client.locationId);
      console.error(`[fetch-reviews] ${client.locationId} failed:`, e.message);
    }
  }

  let cursor = 0;
  let attempted = 0;
  let timedOut = false;

  async function worker() {
    while (true) {
      // Stop STARTING work at the deadline. Anything already in flight is left
      // to finish — half a client's reviews handled and the rest abandoned is a
      // worse state than not having started.
      if (Date.now() > DEADLINE) { timedOut = true; return; }
      const i = cursor++;
      if (i >= blobs.length) return;
      // Rotated, not absolute — see the cursor above.
      const b = blobs[(offset + i) % blobs.length];
      attempted++;
      try {
        await handleOne(b);
      } catch (e) {
        // A blob read blowing up used to take the whole run down with it and
        // strand every client after this one. Now it costs one client.
        summary.failed++;
        noteFailure(b.key);
        console.error(`[fetch-reviews] ${b.key} errored:`, e.message);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, blobs.length) }, worker));
  } finally {
    // In a finally so a run that stopped short still says what it did. The old
    // summary line sat after the loop, which meant the runs worth knowing about
    // were exactly the ones that never printed one.
    const remaining = Math.max(0, blobs.length - attempted);
    const record = {
      fn: "fetch-reviews",
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date().toISOString(),
      processed: attempted,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      remaining,
      timedOut,
      newReviews: summary.newReviews,
      baselined: summary.baselined,
      startedFrom: offset,
      failedLocationIds: failedLocationIds.slice(0, MAX_FAILED_IDS),
    };
    // Move the start of the NEXT run past everything this one dispatched. If the
    // run got all the way round, this lands back where it began.
    if (blobs.length) {
      const next = (offset + attempted) % blobs.length;
      try { await runlogStore.setJSON(CURSOR_KEY, { offset: next, at: record.finishedAt }); }
      catch (e) { console.error("[fetch-reviews] cursor write failed:", e.message); }
      record.nextOffset = next;
    }
    await writeRunLog(record);
    const line = JSON.stringify({ ...summary, processed: attempted, remaining, timedOut, startedFrom: offset });
    // A client whose reviews were never polled is an error, not a statistic.
    if (timedOut || remaining > 0) console.error("[fetch-reviews] done:", line);
    else console.log("[fetch-reviews] done:", line);
  }
  return new Response("ok");
};
