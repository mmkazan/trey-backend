// Netlify Scheduled Function — the 30-day COORDINATE PURGE.
//
// Google's Maps Platform Service Terms let us cache a `place_id` indefinitely
// and latitude/longitude for a MAXIMUM of 30 consecutive calendar days, after
// which they must be deleted. leads.js has always stripped expired coordinates,
// but only inside its GET handler — i.e. only for leads somebody happened to
// open. Its own comment justified that with "the leads list is looked at often
// enough for that to be reliable", which is an assumption about human behaviour
// and not a control at all: a lead nobody opens keeps its lat/lng forever. The
// rule was not enforced, it merely looked enforced, and the gap grows with every
// lead that goes cold.
//
// So this walks the ENTIRE leads store every night and deletes the coordinates
// the read path would have deleted. It is the thing that makes the 30 days true.
//
// Schedule: 03:00 UTC daily — outside working hours, so a sweep of the whole
// store is never competing with someone using leads.html or go.html.
//
// Env: NETLIFY_SITE_ID, NETLIFY_BLOBS_TOKEN (same as every other scheduler).

import { getStore } from "@netlify/blobs";
import leadsRules from "./leads.js";

export const config = { schedule: "0 3 * * *" };

// THE RULES COME FROM leads.js, they are not restated here. A second copy of
// "when is a coordinate expired" would drift from the read path, and the day it
// drifts is the day one of the two quietly stops deleting something — a terms
// breach with no symptom. See the export block at the bottom of leads.js.
const { geoExpired, stripGeo, GEO_MAX_AGE_DAYS } = leadsRules;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Eight at a time. These are blob reads and writes against our own store, so
// this can run wider than the Twilio senders, but not so wide that a big list
// saturates the store and starts timing writes out — a timed-out write here is
// a coordinate that survives.
const PURGE_CONCURRENCY = 8;

// Netlify allows a scheduled function 15 minutes. Stop DISPATCHING at ten,
// leaving room for in-flight writes to land and for the run log to be written.
// A truncated run is not a disaster — the cursor below means tomorrow's run
// starts where this one stopped — but it must be visible, not guessed at.
const TIME_BUDGET_MS = 600_000;

// The run record has to stay small however badly a run goes, so cap the list of
// failures it carries.
const MAX_FAILED_IDS = 50;

// Where the next run starts. Kept alongside the run records because it is the
// same question — what did this run actually get to.
const CURSOR_KEY = "geo-purge:cursor";

// Every run leaves a record — including a truncated one — so "were the 30 days
// actually enforced last night" is answerable after the fact instead of being a
// belief. This is the evidence for a compliance obligation, so a run that
// cannot even write its log says so loudly.
async function writeRunLog(record) {
  try {
    await blobsStore("runlog").setJSON(`geo-purge:${record.finishedAt}`, record);
  } catch (e) {
    console.error("[geo-purge] run log write failed:", e.message);
  }
}

export default async () => {
  const START = Date.now();
  const DEADLINE = START + TIME_BUDGET_MS;

  const leadsStore = blobsStore("leads");
  const runlogStore = blobsStore("runlog");

  let scanned = 0, purged = 0, failed = 0, skipped = 0;
  const failedIds = [];
  const noteFailure = (id) => { if (failedIds.length < MAX_FAILED_IDS) failedIds.push(id); };

  let blobs = [];
  try {
    ({ blobs } = await leadsStore.list());
  } catch (e) {
    console.error("[geo-purge] could not list leads:", e.message);
    // A failed list means NOTHING was purged tonight and every expired
    // coordinate in the store survived another day. Record it — a run of these
    // is the difference between "nothing to do" and "not running".
    await writeRunLog({
      fn: "geo-purge",
      startedAt: new Date(START).toISOString(), finishedAt: new Date().toISOString(),
      scanned: 0, purged: 0, failed: 0, remaining: 0,
      timedOut: false, listFailed: true, failedIds: [],
    });
    return new Response("no leads");
  }

  // FAIRNESS. list() returns the same order every time, so a run that always
  // runs out of time at the same point sweeps the same head of the list every
  // night and never reaches the tail — those leads would keep their coordinates
  // indefinitely, which is the exact bug this function exists to fix. Start
  // where the last run stopped and wrap around.
  let offset = 0;
  try {
    const saved = await runlogStore.get(CURSOR_KEY, { type: "json" });
    const n = Number(saved && saved.offset);
    if (Number.isFinite(n) && n >= 0 && blobs.length) offset = Math.floor(n) % blobs.length;
  } catch {
    // No cursor yet, or the store hiccuped. Starting at 0 is only ever as unfair
    // as no cursor at all, never worse.
  }

  // One lead, start to finish.
  async function handleOne(key) {
    let lead;
    try {
      lead = await leadsStore.get(key, { type: "json" });
    } catch (e) {
      // Could not READ it, so we cannot know whether it holds expired
      // coordinates. That is a failure, not a skip — counting it as "nothing to
      // do" would be the same lie the lazy purge told.
      failed++;
      noteFailure(key);
      console.error(`[geo-purge] read failed for ${key}:`, e.message);
      return;
    }
    if (!lead) { skipped++; return; }
    if (!geoExpired(lead, Date.now())) return;

    // Write the record BACK without lat/lng/geoAt. A failed write is counted as
    // a failure and never as a purge: the whole point of this function is that
    // "purged" means the coordinates are gone from the store, not that we tried.
    try {
      await leadsStore.setJSON(key, stripGeo(lead));
      purged++;
    } catch (e) {
      failed++;
      noteFailure(key);
      console.error(`[geo-purge] PURGE WRITE FAILED for ${key} — lat/lng older than ${GEO_MAX_AGE_DAYS} days are still stored:`, e.message);
    }
  }

  let cursor = 0;
  let attempted = 0;
  let timedOut = false;

  async function worker() {
    while (true) {
      // Stop STARTING work at the deadline. Anything already in flight finishes
      // — a write abandoned mid-flight leaves a record we can't describe.
      if (Date.now() > DEADLINE) { timedOut = true; return; }
      const i = cursor++;
      if (i >= blobs.length) return;
      // Rotated, not absolute — see the cursor above.
      const b = blobs[(offset + i) % blobs.length];
      attempted++;
      scanned++;
      try {
        await handleOne(b.key);
      } catch (e) {
        // One bad record must cost one record, not the rest of the sweep.
        failed++;
        noteFailure(b.key);
        console.error(`[geo-purge] ${b.key} errored:`, e.message);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(PURGE_CONCURRENCY, blobs.length) }, worker));
  } finally {
    // In a finally so a run that stopped short still says what it did. The runs
    // worth knowing about are exactly the ones that didn't finish.
    const remaining = Math.max(0, blobs.length - attempted);
    const record = {
      fn: "geo-purge",
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date().toISOString(),
      scanned,
      purged,
      failed,
      remaining,
      timedOut,
      skipped,
      maxAgeDays: GEO_MAX_AGE_DAYS,
      startedFrom: offset,
      failedIds: failedIds.slice(0, MAX_FAILED_IDS),
    };
    if (blobs.length) {
      const next = (offset + attempted) % blobs.length;
      try { await runlogStore.setJSON(CURSOR_KEY, { offset: next, at: record.finishedAt }); }
      catch (e) { console.error("[geo-purge] cursor write failed:", e.message); }
      record.nextOffset = next;
    }
    await writeRunLog(record);
    const line = JSON.stringify({ scanned, purged, failed, skipped, remaining, timedOut, startedFrom: offset });
    // A lead we couldn't purge, or one we never reached, is a lead still holding
    // coordinates it is not allowed to hold. That is an error, not a statistic.
    if (failed || timedOut || remaining > 0) console.error("[geo-purge] done:", line);
    else console.log("[geo-purge] done:", line);
  }
  return new Response("ok");
};
