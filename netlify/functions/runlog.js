// One place a scheduled function records that it ran.
//
// WHY THIS EXISTS. On 18 Aug the daily digest's first ever send reported
// "fetch-reviews — no run ever recorded". True, and misleading: fetch-reviews was
// firing every 15 minutes and returning early on a Google token error, on a path
// that wrote no run log. Auditing the rest found the same shape in three more
// functions, and one — monthly-google-sync — that never wrote a run log at all.
//
// Every one of them had a run log for the SUCCESS path and none for the failure
// paths, which is precisely backwards: a run that worked needs no explanation.
//
// So the rule this file encodes: **a scheduled function must record every exit,
// and a failing exit must say why.** Then "no run ever recorded" means what it
// says — the thing genuinely never ran — instead of meaning "it ran and died
// somewhere I did not instrument".
//
// It is a shared module rather than a copied helper because this codebase has
// already paid for that mistake once: eight copies of toE164 drifted apart and
// four of them were missing the fix that mattered.

// The blobs import is DEFERRED into the function that needs it, not taken at
// module load. @netlify/blobs only exists inside the Netlify runtime, and a
// top-level require would make this whole file impossible to require from
// tests/ — which would leave the retention rule below, the one piece of logic
// here that can silently destroy evidence, untested. Same reason digest-lib.js
// is a separate file from daily-digest.mjs.
function store() {
  const { getStore } = require("@netlify/blobs");
  return getStore({ name: "runlog", siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

/**
 * Write a run record. Keyed `<fn>:<finishedAt>` — the shape digest-lib.js reads.
 *
 * NEVER THROWS. A failure to record a failure must not turn a bad run into a
 * crashed one; the console line is the fallback.
 */
async function recordRun(fn, record) {
  const finishedAt = (record && record.finishedAt) || new Date().toISOString();
  const full = Object.assign({ fn, finishedAt }, record || {});
  try {
    await store().setJSON(`${fn}:${finishedAt}`, full);
  } catch (e) {
    console.error(`[${fn}] run log write failed:`, e.message);
  }
  return full;
}

/**
 * A run that could not do its work.
 *
 * `reason` is a short slug the digest prints — "google-token", "misconfigured".
 * `detail` is the error text, truncated; it is what turns "something is wrong"
 * into "invalid_grant: Token has been expired or revoked".
 */
async function recordFailure(fn, reason, detail, startedAt) {
  return recordRun(fn, {
    ok: false,
    reason: String(reason || "unknown"),
    detail: String(detail == null ? "" : detail).slice(0, 300),
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    processed: 0, sent: 0, failed: 0, skipped: 0, remaining: 0, timedOut: false,
  });
}

/**
 * A run that did nothing ON PURPOSE, because the feature is not switched on.
 *
 * NOT a failure, and the distinction matters more than it looks. A missing
 * TWILIO_POST_CONTENT_SID means the Google-post nudge has not been turned on
 * yet — alarming about it every morning would train the reader to ignore red
 * boxes, which is the one thing a daily email must never do. But it still has to
 * be RECORDED, or the digest reports "never ran" and sends someone hunting for a
 * scheduling fault that does not exist.
 *
 * A missing signing secret is the opposite: the feature IS on, and running it
 * would send real messages carrying dead links. That is `recordFailure`.
 */
async function recordSkipped(fn, note, startedAt) {
  return recordRun(fn, {
    ok: true,
    skipped: String(note || "not configured"),
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    processed: 0, sent: 0, failed: 0, remaining: 0, timedOut: false,
  });
}

/**
 * RETENTION. Decide which run-log keys to delete.
 *
 * Pure and exported so it can be tested, because choosing wrongly here silently
 * destroys the evidence trail the daily digest depends on — and it would look
 * exactly like the bug it was built to catch.
 *
 * A key is `<fn>:<ISO finishedAt>`.
 *
 * Two rules:
 *   1. Delete records older than `maxAgeDays`.
 *   2. NEVER delete the newest record for a function, however old.
 *
 * Rule 2 is not tidiness. photo-refresh-send runs QUARTERLY, so its last run can
 * legitimately be 90 days old. Purging on age alone would delete it, the digest
 * would then report "no run ever recorded", and a fix for a monitoring gap would
 * have manufactured one. It costs one record per function.
 *
 * Anything whose suffix is not a date is left alone: `geo-purge:cursor` and
 * `fetch-reviews:cursor` live in this store and are NOT run records. Deleting a
 * cursor would reset a sweep to the start of the store and starve its tail.
 */
function planPurge(keys, now, maxAgeDays) {
  const days = Number(maxAgeDays) > 0 ? Number(maxAgeDays) : 30;
  const cutoff = now - days * 86400000;
  const parsed = [];
  const unparsable = [];

  for (const k of keys || []) {
    const key = String(k);
    const i = key.indexOf(":");
    if (i <= 0) { unparsable.push(key); continue; }
    const t = Date.parse(key.slice(i + 1));
    if (!Number.isFinite(t)) { unparsable.push(key); continue; }
    parsed.push({ key, fn: key.slice(0, i), t });
  }

  const newestOf = {};
  for (const r of parsed) if (!newestOf[r.fn] || r.t > newestOf[r.fn].t) newestOf[r.fn] = r;
  const keptNewest = Object.values(newestOf).map((r) => r.key);
  const keep = new Set(keptNewest);

  const doomed = parsed.filter((r) => r.t < cutoff && !keep.has(r.key)).map((r) => r.key);
  return { doomed, keptNewest, unparsable };
}

module.exports = { recordRun, recordFailure, recordSkipped, planPurge, DEFAULT_MAX_AGE_DAYS: 30 };
