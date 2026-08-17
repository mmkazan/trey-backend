// Netlify Scheduled Function — sends every eligible client their WEEKLY
// Trey report over WhatsApp. Runs Monday mornings and reports the week that
// just finished (last Monday–Sunday).
//
// Schedule: "0 8 * * 1" = 08:00 UTC every Monday (~9am UK in summer, 8am in winter).
//
// Data is read straight from the same Blobs stores that tap.js and
// review-webhook.js write to — no self-HTTP call needed. The send reuses the
// exact Twilio Content API pattern from review-webhook.js.
//
// Weekly template `trey_weekly_report` (Text, no button). Variable order:
//   {{1}} business name
//   {{2}} stand taps this week
//   {{3}} new reviews via the Trey stand this week
//   {{4}} other (organic) Google reviews this week

import { getStore } from "@netlify/blobs";
import phoneMod from "./phone.js";
const { toE164 } = phoneMod;

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


export const config = { schedule: "0 8 * * 1" };

// Fallback to the live Utility SID (trey_weekly_report_v2) so this works even
// before the env var is set. Override with TWILIO_WEEKLY_CONTENT_SID on Netlify.
const WEEKLY_CONTENT_SID =
  process.env.TWILIO_WEEKLY_CONTENT_SID || "HX75b48d2a80306b8bfe09197950013000";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// WHY THIS ISN'T A PLAIN for-LOOP ANY MORE.
//
// It used to walk every client strictly one at a time. When the run hit the
// platform's time limit part-way down the list, the clients already done had
// their `weekly:<loc>:<wKey>` marker written and the rest had nothing — and
// because that marker key embeds the WEEK, the next run looks for a different
// key entirely. The tail of the client list never got that week's report at
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
    await blobsStore("runlog").setJSON(`weekly-report-send:${record.finishedAt}`, record);
  } catch (e) {
    console.error("[weekly-report-send] run log write failed:", e.message);
  }
}

// Monday (UTC) of the given date's week, as YYYY-MM-DD. Must match tap.js /
// client.js so we read the same weekly keys they wrote.
function weekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun .. 6=Sat
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

// The most recently COMPLETED week's key. Take this week's Monday, step back
// one day into the previous week, and take that week's Monday.
function lastCompleteWeekKey(now) {
  const thisMonday = new Date(`${weekKey(now)}T00:00:00Z`);
  const inPrevWeek = new Date(thisMonday.getTime() - 24 * 60 * 60 * 1000);
  return weekKey(inPrevWeek);
}

// WhatsApp template variables must be single-line (no newlines/tabs, no runs
// of 4+ spaces) and reasonably short, or Twilio rejects the send.
const clean = (v, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// A client is skipped if it has no phone, has opted out, or its subscription
// is paused/cancelled. Everyone else (trial, active, or grandfathered) is in.
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
  const wKey = lastCompleteWeekKey(now);

  const clientsStore = blobsStore("clients");
  const tapTallyStore = blobsStore("taptally");
  const reviewTallyStore = blobsStore("reviewtally");
  const sentStore = blobsStore("reportssent"); // idempotency: one send per client per week

  const twilioFrom = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  const summary = { week: wKey, sent: 0, skipped: 0, failed: 0 };
  const failedLocationIds = [];
  const noteFailure = (loc) => { if (failedLocationIds.length < MAX_FAILED_IDS) failedLocationIds.push(loc); };

  let blobs = [];
  try {
    ({ blobs } = await clientsStore.list());
  } catch (err) {
    console.error("[weekly-report-send] could not list clients:", err.message);
    // A failed list means EVERY client goes without this week's report. That is
    // the loudest version of the silent-skip this run log exists to catch, so
    // record it rather than leaving one console line behind.
    await writeRunLog({
      fn: "weekly-report-send", week: wKey,
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
    // Already sent this client their report for this week? Skip — so a re-fire
    // or redeploy-trigger never double-messages anyone.
    if (await sentStore.get(`weekly:${loc}:${wKey}`)) { summary.skipped++; return; }
    const weekTally = (await tapTallyStore.get(`${loc}:week:${wKey}`, { type: "json" })) || {};
    const weekReviews = (await reviewTallyStore.get(`${loc}:week:${wKey}`, { type: "json" })) || {};

    const taps = weekTally.taps || 0;
    const tapReviews = weekReviews.tapReviews || 0;
    const organicReviews = weekReviews.organicReviews || 0;

    // Don't send a dead-quiet week (0 taps and 0 reviews) — it reads as spam
    // and is demoralising. They'll get the monthly summary regardless.
    if (taps === 0 && tapReviews === 0 && organicReviews === 0) { summary.skipped++; return; }

    const params = messagingServiceSid
      ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
      : { To: `whatsapp:${toE164(client.phone)}`, From: twilioFrom };
    // Twilio returns 201 on ACCEPT, not on delivery. StatusCallback is how we
    // find out what actually happened to it — see twilio-status.js.
    params.StatusCallback = `${process.env.URL || "https://trey.today"}/.netlify/functions/twilio-status`;
    params.ContentSid = WEEKLY_CONTENT_SID;
    params.ContentVariables = JSON.stringify({
      1: clean(client.businessName, 60),
      2: clean(taps, 12),
      3: clean(tapReviews, 12),
      4: clean(organicReviews, 12),
    });

    try {
      await sendWhatsApp(params);
      await sentStore.setJSON(`weekly:${loc}:${wKey}`, { at: new Date().toISOString() });
      summary.sent++;
    } catch (err) {
      summary.failed++;
      noteFailure(loc);
      console.error(`[weekly-report-send] ${loc} failed:`, err.message);
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
        console.error(`[weekly-report-send] ${blobs[i].key} errored:`, err.message);
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
      fn: "weekly-report-send", week: wKey,
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
    if (timedOut || remaining > 0) console.error("[weekly-report-send] done:", line);
    else console.log("[weekly-report-send] done:", line);
  }
  return new Response("ok");
};
