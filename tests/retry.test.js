// Retrying a send.
//
// THE GAP: the four scheduled senders caught a failed Twilio call, counted it,
// logged it and moved on. No retry at all. And because every idempotency marker
// embeds the PERIOD it covers — `weekly:<loc>:<wKey>`, `monthly:<loc>:<mKey>` —
// the next run looks for a different key entirely and never comes back to it.
// So a ninety-second Twilio blip on the 1st did not DELAY a client's report, it
// LOST it, permanently and silently, with one console line as the only trace.
//
// These run the real helper. No clock mocking: the delays are set to 1ms so the
// suite stays fast, and the deadline cases use real timestamps.

const path = require("path");
const FN = path.join(__dirname, "..", "netlify", "functions");
const { withRetry, isTransient } = require(path.join(FN, "retry.js"));

exports.run = async function (t) {
  // === What is worth retrying ============================================
  // Retrying something Twilio has already refused on its merits burns the run's
  // time budget and counts against the rate limit, and cannot succeed.
  t.ok(isTransient(new Error("Twilio 503: upstream")), "5xx is transient");
  t.ok(isTransient(new Error("Twilio 500: boom")), "500 is transient");
  t.ok(isTransient(new Error("Twilio 429: too many requests")), "429 is transient — backing off IS the fix");
  t.ok(isTransient(new Error("fetch failed")), "a network error with no status is transient");
  t.ok(isTransient(new Error("The operation was aborted")), "a timeout is transient");
  // 21211 is the one that matters: a badly stored phone number. It is a 400, it
  // needs a human, and hammering it delays the twenty clients queued behind it.
  t.ok(!isTransient(new Error("Twilio 400: 21211 The 'To' number is not a valid phone number")),
    "a rejected phone number is NOT retried");
  t.ok(!isTransient(new Error("Twilio 401: authenticate")), "401 is not retried");
  t.ok(!isTransient(new Error("Twilio 404: no such content sid")), "404 is not retried");

  // === It actually retries, and stops when it succeeds ====================
  {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("Twilio 503: try again");
      return "sent";
    }, { baseDelayMs: 1 });
    t.eq(out, "sent", "a send that succeeds on the third go returns its value");
    t.eq(calls, 3, "…and it took exactly three attempts");
  }
  {
    let calls = 0;
    await withRetry(async () => { calls++; return "ok"; }, { baseDelayMs: 1 });
    t.eq(calls, 1, "a send that works first time is not retried");
  }

  // === It gives up, and says why ==========================================
  {
    let calls = 0;
    let err = null;
    try {
      await withRetry(async () => { calls++; throw new Error("Twilio 503: still down"); },
        { attempts: 3, baseDelayMs: 1 });
    } catch (e) { err = e; }
    t.ok(!!err, "a permanently failing send still throws");
    t.eq(calls, 3, "…after exactly the configured number of attempts");
    t.eq(err.attempts, 3, "…and reports how many it made");
    t.eq(err.gaveUpEarly, "", "…with no early-exit reason, because it used them all");
  }
  {
    let calls = 0, err = null;
    try {
      await withRetry(async () => { calls++; throw new Error("Twilio 400: 21211 bad number"); },
        { attempts: 3, baseDelayMs: 1 });
    } catch (e) { err = e; }
    t.eq(calls, 1, "a rejected request is tried ONCE, not three times");
    t.eq(err.gaveUpEarly, "permanent", "…and says it stopped because Twilio judged it");
  }

  // === The deadline is load-bearing =======================================
  // A scheduled function gets 15 minutes. Sleeping through a backoff and then
  // starting a send the platform kills halfway leaves a client who may or may
  // not have been messaged — worse than not retrying at all.
  {
    let calls = 0, err = null;
    const past = Date.now() - 1000;   // already overrun
    try {
      await withRetry(async () => { calls++; throw new Error("Twilio 503: down"); },
        { attempts: 5, baseDelayMs: 50, deadline: past });
    } catch (e) { err = e; }
    t.eq(calls, 1, "no retry is started once the run is out of time");
    t.eq(err.gaveUpEarly, "deadline", "…and it says so, rather than looking like a Twilio fault");
  }
  {
    // A deadline far enough away still allows the retry.
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("Twilio 503: blip");
      return "sent";
    }, { baseDelayMs: 1, deadline: Date.now() + 60_000 });
    t.eq(out, "sent", "a comfortable deadline does not block a retry");
    t.eq(calls, 2, "…and the retry happened");
  }

  // === Backoff actually waits =============================================
  {
    const started = Date.now();
    let calls = 0;
    try {
      await withRetry(async () => { calls++; throw new Error("Twilio 503"); },
        { attempts: 3, baseDelayMs: 20, maxDelayMs: 100 });
    } catch (e) { /* expected */ }
    const elapsed = Date.now() - started;
    // 20ms then 40ms = 60ms of waiting, minimum.
    t.ok(elapsed >= 55, `backoff waits between attempts (waited ${elapsed}ms)`);
  }

  // A logging callback must never be able to break a send.
  {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("Twilio 503");
      return "sent";
    }, { baseDelayMs: 1, onRetry: () => { throw new Error("logger exploded"); } });
    t.eq(out, "sent", "a throwing onRetry callback does not break the retry");
  }

  // === Every sender uses it ===============================================
  // One shared helper, not four copies — this repo has already had eight copies
  // of toE164 drift apart, and four of them were missing a fix.
  const fs = require("fs");
  for (const f of ["weekly-report-send.mjs", "monthly-report-send.mjs",
                   "google-post-send.mjs", "photo-refresh-send.mjs"]) {
    const src = fs.readFileSync(path.join(FN, f), "utf8");
    t.ok(/from "\.\/retry\.js"/.test(src), `${f} imports the shared retry helper`);
    t.ok(/withRetry\(\(\) => sendWhatsApp\(params\)/.test(src), `${f} sends through it`);
    t.ok(/deadline: DEADLINE/.test(src), `${f} passes its run deadline, so a retry cannot overrun`);
    // The failure line must distinguish a rejected number from a run that ran
    // out of time: one needs a human, the other fixes itself next period.
    t.ok(/gaveUpEarly === "permanent"/.test(src), `${f} reports WHY a send was abandoned`);
    // And no hand-rolled retry loop alongside it.
    t.ok(!/for\s*\(\s*let\s+retr/i.test(src), `${f} has no second, hand-rolled retry loop`);
  }
};
