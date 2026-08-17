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

  // === Consent: every WhatsApp to a client honours the opt-out ============
  //
  // THE BUG THIS SWEEP EXISTS TO CATCH. Five senders checked an opt-out flag
  // before messaging a client. review-webhook.js — the most frequent message
  // Trey sends — checked NONE: not reportsOptOut, not nudgesOptOut, not the
  // suppressed list. So a client who replied STOP kept getting review alerts
  // while whatsapp-inbound told them "you won't get any more messages from
  // Trey". Failing to honour an opt-out is the classic PECR enforcement
  // trigger, and it survived because every test asked about one file at a time.
  //
  // So this asks the question of ALL of them at once: if you post to Twilio
  // about a client, you check an opt-out first. A new sender added without one
  // fails here on the day it is written.
  const CLIENT_SENDERS = [
    "review-webhook.js", "tap.js",
    "weekly-report-send.mjs", "monthly-report-send.mjs",
    "google-post-send.mjs", "photo-refresh-send.mjs",
  ];
  for (const f of CLIENT_SENDERS) {
    const s = src(f);
    t.ok(/Messages\.json/.test(s), `${f} does send WhatsApp (the sweep is looking at the right file)`);
    t.ok(/reportsOptOut|nudgesOptOut/.test(s),
      `${f} checks an opt-out flag before messaging a client`);
  }

  // Behavioural, not just textual: the guard has to sit BEFORE the send.
  {
    const s = src("review-webhook.js");
    const guardAt = s.indexOf("const optedOut");
    const sendAt = s.indexOf("Messages.json");
    t.ok(guardAt > 0, "review-webhook computes an opted-out check");
    t.ok(guardAt < sendAt, "…and it is evaluated BEFORE the Twilio call, not after");
    t.ok(/alertSuppressed/.test(s),
      "a suppressed alert is recorded as suppressed, not left looking unsent");
    // The review itself must survive. Opting out of messages is not opting out
    // of the product — their inbox link still works and the reply is still there.
    const optBlock = s.slice(guardAt, sendAt);
    t.ok(/reviewsStore\.setJSON/.test(optBlock),
      "the review is still stored when the alert is suppressed — nothing is lost");
    t.ok(!/alertSentAt: new Date/.test(optBlock),
      "…and it is NOT stamped as alerted, which would hide it from every retry");
  }

  // === STOP says what it costs ===========================================
  //
  // Trey IS a WhatsApp service. "Messages off" is not a volume control, it
  // disconnects them — and the old reply said only "you won't get any more
  // messages", which read like a preference rather than a consequence.
  {
    const wi = src("whatsapp-inbound.js");
    const reply = (wi.match(/const STOP_REPLY =([\s\S]*?);\n/) || [])[1] || "";
    t.ok(!!reply, "whatsapp-inbound has a STOP_REPLY");
    t.ok(/WhatsApp/.test(reply), "the STOP reply says Trey works over WhatsApp");
    t.ok(/review/i.test(reply), "…names what stops working — the review alerts");
    t.ok(/START/.test(reply), "…and how to undo it");
    t.ok(/cancel/i.test(reply),
      "…and where to go if they meant cancel rather than silence, which is the likelier intent");
    // The specific false promise that was there before.
    t.ok(!/won't get any more messages from Trey/.test(reply),
      "REGRESSION: the reply no longer promises a silence it cannot deliver");

    // STOP must still be handled first and always, printed or not.
    t.ok(/STOP_WORDS/.test(wi), "STOP keywords are still matched");
    const stopAt = wi.indexOf("STOP_WORDS.includes");
    const welcomeAt = wi.indexOf("welcome to Trey");
    t.ok(stopAt > 0 && welcomeAt > 0, "both the STOP branch and the welcome exist");

    // The welcome no longer advertises the off switch for the channel the
    // product runs on. Everything Trey sends a subscriber is the service they
    // bought, so PECR's opt-out line is not required on it.
    // Comments stripped first. The code carries a note explaining which line was
    // REMOVED and why — a check that reads prose finds the removed text quoted
    // back at it and fails a correct file. This is the second time that has
    // happened today; strip before you match.
    const welcome = wi.slice(welcomeAt, welcomeAt + 1600)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    t.ok(!/Reply STOP any time/.test(welcome),
      "the welcome auto-reply no longer prompts STOP");
    t.ok(/tap approve/.test(welcome), "…and still explains the loop it replaced it with");
  }

  // === The win-back is the one that WILL need an opt-out ==================
  //
  // A monthly "you got X taps and Y reviews and answered none of them" sent to
  // someone who is NOT subscribing is direct marketing to a lapsed customer —
  // the only Trey message that is. It is not built yet, and this asserts that:
  // if it ever starts going to cancelled clients, the assertion below fails and
  // whoever built it has to come back and read why.
  {
    const m = src("monthly-report-send.mjs");
    t.ok(/isSendable/.test(m), "the monthly report gates who it sends to");
    t.ok(/cancelled|canceled/.test(m),
      "…and currently excludes cancelled clients, so no marketing goes out yet");
    t.ok(/reportsOptOut === true\) return false/.test(m),
      "…and honours the opt-out flag");
  }
};
