// Review-alert delivery (H1/H2) and consent withdrawal (H6).

const fs = require("fs");
const path = require("path");
const FN = path.join(__dirname, "..", "netlify", "functions");
const src = (f) => fs.readFileSync(path.join(FN, f), "utf8");

exports.run = function (t) {
  // === H1: the alert that was lost and then marked "sent" =================
  //
  // The pending record was written BEFORE the Twilio send. Run 1 wrote it, the
  // send failed, 502 returned, and fetch-reviews correctly did NOT mark the
  // review seen. Fifteen minutes later the retry found that record, returned
  // deduped:true, and fetch-reviews marked it seen and counted it sent. The
  // owner never got the alert and the review was excluded from every future
  // poll. The dedupe guard and the retry guard cancelled each other out.
  const rw = src("review-webhook.js");

  t.ok(/alertSentAt/.test(rw), "review-webhook tracks alertSentAt");
  t.ok(/already && already\.alertSentAt/.test(rw),
    "REGRESSION: dedupe only short-circuits when the alert actually went out");
  t.ok(/priorRecord/.test(rw), "a committed-but-unalerted record takes a resend path");

  // Ordering: the stamp must come after the send succeeds, not before.
  const sendAt = rw.indexOf("Messages.json");
  const stampAt = rw.indexOf("alertSentAt: new Date().toISOString()");
  t.ok(sendAt > 0 && stampAt > sendAt,
    "alertSentAt is stamped only AFTER the Twilio call returns ok");

  // A resend must not redo the side effects, or the customer's own report
  // double-counts the review it is billed against.
  t.ok(/if \(!priorRecord && tapToConsume\)/.test(rw),
    "a resend does not consume the tap a second time");
  t.ok(/if \(!priorRecord\) \{\s*const stats/.test(rw),
    "a resend does not double-count the review stats");
  t.ok(/if \(!priorRecord\) try \{\s*const reviewTallyStore/.test(rw),
    "a resend does not double-count the period tallies");
  t.ok(/replyDraft = priorRecord\.replyDraft/.test(rw),
    "a resend reuses the saved draft rather than generating a different one");

  // The 502 path must leave the record unstamped so the next poll retries.
  const catchIdx = rw.indexOf("Failed to send WhatsApp message");
  t.ok(catchIdx > stampAt, "the failure path is after the stamp, so a failed send never stamps");

  // Twilio error bodies can echo the request, which contains the signed approve
  // link. Truncate before logging.
  t.ok(/slice\(0, 200\)/.test(rw), "Twilio error text is truncated before it reaches the log");

  // === H2: nothing recorded an undelivered message ========================
  //
  // Twilio returns 201 on ACCEPT, not delivery. Error 63016 (outside Meta's
  // 24-hour window) and ordinary undeliverable both happen after that 201.
  t.ok(fs.existsSync(path.join(FN, "twilio-status.js")), "twilio-status.js exists");
  const ts = src("twilio-status.js");
  t.ok(/messagestatus/.test(ts), "it writes outcomes to the messagestatus store");
  t.ok(/undelivered/.test(ts) && /failed/.test(ts), "it records undelivered and failed");
  t.ok(/console\.error/.test(ts), "a non-delivery is logged loudly");
  t.ok(/63016/.test(ts), "the 24-hour-window failure is documented in the file");
  t.ok(/toTail/.test(ts) && !/to: String\(p\.To \|\| ""\)[,\s]*$/m.test(ts),
    "only the last 4 digits of the recipient number are stored, not the full number");

  // Every sender must ask for the callback, or the outcome is still invisible.
  const senders = [
    "review-webhook.js", "tap.js", "weekly-report-send.mjs",
    "monthly-report-send.mjs", "google-post-send.mjs", "photo-refresh-send.mjs",
  ];
  for (const f of senders) {
    t.ok(/StatusCallback/.test(src(f)), `${f} sets StatusCallback`);
  }

  // === H6: a verbal opt-out that the leads screen then ignored ============
  //
  // Withdrawal set marketingConsent:false, but outreachPermissions() fell
  // through to the `status === "ltd"` branch and reported "cold email/WhatsApp
  // allowed". Only a WhatsApp STOP actually suppressed anything. So "stop
  // emailing me" at the door was recorded as evidence and then contradicted by
  // the very screen that decides whether to make contact.
  const leads = src("leads.js");

  t.ok(/optedOut: true/.test(leads), "withdrawal sets an optedOut flag on the lead");
  t.ok(/source: "verbal-withdrawal"/.test(leads),
    "withdrawal writes to the suppressed list, the same place STOP writes");
  t.ok(/SUPPRESSION WRITE FAILED/.test(leads),
    "a failed suppression write is logged loudly, not swallowed");

  // Order matters: the optedOut check must come BEFORE the ltd branch, which is
  // the branch that used to override it.
  const optedOutAt = leads.indexOf("lead.optedOut === true");
  const ltdAt = leads.indexOf('status === "ltd"');
  t.ok(optedOutAt > 0 && ltdAt > 0 && optedOutAt < ltdAt,
    "REGRESSION: optedOut is checked before the limited-company branch");

  // Withdrawal must never destroy the audit trail.
  t.ok(/consentHistory: \[\.\.\.\(existing\.consentHistory \|\| \[\]\)/.test(leads),
    "withdrawal appends to consent history rather than erasing it");

  // === H4: schedulers must not silently skip the tail of the list =========
  for (const f of ["weekly-report-send.mjs", "monthly-report-send.mjs",
                   "google-post-send.mjs", "photo-refresh-send.mjs", "fetch-reviews.mjs"]) {
    const s = src(f);
    t.ok(/runlog/.test(s), `${f} writes a run log`);
    t.ok(/timedOut|TIME_BUDGET_MS/.test(s), `${f} has a deadline`);
    t.ok(/finally/.test(s), `${f} prints its summary even on a truncated run`);
    t.ok(/CONCURRENCY/i.test(s), `${f} bounds concurrency`);
  }
  // fetch-reviews starves the SAME tail every 15 minutes without a rotating start.
  t.ok(/cursor/i.test(src("fetch-reviews.mjs")),
    "fetch-reviews rotates its start offset so no client is starved forever");
};
