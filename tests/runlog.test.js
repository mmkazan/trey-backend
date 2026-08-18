// The run log: recording every exit, and not destroying the record later.
//
// CONTEXT. On 18 Aug the daily digest's first send reported "fetch-reviews — no
// run ever recorded". True, and misleading: fetch-reviews was firing every 15
// minutes and dying on a Google token error, on a path that wrote no run log.
// Auditing the rest found the same shape in three more functions and one —
// monthly-google-sync — that never wrote a run log at all.
//
// runlog.js is the shared answer. Its blobs import is deferred precisely so this
// file can require it: the retention rule below is the one piece of logic here
// that can silently destroy evidence, and it would fail looking exactly like the
// bug it was built to catch.

const fs = require("fs");
const path = require("path");
const FN = path.join(__dirname, "..", "netlify", "functions");
const { planPurge, DEFAULT_MAX_AGE_DAYS } = require(path.join(FN, "runlog.js"));

exports.run = function (t) {
  const DAY = 86400000;
  const now = Date.parse("2026-09-18T03:30:00Z");
  const at = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();

  // === Retention ==========================================================
  {
    const keys = [
      `fetch-reviews:${at(60)}`,   // ancient
      `fetch-reviews:${at(40)}`,   // ancient
      `fetch-reviews:${at(2)}`,    // recent, and the newest for this fn
      `geo-purge:${at(45)}`,       // ancient
      `geo-purge:${at(1)}`,        // newest
      `weekly-report-send:${at(1)}`,
    ];
    const { doomed, keptNewest, unparsable } = planPurge(keys, now, 30);

    t.eq(doomed.length, 3, "everything past the cutoff is deleted");
    t.ok(doomed.includes(`fetch-reviews:${at(60)}`), "a 60-day-old record goes");
    t.ok(doomed.includes(`geo-purge:${at(45)}`), "…across every function");
    t.ok(!doomed.includes(`fetch-reviews:${at(2)}`), "a recent record stays");
    t.eq(unparsable.length, 0, "well-formed keys are all understood");
    t.eq(keptNewest.length, 3, "one newest record is pinned per function");
  }

  // === Rule 2: the newest record is NEVER deleted =========================
  //
  // photo-refresh-send runs QUARTERLY, so its last run can legitimately be 90
  // days old. Purging on age alone would delete it, the digest would then say
  // "no run ever recorded", and a fix for a monitoring gap would have
  // manufactured one.
  {
    const keys = [
      `photo-refresh-send:${at(95)}`,
      `photo-refresh-send:${at(200)}`,
      `monthly-google-sync:${at(70)}`,
    ];
    const { doomed, keptNewest } = planPurge(keys, now, 30);
    t.ok(!doomed.includes(`photo-refresh-send:${at(95)}`),
      "REGRESSION: a quarterly job's only recent-ish run survives the sweep");
    t.ok(doomed.includes(`photo-refresh-send:${at(200)}`),
      "…but its older ones do not — only the NEWEST is pinned");
    t.ok(!doomed.includes(`monthly-google-sync:${at(70)}`),
      "a monthly job's single ancient record survives, because it is its newest");
    t.eq(keptNewest.length, 2, "exactly one per function is pinned");
  }

  // === Cursors are not run records ========================================
  //
  // `geo-purge:cursor` and `fetch-reviews:cursor` live in this store. Deleting
  // one would reset a full-store sweep to the beginning and starve its tail —
  // for geo-purge that is a Maps Platform terms breach with no symptom.
  {
    const keys = [
      "geo-purge:cursor",
      "fetch-reviews:cursor",
      `fetch-reviews:${at(90)}`,
      `fetch-reviews:${at(1)}`,
    ];
    const { doomed, unparsable } = planPurge(keys, now, 30);
    t.ok(!doomed.includes("geo-purge:cursor"), "a cursor is never deleted");
    t.ok(!doomed.includes("fetch-reviews:cursor"), "…either of them");
    t.ok(unparsable.includes("geo-purge:cursor"), "…they are reported as unrecognised, not silently dropped");
    t.ok(doomed.includes(`fetch-reviews:${at(90)}`), "…while real old records still go");
  }

  // === Degenerate input must never delete something by accident ===========
  {
    t.eq(planPurge([], now, 30).doomed.length, 0, "an empty store deletes nothing");
    t.eq(planPurge(null, now, 30).doomed.length, 0, "a missing listing deletes nothing");
    // Two records for `x` so the newest-is-pinned rule does not mask the point.
    const junk = planPurge(["nocolon", "", ":leading", `x:${at(90)}`, `x:${at(80)}`], now, 30);
    t.ok(junk.unparsable.includes("nocolon"), "a key with no colon is left alone");
    t.ok(junk.unparsable.includes(":leading"), "…as is one with an empty function name");
    t.eq(junk.doomed, [`x:${at(90)}`],
      "only the well-formed OLDER key is deleted — the newest is pinned even at 80 days");
    t.eq(junk.keptNewest, [`x:${at(80)}`], "…and that is the one kept");
    // A nonsense age must not become "delete everything".
    t.eq(planPurge([`a:${at(1)}`, `a:${at(2)}`], now, 0).doomed.length, 0,
      "maxAgeDays of 0 falls back to the default rather than purging the lot");
    t.eq(planPurge([`a:${at(1)}`, `a:${at(2)}`], now, -5).doomed.length, 0,
      "…and so does a negative one");
    t.eq(DEFAULT_MAX_AGE_DAYS, 30, "the default retention is 30 days");
  }

  // === The senders and the sweep are wired up =============================
  {
    const purge = fs.readFileSync(path.join(FN, "runlog-purge.mjs"), "utf8");
    t.ok(/export const config = \{ schedule: "30 3 \* \* \*" \}/.test(purge),
      "the sweep runs at 03:30, after geo-purge and long before the 07:00 digest");
    t.ok(/planPurge\(keys, START, MAX_AGE_DAYS\)/.test(purge), "it uses the shared rule");
    t.ok(!/function planPurge/.test(purge), "…and does not carry a second copy of it");

    // Every scheduled function records its exits through the shared helper.
    for (const f of ["fetch-reviews.mjs", "google-post-send.mjs",
                     "photo-refresh-send.mjs", "monthly-google-sync.mjs"]) {
      const src = fs.readFileSync(path.join(FN, f), "utf8");
      t.ok(/from "\.\/runlog\.js"/.test(src), `${f} uses the shared run-log helper`);
      t.ok(/recordFailure\(|recordSkipped\(|recordRun\(/.test(src),
        `${f} records the exit that used to return silently`);
    }
    // The distinction that keeps the red boxes meaningful: a feature that is
    // simply switched off is NOT a failure.
    const gps = fs.readFileSync(path.join(FN, "google-post-send.mjs"), "utf8");
    t.ok(/recordSkipped\("google-post-send", "TWILIO_POST_CONTENT_SID/.test(gps),
      "a missing content SID is recorded as 'not switched on', not as a failure");
    t.ok(/recordFailure\("google-post-send", "misconfigured"/.test(gps),
      "…while a missing signing secret IS a failure — it would send dead links");
  }
};
