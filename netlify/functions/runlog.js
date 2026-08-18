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

const { getStore } = require("@netlify/blobs");

function store() {
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

module.exports = { recordRun, recordFailure, recordSkipped };
