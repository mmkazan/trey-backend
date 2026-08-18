// Netlify Scheduled Function — keep the run log from growing forever.
//
// WHY. Every scheduled function now records every exit (see runlog.js, added
// 18 Aug after the digest found fetch-reviews failing invisibly). fetch-reviews
// alone runs every 15 minutes, so that is **96 records a day, ~35,000 a year**,
// in a store the daily digest LISTS in full every single morning. Left alone,
// the observability we just built becomes the thing that makes the digest slow,
// and eventually the thing that makes it time out — an irony worth avoiding.
//
// Schedule: 03:30 UTC daily. Half an hour after geo-purge, so the two full-store
// sweeps are not competing, and nowhere near 07:00 when the digest reads it.
//
// TWO RULES, and the second one matters more than it looks:
//
//   1. Delete records older than 30 days.
//   2. NEVER delete the newest record for a scheduler, however old it is.
//
// Without rule 2 this would quietly break the digest. photo-refresh-send runs
// QUARTERLY — its last run can legitimately be 90 days old. Purging on age alone
// would delete it, the digest would report "no run ever recorded", and the fix
// for a monitoring gap would have manufactured a monitoring gap. Rule 2 costs
// one retained record per scheduler and removes that whole class of mistake.
//
// Env: NETLIFY_SITE_ID, NETLIFY_BLOBS_TOKEN (same as every other scheduler).

import { getStore } from "@netlify/blobs";
import runlogMod from "./runlog.js";
const { recordRun, recordFailure, planPurge, DEFAULT_MAX_AGE_DAYS } = runlogMod;

export const config = { schedule: "30 3 * * *" };

const MAX_AGE_DAYS = DEFAULT_MAX_AGE_DAYS;
const DELETE_CONCURRENCY = 8;
const TIME_BUDGET_MS = 600_000;

// Its own records are exempt from its own sweep for one day, so a run of THIS
// function is always visible in the digest the next morning.
const SELF = "runlog-purge";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

export default async () => {
  const START = Date.now();
  const startedAt = new Date(START).toISOString();
  const store = blobsStore("runlog");

  let keys = [];
  try {
    const { blobs } = await store.list();
    keys = (blobs || []).map((b) => b.key);
  } catch (e) {
    console.error("[runlog-purge] could not list the run log:", e.message);
    await recordFailure(SELF, "list-failed", e.message, startedAt);
    return new Response("list failed", { status: 500 });
  }

  const { doomed, keptNewest, unparsable } = planPurge(keys, START, MAX_AGE_DAYS);

  let deleted = 0, failed = 0, timedOut = false;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(DELETE_CONCURRENCY, doomed.length || 1) }, async () => {
    while (true) {
      if (Date.now() > START + TIME_BUDGET_MS) { timedOut = true; return; }
      const i = cursor++;
      if (i >= doomed.length) return;
      try { await store.delete(doomed[i]); deleted++; }
      catch (e) { failed++; console.error(`[runlog-purge] could not delete ${doomed[i]}:`, e.message); }
    }
  });
  await Promise.all(workers);

  const record = {
    ok: true, startedAt, finishedAt: new Date().toISOString(),
    scanned: keys.length, processed: deleted, failed,
    skipped: keptNewest.length, remaining: Math.max(0, doomed.length - deleted - failed),
    unparsable: unparsable.length, timedOut, maxAgeDays: MAX_AGE_DAYS,
  };
  await recordRun(SELF, record);
  console.log("[runlog-purge] done:", JSON.stringify(record));
  return new Response("ok");
};

// planPurge lives in runlog.js so tests can require it without the Netlify
// runtime — see the note there.
