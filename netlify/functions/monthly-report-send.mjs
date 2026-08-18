// Netlify Scheduled Function — sends every eligible client their MONTHLY
// Trey report over WhatsApp. Runs on the 1st and reports the month that just
// finished. Fires a few hours after monthly-google-sync (00:00 UTC) so the
// Google ratings are freshly refreshed before we quote them.
//
// Schedule: "0 9 1 * *" = 09:00 UTC on the 1st of each month.
//
// Monthly template `trey_monthly_report_v2` (Call to action + URL button).
// Variable order:
//   {{1}} business name
//   {{2}} stand taps this month
//   {{3}} new reviews via the Trey stand this month
//   {{4}} other (organic) Google reviews this month
//   {{5}} Google rating "from"  (at sign-up)
//   {{6}} Google rating "to"    (current)
//   {{7}} report-link query string appended to the button URL:
//         loc=<id>&m=<YYYY-MM>&k=<key>
//
// The button URL in the template is  .../report?{{7}}  — so {{7}} is the whole
// query string. The key is derived exactly as report.js derives it, so the
// link this send builds passes report.js's access check.

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import linkKeysMod from "./link-keys.js";
import phoneMod from "./phone.js";
import retryMod from "./retry.js";
const { withRetry } = retryMod;
const { toE164 } = phoneMod;
const { linkKey, secretConfigured } = linkKeysMod;

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


export const config = { schedule: "0 9 1 * *" };

// Fallback to the live Utility SID (trey_monthly_report_v3) so this works even
// before the env var is set. Override with TWILIO_MONTHLY_CONTENT_SID on Netlify.
const MONTHLY_CONTENT_SID =
  process.env.TWILIO_MONTHLY_CONTENT_SID || "HX71ca271a874e3d0dee582ea32301b2f1";

// MUST match KEY_LEN in report.js. If you change one, change both.
const KEY_LEN = 32;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Same signing scheme as report.js: HMAC-SHA256(locationId, secret), truncated.
function reportKey(locationId) {
  return linkKey("report", locationId);
}

// WHY THIS ISN'T A PLAIN for-LOOP ANY MORE.
//
// It used to walk every client strictly one at a time. When the run hit the
// platform's time limit part-way down the list, the clients already done had
// their `monthly:<loc>:<mKey>` marker written and the rest had nothing — and
// because that marker key embeds the MONTH, the next run looks for a different
// key entirely. The tail of the client list never got that month's report at
// all. Not delayed: skipped, permanently, and silently.
//
// So: a worker pool so the list actually finishes, a deadline so we stop
// STARTING work before the platform kills us mid-send, and a run log plus a
// summary that always prints, so a short run is loud instead of invisible.

// Six at a time, deliberately modest — every unit of work here is a Twilio send
// and Twilio rate-limits an account that fires them too fast.
const SEND_CONCURRENCY = 6;

// Netlify gives a scheduled function 15 minutes. Don't rely on that: stop
// dispatching new clients at ten, leaving room for in-flight sends to land and
// for the run log to be written.
const TIME_BUDGET_MS = 600_000;

// The run record has to stay small however badly a run goes, so cap the list of
// failures it carries.
const MAX_FAILED_IDS = 50;

// Every run leaves a record — including a truncated one — so "who didn't get it"
// is answerable after the fact instead of being a guess.
async function writeRunLog(record) {
  try {
    await blobsStore("runlog").setJSON(`monthly-report-send:${record.finishedAt}`, record);
  } catch (e) {
    console.error("[monthly-report-send] run log write failed:", e.message);
  }
}

// Previous calendar month as YYYY-MM (the month being reported).
function prevMonthKey(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

const clean = (v, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Format a rating for the message; blank/unknown becomes an em dash.
const rating = (v) => (v === 0 || v ? clean(v, 8) : "—");

function isSendable(c) {
  if (!c || !c.phone) return false;
  if (c.reportsOptOut === true) return false;
  const status = (c.subscriptionStatus || "").toLowerCase();
  if (status === "paused" || status === "cancelled" || status === "canceled") return false;
  return true;
}

async function sendWhatsApp(params) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    }
  );
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${await resp.text()}`);
}

export default async () => {
  const START = Date.now();
  const DEADLINE = START + TIME_BUDGET_MS;

  const now = new Date();
  const mKey = prevMonthKey(now);

  if (!process.env.TREY_REPORT_SECRET) {
    console.warn("[monthly-report-send] TREY_REPORT_SECRET not set — report links will not validate.");
  }

  const clientsStore = blobsStore("clients");
  const tapTallyStore = blobsStore("taptally");
  const reviewTallyStore = blobsStore("reviewtally");
  const sentStore = blobsStore("reportssent"); // idempotency: one send per client per month

  const twilioFrom = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  const summary = { month: mKey, sent: 0, skipped: 0, failed: 0 };
  const failedLocationIds = [];
  const noteFailure = (loc) => { if (failedLocationIds.length < MAX_FAILED_IDS) failedLocationIds.push(loc); };

  let blobs = [];
  try {
    ({ blobs } = await clientsStore.list());
  } catch (err) {
    console.error("[monthly-report-send] could not list clients:", err.message);
    // A failed list means EVERY client goes without this month's report. That is
    // the loudest version of the silent-skip this run log exists to catch, so
    // record it rather than leaving one console line behind.
    await writeRunLog({
      fn: "monthly-report-send", month: mKey,
      startedAt: new Date(START).toISOString(), finishedAt: new Date().toISOString(),
      processed: 0, sent: 0, failed: 0, skipped: 0, remaining: 0,
      timedOut: false, listFailed: true, failedLocationIds: [],
    });
    return new Response("no clients");
  }

  // One client, start to finish. This is the old loop body verbatim; the only
  // change is that "continue" is now "return".
  async function handleOne(b) {
    let client;
    try {
      client = await clientsStore.get(b.key, { type: "json" });
    } catch {
      summary.skipped++;
      return;
    }
    if (!isSendable(client)) { summary.skipped++; return; }

    const loc = client.locationId || b.key;
    // Already sent this client their report for this month? Skip — so a re-fire
    // or redeploy-trigger never double-messages anyone.
    if (await sentStore.get(`monthly:${loc}:${mKey}`)) { summary.skipped++; return; }
    const monthTally = (await tapTallyStore.get(`${loc}:${mKey}`, { type: "json" })) || {};
    const monthReviews = (await reviewTallyStore.get(`${loc}:${mKey}`, { type: "json" })) || {};

    const taps = monthTally.taps || 0;
    const tapReviews = monthReviews.tapReviews || 0;
    const organicReviews = monthReviews.organicReviews || 0;
    const hasRating = client.googleRating || client.initialGoogleRating;

    // Skip only a truly empty month with no rating to show — nothing to say.
    if (taps === 0 && tapReviews === 0 && organicReviews === 0 && !hasRating) {
      summary.skipped++;
      return;
    }

    // Rating "from" (sign-up) -> "to" (current). Fall back to each other so we
    // never show a dash on one side when the other is known.
    const ratingFrom = client.initialGoogleRating ?? client.googleRating;
    const ratingTo = client.googleRating ?? client.initialGoogleRating;

    const reportQuery =
      `loc=${encodeURIComponent(loc)}&m=${mKey}&k=${reportKey(loc)}`;

    const params = messagingServiceSid
      ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
      : { To: `whatsapp:${toE164(client.phone)}`, From: twilioFrom };
    // Twilio returns 201 on ACCEPT, not on delivery. StatusCallback is how we
    // find out what actually happened to it — see twilio-status.js.
    params.StatusCallback = `${process.env.URL || "https://trey.today"}/.netlify/functions/twilio-status`;
    params.ContentSid = MONTHLY_CONTENT_SID;
    params.ContentVariables = JSON.stringify({
      1: clean(client.businessName, 60),
      2: clean(taps, 12),
      3: clean(tapReviews, 12),
      4: clean(organicReviews, 12),
      5: rating(ratingFrom),
      6: rating(ratingTo),
      7: clean(reportQuery, 300),
    });

    try {
      // Retry transient failures (429, 5xx, network) with backoff; give up at
      // once on a 4xx Twilio has already judged, and never sleep past the run
      // deadline. Before this, one blip lost the whole period for this client:
      // the marker below embeds the period, so the next run looks for a
      // different key and never comes back. See retry.js.
      await withRetry(() => sendWhatsApp(params), {
        deadline: DEADLINE,
        onRetry: (err, attempt, wait) => console.warn(
          `[monthly-report-send] ${loc} attempt ${attempt} failed (${err.message}) — retrying in ${wait}ms`),
      });
      await sentStore.setJSON(`monthly:${loc}:${mKey}`, { at: new Date().toISOString() });
      summary.sent++;
    } catch (err) {
      summary.failed++;
      noteFailure(loc);
      // Say WHY it stopped. "failed" alone cannot tell a number Twilio
      // rejected from a run that ran out of time — one needs a human, the
      // other will fix itself next period.
      const why = err.gaveUpEarly === "permanent" ? "rejected by Twilio, not retried"
        : err.gaveUpEarly === "deadline" ? "out of time before a retry could finish"
        : `after ${err.attempts || 1} attempts`;
      console.error(`[monthly-report-send] ${loc} failed (${why}):`, err.message);
    }
  }

  let cursor = 0;
  let attempted = 0;
  let timedOut = false;

  async function worker() {
    while (true) {
      // Stop STARTING work at the deadline. Anything already in flight is left
      // to finish — an abandoned send is a client who may or may not have been
      // messaged, which is worse than one who definitely wasn't.
      if (Date.now() > DEADLINE) { timedOut = true; return; }
      const i = cursor++;
      if (i >= blobs.length) return;
      attempted++;
      try {
        await handleOne(blobs[i]);
      } catch (err) {
        // A blob read blowing up used to take the whole run down with it and
        // strand every client after this one. Now it costs one client.
        summary.failed++;
        noteFailure(blobs[i].key);
        console.error(`[monthly-report-send] ${blobs[i].key} errored:`, err.message);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, blobs.length) }, worker));
  } finally {
    // In a finally so a run that stopped short still says what it did. The old
    // summary line sat after the loop, which meant the runs worth knowing about
    // were exactly the ones that never printed one.
    const remaining = Math.max(0, blobs.length - attempted);
    const record = {
      fn: "monthly-report-send", month: mKey,
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date().toISOString(),
      processed: attempted,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      remaining,
      timedOut,
      failedLocationIds: failedLocationIds.slice(0, MAX_FAILED_IDS),
    };
    await writeRunLog(record);
    const line = JSON.stringify({ ...summary, processed: attempted, remaining, timedOut });
    // A client who never got their report is an error, not a statistic.
    if (timedOut || remaining > 0) console.error("[monthly-report-send] done:", line);
    else console.log("[monthly-report-send] done:", line);
  }
  return new Response("ok");
};
