// tests/security-review-2026-08-18.test.js
//
// Regression net for the High/Medium fixes from the 18 Aug 2026 security review.
// Behavioural where the logic could be extracted to a dependency-free module
// (stripe-ordering, csv-lib, generate-reply.stripLinks, digest-lib.nextSnapshot);
// source-pattern where the change lives inside a blob-backed handler that can't
// be required without @netlify/blobs.
//
// EVERY assertion in this file FAILS on the pre-fix code — verified by running
// this suite against the repo with the changes stashed. A test that passes on
// broken code is worthless.

const fs = require("fs");
const path = require("path");
const FN = path.join(__dirname, "..", "netlify", "functions");
const fn = (f) => fs.readFileSync(path.join(FN, f), "utf8");
const readRoot = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const { shouldApplyEvent } = require(path.join(FN, "stripe-ordering.js"));
const { csvCell, csvSafe } = require(path.join(FN, "csv-lib.js"));
const { stripLinks } = require(path.join(FN, "generate-reply.js"));
const digest = require(path.join(FN, "digest-lib.js"));

exports.run = function (t) {
  // === H1 — Stripe event ordering guard ==================================
  // A redelivered older invoice.paid must NOT reactivate a cancelled account.
  t.eq(shouldApplyEvent({ subscriptionStatus: "cancelled", subscriptionEventAt: 200 }, "active", 100), false,
    "H1: stale invoice.paid (created 100) is rejected against a cancel applied at 200");
  t.eq(shouldApplyEvent({ subscriptionStatus: "cancelled", subscriptionEventAt: 200 }, "active", 200), false,
    "H1: an event tying on the second cannot reopen a cancelled subscription");
  t.eq(shouldApplyEvent({ subscriptionStatus: "cancelled", subscriptionEventAt: 200 }, "active", 300), true,
    "H1: a genuinely newer checkout (created 300) may re-subscribe a cancelled account");
  t.eq(shouldApplyEvent({ subscriptionStatus: "active", subscriptionEventAt: 200 }, "paused", 100), false,
    "H1: a late payment_failed cannot pause an account a newer event already made active");
  t.eq(shouldApplyEvent({ subscriptionStatus: "active", subscriptionEventAt: 100 }, "paused", 200), true,
    "H1: forward progression (active -> paused) with a newer event is applied");
  t.eq(shouldApplyEvent({}, "active", 100), true,
    "H1: a first-ever event (no stored clock) always applies");
  t.eq(shouldApplyEvent({ subscriptionStatus: "active" }, "paused", 0), true,
    "H1: a legacy record with no clock is never stuck");

  // Wiring: setStatus threads the event's created time, and the handler passes it.
  const sw = fn("stripe-webhook.js");
  t.ok(/require\(["']\.\/stripe-ordering["']\)/.test(sw), "H1: stripe-webhook requires the ordering module");
  t.ok(/function setStatus\(locationId, status, extra, eventCreated\)/.test(sw),
    "H1: setStatus takes eventCreated");
  t.ok(/shouldApplyEvent\(client, status, eventCreated\)/.test(sw),
    "H1: setStatus consults the ordering guard before writing");
  t.ok(/subscriptionEventAt/.test(sw), "H1: setStatus persists the applied event clock");
  t.ok(/const eventCreated = Number\(stripeEvent\.created\)/.test(sw),
    "H1: the handler reads stripeEvent.created");
  // invoice.paid must pass eventCreated (the exact line the bug lived on).
  t.ok(/setStatus\(locationId, "active", \{ lastPaymentAt: new Date\(\)\.toISOString\(\) \}, eventCreated\)/.test(sw),
    "H1: the invoice.paid handler passes eventCreated to setStatus");

  // === H2 — own-only-your-fields: re-read before write ===================
  const rgs = fn("refresh-google-stats.js");
  t.ok(/const fresh = \(await clientsStore\.get\(client\.locationId, \{ type: "json" \}\)\) \|\| client;/.test(rgs)
    && /\.\.\.fresh,\s*\n\s*googleRating: r\.rating \?\? fresh\.googleRating/.test(rgs),
    "H2: refresh-google-stats re-reads and merges onto fresh, not the pre-Places-call copy");

  const bill = fn("billing.js");
  const billFreshReads = (bill.match(/const fresh = \(await clientsStore\.get\(loc, \{ type: "json" \}\)\) \|\| client;/g) || []).length;
  t.ok(billFreshReads >= 2, "H2: billing re-reads before BOTH the POST write and the GET reconcile write");
  t.ok(!/setJSON\(loc, \{\s*\.\.\.client,\s*cancelAtPeriodEnd/.test(bill),
    "H2: billing no longer spreads the stale client into a status-bearing write");

  const tap = fn("tap.js");
  t.ok(/const fresh = \(await clientsStore\.get\(locationId, \{ type: "json" \}\)\) \|\| client;/.test(tap)
    && /setJSON\(locationId, \{ \.\.\.fresh, trialStartedAt:/.test(tap),
    "H2: tap activation re-reads and merges only trialStartedAt onto fresh");

  const acc = fn("account.js");
  t.ok(/const fresh = \(await clientsStore\.get\(loc, \{ type: "json" \}\)\) \|\| existing;/.test(acc)
    && /record\[guarded\] = fresh\[guarded\];/.test(acc),
    "H2: account takes protected fields from a fresh re-read, not the stale snapshot");

  // === M1 — Referrer-Policy on capability pages ==========================
  for (const f of ["inbox.js", "account.js", "billing.js"]) {
    t.ok(/<meta name="referrer" content="no-referrer">/.test(fn(f)),
      `M1: ${f} shell sets Referrer-Policy no-referrer so the capability key can't leak via Referer`);
  }

  // === M2 — prompt-injection defence in the review-reply path ============
  const gr = fn("generate-reply.js");
  t.ok(/UNTRUSTED DATA — NOT INSTRUCTIONS/.test(gr),
    "M2: the review comment is fenced as untrusted data in the prompt");
  t.ok(/0\. Untrusted input:/.test(gr) && /0b\. No links or contact bait:/.test(gr),
    "M2: the prompt tells the model to ignore embedded instructions and never emit links");
  t.ok(/stripLinks\(text\.trim\(\)\)/.test(gr),
    "M2: the model output is passed through the link stripper before being returned");
  // Behavioural: stripLinks removes attacker links, keeps a clean reply.
  t.ok(stripLinks("Thanks! Visit http://scam.example/refund now").removed >= 1
    && !/scam\.example/.test(stripLinks("Visit http://scam.example now").text),
    "M2: stripLinks removes an http link");
  t.ok(!/phish\.io/.test(stripLinks("go to www.phish.io today").text), "M2: stripLinks removes a www link");
  t.ok(!/evil@bad/.test(stripLinks("email evil@bad.co.uk").text), "M2: stripLinks removes an email");
  t.ok(!/bad-site\.shop/.test(stripLinks("see bad-site.shop please").text), "M2: stripLinks removes a bare domain");
  const clean = stripLinks("Hi Jane, thank you for the kind words — do call us on 01332 555123 if we can help.");
  t.eq(clean.removed, 0, "M2: a clean reply (name + phone, no links) is left untouched");
  t.ok(/01332 555123/.test(clean.text) && /Jane/.test(clean.text), "M2: the phone number and name survive stripping");

  // === M3 — CSV / formula injection ======================================
  t.eq(csvSafe("=HYPERLINK(1)"), "'=HYPERLINK(1)", "M3: a leading = is neutralised");
  t.eq(csvSafe("@SUM(A1)"), "'@SUM(A1)", "M3: a leading @ is neutralised");
  t.eq(csvSafe("+cmd"), "'+cmd", "M3: a leading + on non-numeric text is neutralised");
  t.eq(csvSafe("-cmd|calc"), "'-cmd|calc", "M3: a leading - on non-numeric text is neutralised");
  t.eq(csvSafe("-5"), "-5", "M3: a negative number is left alone");
  t.eq(csvSafe("42"), "42", "M3: a plain number is left alone");
  t.eq(csvCell("=a,b"), '"\'=a,b"', "M3: a formula cell that also needs quoting is both neutralised and quoted");
  t.eq(csvCell("Joe Bloggs"), "Joe Bloggs", "M3: ordinary text is unchanged");
  // Both export paths carry the guard.
  t.ok(/require\(["']\.\/csv-lib\.js["']\)/.test(fn("export.js")), "M3: export.js uses the shared csv lib");
  t.ok(/\/\^\[=\+\\-@\\t\\r\]\/\.test\(v\)/.test(readRoot("leads.html")),
    "M3: leads.html client-side CSV export carries the same formula guard");

  // === M4 — daily digest window gap ======================================
  const snap = digest.nextSnapshot({ tapTotals: { a: 1 } }, { a: 2 }, true, "2023-11-14T22:20:00.000Z", "2023-11-14T22:13:20.000Z");
  t.eq(snap.windowTo, "2023-11-14T22:13:20.000Z", "M4: nextSnapshot records the window's upper bound (now), not finishedAt");
  t.ok(snap.windowTo !== snap.finishedAt, "M4: windowTo and finishedAt are distinct");
  const legacy = digest.nextSnapshot({}, { a: 2 }, true, "2023-11-14T22:20:00.000Z");
  t.eq(legacy.windowTo, legacy.finishedAt, "M4: a state written before windowTo existed falls back to finishedAt");
  const dd = fn("daily-digest.mjs");
  t.ok(/state\.windowTo != null \? state\.windowTo/.test(dd),
    "M4: the next run starts from the previous windowTo");
  t.ok(/nextSnapshot\(state, tapTotals, tapsOk, finishedAt, iso\(now\)\)/.test(dd),
    "M4: daily-digest passes iso(now) as the window upper bound");

  // === M5 — review-webhook atomic commit order ===========================
  const rw = fn("review-webhook.js");
  const pendingWrite = rw.indexOf('await reviewsStore.setJSON(`pending:${reviewId}`, reviewRecord)');
  const tapConsume = rw.indexOf("await tapsStore.setJSON(locationId, { ...tapToConsume, processed: true })");
  const statsWrite = rw.indexOf("await statsStore.setJSON(locationId, stats)");
  t.ok(pendingWrite > 0 && tapConsume > 0 && statsWrite > 0, "M5: the three commit writes are all present");
  t.ok(pendingWrite < tapConsume, "M5: the idempotency record is written BEFORE the tap is consumed");
  t.ok(pendingWrite < statsWrite, "M5: the idempotency record is written BEFORE the counters are incremented");
};
