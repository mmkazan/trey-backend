// The daily digest.
//
// The digest exists to surface silent failures, so the thing that matters most
// is that IT never fails silently: a malformed record, a missing store or a
// broken date must not take the email down, and a section that could not be
// read has to say so rather than looking like a quiet day.
//
// These call the REAL section builders, not a copy of them. That is why the
// pure half lives in digest-lib.js: daily-digest.mjs imports @netlify/blobs,
// which only exists inside the Netlify runtime, so a test that imported it
// could not run at all.

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "netlify", "functions", "daily-digest.mjs");
const T = require(path.join(ROOT, "netlify", "functions", "digest-lib.js"));

exports.run = function (t) {
  const src = fs.readFileSync(SRC, "utf8");
  // Each block below builds a promise chain; they are awaited TOGETHER at the
  // end. The come-back tests were originally appended after the first block's
  // `return`, so run() handed back before reaching them and 30 assertions
  // silently never executed — the suite still said 785 passed. A test that
  // does not run looks exactly like a test that passes.
  let mainChain = Promise.resolve(), comeBackChain = Promise.resolve();

  // === Source-level guarantees ============================================
  t.ok(/export const config = \{ schedule: "0 7 \* \* \*" \}/.test(src),
    "runs at 07:00 UTC — 08:00 BST in summer");
  // The repo is public. A personal address in source is a permanent leak.
  t.ok(!/[a-z0-9._%+-]+@gmail\.com/i.test(src),
    "no personal email address is hardcoded — the repo is public");
  t.ok(/process\.env\.TREY_DIGEST_TO/.test(src),
    "the recipient is an env var, with a published business inbox as the default");
  t.ok(/process\.env\.RESEND_API_KEY/.test(src), "sends through Resend");
  // It may MENTION Twilio (it explains error codes); it must never CALL it.
  t.ok(!/api\.twilio\.com/.test(src), "the digest never calls the Twilio API");
  t.ok(/api\.resend\.com/.test(src), "…it sends over the channel that always delivers");
  // The bug this codebase keeps finding.
  t.ok(/Promise\.all/.test(src), "reads are pooled, not run one after another");

  {
    const HOUR = 3600_000, DAY = 24 * HOUR;
    const now = Date.parse("2026-08-17T07:00:00Z");
    const from = now - DAY;

    // === ts() / inWindow() — the date handling everything else rests on ====
    t.ok(Number.isNaN(T.ts(undefined)), "ts(undefined) is NaN, not 0");
    t.ok(Number.isNaN(T.ts("")), "ts('') is NaN");
    t.ok(Number.isNaN(T.ts("not a date")), "ts(junk) is NaN, not an epoch date");
    t.eq(T.ts("2026-08-17T07:00:00Z"), now, "ts parses an ISO timestamp");
    t.ok(!T.inWindow(undefined, from, now), "a missing timestamp is never in the window");
    t.ok(!T.inWindow("banana", from, now), "an unparseable timestamp is never in the window");
    t.ok(T.inWindow("2026-08-16T12:00:00Z", from, now), "a timestamp inside the window counts");
    t.ok(!T.inWindow("2026-08-15T12:00:00Z", from, now), "one before the window does not");
    // Half-open, so a record on the boundary is counted exactly once across two
    // consecutive runs rather than twice or never.
    t.ok(T.inWindow(new Date(from).toISOString(), from, now), "the window includes its start");
    t.ok(!T.inWindow(new Date(now).toISOString(), from, now), "…and excludes its end");

    // === Escaping ==========================================================
    // Business names come from Apify and from a public signup form.
    t.eq(T.esc('<img src=x onerror=alert(1)>'),
      "&lt;img src=x onerror=alert(1)&gt;", "markup in a business name is escaped");
    t.eq(T.esc(null), "", "null escapes to empty, not to 'null'");

    const clients = [
      { key: "loc1", value: { businessName: "Raven Holistics", createdAt: "2026-08-16T09:00:00Z", hardware: "fob", email: "a@b.com" } },
      { key: "loc2", value: { businessName: "Old Client", createdAt: "2026-07-01T09:00:00Z", trialStartedAt: "2026-08-16T18:00:00Z" } },
      { key: "loc3", value: { businessName: "Lapsing", trialStartedAt: "2026-08-04T09:00:00Z", trialDays: 14 } },
      { key: "loc4", value: { businessName: "Paying", trialStartedAt: "2026-08-04T09:00:00Z", subscriptionStatus: "active" } },
      { key: "loc5", value: { businessName: "Broken Date", createdAt: "yesterday-ish" } },
    ];

    mainChain = Promise.all([
      T.sectionNewCustomers(clients, from, now),
      T.sectionActivations(clients, from, now),
      T.sectionTrialsEnding(clients, now),
    ]).then(([signups, activations, trials]) => {
      t.ok(!!signups && signups.lines.length === 1, "one signup landed in the window");
      t.ok(/Raven Holistics/.test(signups.lines[0]), "…and it is the right one");
      t.ok(/key fob/.test(signups.lines[0]), "the hardware wording follows what they chose");
      t.ok(!/Broken Date/.test(JSON.stringify(signups)),
        "a record with an unparseable createdAt is skipped, not counted as today");

      t.ok(!!activations && activations.lines.length === 1, "one activation in the window");
      t.ok(/Old Client/.test(activations.lines[0]), "activation is keyed on trialStartedAt, not createdAt");

      t.ok(!!trials, "a trial ending inside three days is surfaced");
      t.ok(trials.alert === true, "…and it is an alert, so it sorts to the top");
      t.ok(/Lapsing/.test(JSON.stringify(trials)), "the lapsing trial is named");
      t.ok(!/Paying/.test(JSON.stringify(trials)),
        "a client who already subscribed is not chased about their trial");

      // === Taps: the snapshot delta ========================================
      const nameOf = (loc) => ({ loc1: "Raven Holistics", loc2: "Old Client" }[loc] || loc);
      return Promise.all([
        T.sectionTaps({ loc1: 12, loc2: 4 }, { loc1: 10, loc2: 4 }, nameOf),
        T.sectionTaps({ loc1: 12 }, null, nameOf),
        T.sectionTaps({ loc1: 10 }, { loc1: 10 }, nameOf),
        T.sectionTaps({ loc1: 5, loc9: 3 }, { loc1: 5 }, nameOf),
      ]).then(([delta, first, flat, brandNew]) => {
        t.ok(/2 taps/.test(delta.lines[0]), "the tap delta is counter-now minus counter-then");
        t.ok(!/Old Client/.test(JSON.stringify(delta)), "a client with no new taps is left out");
        t.ok(/First run/.test(first.lines[0]),
          "the first run says it has no baseline rather than reporting a fake zero");
        t.eq(flat, null, "a day with no taps at all produces no tap section");
        // A client absent from the baseline signed up SINCE the last digest, so
        // all their taps genuinely are new and counting them from zero is right.
        // The danger is not this case — it is a baseline that is empty because
        // the read FAILED, which would make every client look brand new. That is
        // what nextSnapshot() below exists to stop.
        t.ok(/loc9/.test(JSON.stringify(brandNew)),
          "a client who signed up since the last digest has all their taps counted");

        // === nextSnapshot — the one that would have poisoned tomorrow ========
        const prev = { finishedAt: "2026-08-16T07:00:00Z", tapTotals: { loc1: 10 } };
        const good = T.nextSnapshot(prev, { loc1: 12 }, true, "2026-08-17T07:00:00Z");
        t.eq(good.tapTotals, { loc1: 12 }, "a successful taps read advances the baseline");
        t.eq(good.finishedAt, "2026-08-17T07:00:00Z", "…and the window moves on regardless");

        const failed = T.nextSnapshot(prev, {}, false, "2026-08-17T07:00:00Z");
        t.eq(failed.tapTotals, { loc1: 10 },
          "a FAILED taps read carries the old baseline forward instead of writing {}");
        t.ok(failed.tapTotals !== null && Object.keys(failed.tapTotals).length === 1,
          "…so tomorrow does not report every client's all-time total as one day's taps");

        const firstEver = T.nextSnapshot(null, { loc1: 3 }, true, "2026-08-17T07:00:00Z");
        t.eq(firstEver.tapTotals, { loc1: 3 }, "the very first run establishes the baseline");
        const firstEverFailed = T.nextSnapshot(null, {}, false, "2026-08-17T07:00:00Z");
        t.eq(firstEverFailed.tapTotals, null,
          "a first run whose taps read failed stores null, so the next run knows it has no baseline");

        // === Delivery failures ============================================
        const statuses = [
          { key: "a", value: { status: "delivered", at: "2026-08-16T10:00:00Z", toTail: "1111" } },
          { key: "b", value: { status: "undelivered", at: "2026-08-16T11:00:00Z", toTail: "2222", errorCode: "63016" } },
          { key: "c", value: { status: "failed", at: "2026-08-16T12:00:00Z", toTail: "3333", errorCode: "21211" } },
          { key: "d", value: { status: "failed", at: "2026-08-01T12:00:00Z", toTail: "4444" } },
        ];
        return Promise.all([
          T.sectionDelivery(statuses, from, now),
          T.sectionDelivery([statuses[0]], from, now),
          T.sectionSchedulers([
            "fetch-reviews:2026-08-17T06:45:00.000Z",
            "geo-purge:2026-08-17T03:00:00.000Z",
            "weekly-report-send:2026-08-11T08:00:00.000Z",
          ], {}, now),
          T.sectionSchedulers(["fetch-reviews:2026-08-14T06:45:00.000Z"], {}, now),
          T.sectionSchedulers([], {}, now),
        ]).then(async ([bad, clean, healthy, stalled, none]) => {
          t.eq(bad.lines.length, 2, "only failed and undelivered messages are reported");
          t.ok(bad.alert === true, "an undelivered WhatsApp is an alert");
          t.ok(/24-hour window/.test(JSON.stringify(bad)),
            "error 63016 is explained as the missing-template case, not left as a number");
          t.ok(!/4444/.test(JSON.stringify(bad)), "a failure from two weeks ago is not re-reported");
          t.eq(clean, null, "a day where everything delivered produces no section");

          t.eq(healthy, null, "schedulers that ran on time produce no section");

          // === A scheduler that runs perfectly and FAILS every time ==========
          //
          // The state the old check could not see, found by the first real
          // digest on 18 Aug: fetch-reviews was firing every 15 minutes and
          // returning early on a Google token error, on a path that wrote no run
          // log at all. The email said "no run ever recorded", which sent us
          // looking for a scheduling problem that did not exist.
          const failing = await T.sectionSchedulers(
            ["fetch-reviews:2026-08-17T06:45:00.000Z",
             "geo-purge:2026-08-17T03:00:00.000Z",
             "weekly-report-send:2026-08-11T08:00:00.000Z"],
            { "fetch-reviews": { ok: false, reason: "google-token", detail: "invalid_grant" } },
            now);
          t.ok(!!failing, "a scheduler whose last run FAILED is reported…");
          t.ok(failing.alert === true, "…as an alert");
          t.ok(/last run <b>failed<\/b>/.test(JSON.stringify(failing)),
            "…saying the run failed rather than that it never happened");
          t.ok(/google-token/.test(JSON.stringify(failing)), "…with the reason");
          t.ok(/invalid_grant/.test(JSON.stringify(failing)), "…and the detail, so it is actionable");
          t.ok(!/geo-purge/.test(JSON.stringify(failing)), "a healthy scheduler is not dragged in");

          // ok:true, or no record at all, is not a failure.
          const okRun = await T.sectionSchedulers(
            ["fetch-reviews:2026-08-17T06:45:00.000Z",
             "geo-purge:2026-08-17T03:00:00.000Z",
             "weekly-report-send:2026-08-11T08:00:00.000Z"],
            { "fetch-reviews": { ok: true } }, now);
          t.eq(okRun, null, "a successful last run is silent");

          // A run that COMPLETED but failed everything it touched. This is what
          // Google-approval day looks like if the API is not enabled yet: the
          // token works, every per-client reviews call 403s, the run writes
          // ok:true, and it would have read as perfectly healthy.
          const allFailed = await T.sectionSchedulers(
            ["fetch-reviews:2026-08-17T06:45:00.000Z", "geo-purge:2026-08-17T03:00:00.000Z",
             "weekly-report-send:2026-08-11T08:00:00.000Z"],
            { "fetch-reviews": { ok: true, processed: 4, failed: 4 } }, now);
          t.ok(!!allFailed, "a run that finished but failed every item is reported");
          t.ok(allFailed.alert === true, "…as an alert");
          t.ok(/everything it tried/.test(JSON.stringify(allFailed)),
            "…and says it was everything, not just some");
          const someFailed = await T.sectionSchedulers(
            ["fetch-reviews:2026-08-17T06:45:00.000Z", "geo-purge:2026-08-17T03:00:00.000Z",
             "weekly-report-send:2026-08-11T08:00:00.000Z"],
            { "fetch-reviews": { ok: true, processed: 10, failed: 2 } }, now);
          // The count is wrapped in <b>, so match around the markup rather than
          // through it.
          t.ok(/2<\/b> items failed of 10/.test(JSON.stringify(someFailed).replace(/\\"/g, '"')),
            "a partial failure reports the proportion rather than crying wolf");
          t.ok(!/everything it tried/.test(JSON.stringify(someFailed)),
            "…and does not overstate a partial failure as a total one");
          const cleanRun = await T.sectionSchedulers(
            ["fetch-reviews:2026-08-17T06:45:00.000Z", "geo-purge:2026-08-17T03:00:00.000Z",
             "weekly-report-send:2026-08-11T08:00:00.000Z"],
            { "fetch-reviews": { ok: true, processed: 10, failed: 0 } }, now);
          t.eq(cleanRun, null, "a run with nothing failed stays silent");

          // latestRunKeys picks the newest key per scheduler, so the caller
          // fetches three records rather than every run log ever written.
          const picked = T.latestRunKeys([
            "fetch-reviews:2026-08-16T06:00:00.000Z",
            "fetch-reviews:2026-08-17T06:45:00.000Z",
            "fetch-reviews:2026-08-15T06:00:00.000Z",
            "geo-purge:2026-08-17T03:00:00.000Z",
            "daily-digest:2026-08-18T07:00:00.000Z",
          ]);
          t.eq(picked["fetch-reviews"], "fetch-reviews:2026-08-17T06:45:00.000Z",
            "latestRunKeys picks the most recent key, not the last listed");
          t.eq(picked["geo-purge"], "geo-purge:2026-08-17T03:00:00.000Z", "…for each scheduler");
          t.ok(!("daily-digest" in picked), "…and ignores schedulers it was not asked about");
          t.eq(Object.keys(T.latestRunKeys([])).length, 0, "an empty run log picks nothing");
          t.eq(Object.keys(T.latestRunKeys(null)).length, 0, "a missing run log is survivable");
          t.ok(!!stalled && stalled.alert === true, "a scheduler that stopped firing is an alert");
          t.ok(/fetch-reviews/.test(JSON.stringify(stalled)), "…and it is named");
          t.ok(!!none && /no run ever recorded/.test(JSON.stringify(none)),
            "never having run is reported differently from being late");
          // …but only for a job frequent enough that absence MEANS something.
          // A monthly job with no record may simply not be due yet, or may
          // pre-date the run log. Four red lines a morning for healthy jobs is
          // how a reader learns to skip the red box.
          t.ok(!/monthly-report-send|google-post-send|photo-refresh-send|monthly-google-sync/
            .test(JSON.stringify(none)),
            "a monthly job with no record is NOT alarmed about — absence is not evidence");
          t.ok(/fetch-reviews|geo-purge/.test(JSON.stringify(none)),
            "…while a job that should run at least daily still is");
          // A monthly job that ACTUALLY fails still surfaces immediately, which
          // is the case that matters.
          const monthlyBroke = await T.sectionSchedulers(
            ["monthly-google-sync:2026-08-01T09:00:00.000Z",
             "fetch-reviews:2026-08-17T06:45:00.000Z",
             "geo-purge:2026-08-17T03:00:00.000Z",
             "weekly-report-send:2026-08-11T08:00:00.000Z"],
            { "monthly-google-sync": { ok: false, reason: "refresh-failed", detail: "HTTP 502" } },
            now);
          t.ok(!!monthlyBroke && /monthly-google-sync/.test(JSON.stringify(monthlyBroke)),
            "a monthly job whose last run FAILED is reported the next morning");
          t.ok(/refresh-failed/.test(JSON.stringify(monthlyBroke)), "…with its reason");

          // === Reviews and stale approvals ================================
          const reviews = [
            { key: "review:loc1:2026-08:r1", value: { businessName: "Raven Holistics", rating: 5, source: "tap", status: "pending", createdAt: "2026-08-16T20:00:00Z", locationId: "loc1" } },
            { key: "review:loc1:2026-08:r2", value: { businessName: "Raven Holistics", rating: 3, status: "pending", createdAt: "2026-08-10T20:00:00Z", locationId: "loc1" } },
            { key: "review:loc2:2026-08:r3", value: { businessName: "Old Client", rating: 4, status: "approved", createdAt: "2026-08-16T21:00:00Z", locationId: "loc2" } },
          ];
          return Promise.all([
            T.sectionReviews(reviews, from, now, nameOf),
            T.sectionAwaitingApproval(reviews, now),
            T.sectionWalks([{ key: "2026-08-16:me", value: { doors: 24, signups: 2, updatedAt: "2026-08-16T17:00:00Z" } }], from, now),
            T.sectionWalks([{ key: "2026-08-01:me", value: { doors: 9, signups: 0, updatedAt: "2026-08-01T17:00:00Z" } }], from, now),
          ]).then(([revs, stale, walk, oldWalk]) => {
            t.eq(revs.lines.length, 2, "only reviews inside the window are listed");
            t.ok(/★★★★★/.test(revs.lines[0]), "the rating renders as stars");
            t.ok(/via your stand/.test(revs.lines[0]), "a tap-sourced review is marked as one");

            t.ok(!!stale && stale.alert === true, "a reply pending over 24h is an alert");
            t.eq(stale.lines.length, 1, "…and only the genuinely stale one");
            t.ok(!/r1/.test(JSON.stringify(stale)) && /Raven/.test(JSON.stringify(stale)),
              "the stale entry names the business");

            t.ok(/24 doors/.test(walk.lines[0]), "doors knocked are reported");
            t.ok(/12 doors per signup/.test(walk.lines[0]),
              "doors-per-signup — the one number nothing else can reconstruct");
            t.eq(oldWalk, null, "a walk outside the window is not re-reported");

            // === The email ==================================================
            const quiet = T.renderEmail({ from, to: now, sections: [], notes: [], firstRun: false });
            t.ok(/Nothing moved/.test(quiet.html), "a quiet day says so in one line");
            t.eq(quiet.subject, "Trey — quiet day", "…and the subject line says it too");

            const alerting = T.renderEmail({
              from, to: now, firstRun: false, notes: [],
              sections: [{ title: "Trials ending", lines: ["x"], alert: true }, { title: "Taps", lines: ["y"] }],
            });
            t.ok(/1 thing needs you/.test(alerting.subject),
              "the subject counts what needs him, so it is readable from a lock screen");

            const twoAlerts = T.renderEmail({
              from, to: now, firstRun: false, notes: [],
              sections: [{ title: "A", lines: ["x"], alert: true }, { title: "B", lines: ["y"], alert: true }],
            });
            t.ok(/2 things need you/.test(twoAlerts.subject), "…and pluralises correctly");

            // The failure mode that would make this whole thing untrustworthy.
            const broken = T.renderEmail({
              from, to: now, firstRun: false, sections: [],
              notes: ["Clients: could not be read (boom)."],
            });
            t.ok(/This digest is incomplete/.test(broken.html),
              "a section that failed is announced — an incomplete digest never poses as a quiet day");
            t.ok(/could not be read/.test(broken.html), "…with the reason");

            const firstRunMail = T.renderEmail({ from, to: now, sections: [], notes: [], firstRun: true });
            t.ok(/First digest/.test(firstRunMail.html), "the first run introduces itself");

            // Escaping survives the render, not just the helper.
            const nasty = T.renderEmail({
              from, to: now, firstRun: false, notes: [],
              sections: [{ title: '<script>alert(1)</script>', lines: ["ok"] }],
            });
            t.ok(!/<script>/.test(nasty.html), "a hostile section title cannot inject script into the email");
          });
        });
      });
    });
  }

  // === Come-back reminders ================================================
  //
  // "Come back" is the most common outcome of a cold knock and the one door you
  // most need to find again. The status recorded the intent; nothing recorded
  // WHEN, so the promise lived in Matthew's head.
  {
    const DAY = 24 * 3600_000;
    const now = Date.parse("2026-08-19T07:00:00Z");
    const lead = (name, status, when, extra) => ({
      key: name, value: Object.assign({ businessName: name, outreachStatus: status, comeBackAt: when }, extra || {}),
    });

    const leads = [
      lead("Overdue Barber", "Come back", new Date(now - 3 * DAY).toISOString()),
      lead("Yesterday Cafe", "Come back", new Date(now - 1 * DAY).toISOString()),
      lead("Today Florist",  "Come back", new Date(now + 3600_000).toISOString()),
      lead("Next Week Deli", "Come back", new Date(now + 7 * DAY).toISOString()),
      lead("No Date Garage", "Come back", ""),
      lead("Contacted Shop", "Contacted", new Date(now - DAY).toISOString()),
      lead("Junk Date Inn",  "Come back", "sometime next week"),
    ];

    comeBackChain = T.sectionComeBacks(leads, now).then((sec) => {
      t.ok(!!sec, "doors due back produce a section");
      t.ok(sec.alert === true, "…and it is an alert — it is a promise made to a person");
      t.eq(sec.lines.length, 3, "only overdue and due-today are listed");

      const body = JSON.stringify(sec);
      t.ok(/Overdue Barber/.test(body), "an overdue callback is listed");
      t.ok(/Today Florist/.test(body), "one due later today is listed");
      // The 09:00 callback must appear in the 07:00 digest. Comparing against the
      // exact minute would hide the very door the email exists to remind about.
      t.ok(/today/.test(body), "…described as due today, not omitted for being hours away");
      t.ok(!/Next Week Deli/.test(body), "a callback next week is not chased yet");
      t.ok(!/No Date Garage/.test(body), "a 'Come back' with no date has nothing to be due");
      t.ok(!/Contacted Shop/.test(body), "a lead on another status is not a callback");
      t.ok(!/Junk Date Inn/.test(body), "an unparseable date is skipped, not treated as now");

      // Most overdue first. A to-do list, not a feed — the oldest promise is the
      // most broken one, so it must not sink to the bottom.
      t.ok(sec.lines[0].indexOf("Overdue Barber") > -1, "the most overdue door is first");
      t.ok(sec.lines[1].indexOf("Yesterday Cafe") > -1, "…then yesterday's");
      t.ok(/3 days overdue/.test(sec.lines[0]), "how late it is, in words");
      t.ok(/since yesterday/.test(sec.lines[1]), "yesterday reads as yesterday, not '1 days'");
      t.ok(/2 overdue/.test(sec.title), "the heading counts the overdue ones");

      // Hostile input: business names come from Apify and a public form.
      return T.sectionComeBacks(
        [lead("<script>alert(1)</script>", "Come back", new Date(now - DAY).toISOString())], now
      ).then((nasty) => {
        t.ok(!/<script>/.test(JSON.stringify(nasty)), "a hostile business name is escaped");
        return T.sectionComeBacks([], now).then((none) => {
          t.eq(none, null, "no callbacks means no section at all");
          return T.sectionComeBacks(null, now).then((nul) => {
            t.eq(nul, null, "a missing leads store is survivable");
          });
        });
      });
    });
  }

  return Promise.all([mainChain, comeBackChain]);
};
