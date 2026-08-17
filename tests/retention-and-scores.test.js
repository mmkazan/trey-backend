// The 30-day coordinate purge, the honest Trey Score, and the two flags that
// could never be cleared. All three are the same shape of bug: something that
// LOOKED enforced/measured/actionable and wasn't.

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const fn = (f) => fs.readFileSync(path.join(FN, f), "utf8");

// profile-audit.js is pure logic with no requires, so the scoring can be tested
// for real rather than by reading its source.
const audit = require(path.join(FN, "profile-audit.js"));

exports.run = function (t) {
  // === The coordinate purge actually happens =============================
  //
  // Google's Maps Platform terms allow lat/lng to be cached for at most 30
  // consecutive days. leads.js stripped them only inside its GET handler, so a
  // lead nobody opened kept its coordinates indefinitely. The rule was enforced
  // by an assumption about how often somebody looks at the leads page.
  const purgePath = path.join(FN, "geo-purge.mjs");
  t.ok(fs.existsSync(purgePath), "geo-purge.mjs exists");
  const purge = fs.readFileSync(purgePath, "utf8");

  // Same mechanism the other schedulers use — an exported `config`. A schedule
  // declared any other way is a function that simply never runs.
  const schedule = purge.match(/export const config = \{\s*schedule:\s*"([^"]+)"/);
  t.ok(!!schedule, "geo-purge declares an exported config.schedule like fetch-reviews.mjs");
  const cron = schedule ? schedule[1] : "";
  const fields = cron.split(/\s+/);
  t.eq(fields.length, 5, "the schedule is a 5-field cron expression");
  // Daily: a fixed minute and hour, every day of month, every month, every
  // weekday. Anything with a "*" in the hour field runs more often than daily,
  // anything restricting day-of-week runs less often.
  t.ok(/^\d+$/.test(fields[0] || ""), "runs at a fixed minute, not every minute");
  t.ok(/^\d+$/.test(fields[1] || ""), "runs at a fixed hour — i.e. once a day");
  t.eq([fields[2], fields[3], fields[4]], ["*", "*", "*"],
    "runs every day of every month (a daily sweep, not weekly or monthly)");

  // It must reuse leads.js's rules, not restate them — two copies of "when does
  // a coordinate expire" drift, and the drift is invisible.
  t.ok(/from "\.\/leads\.js"/.test(purge), "geo-purge imports the rules from leads.js");
  t.ok(/geoExpired/.test(purge) && /stripGeo/.test(purge),
    "geo-purge uses geoExpired() and stripGeo()");
  t.ok(!/const GEO_MAX_AGE_DAYS\s*=\s*\d/.test(purge),
    "geo-purge does not redefine the 30-day constant");

  const leadsJs = fn("leads.js");
  t.ok(/module\.exports\.geoExpired\s*=/.test(leadsJs), "leads.js exports geoExpired");
  t.ok(/module\.exports\.stripGeo\s*=/.test(leadsJs), "leads.js exports stripGeo");
  t.ok(/module\.exports\.GEO_MAX_AGE_DAYS\s*=/.test(leadsJs), "leads.js exports GEO_MAX_AGE_DAYS");
  // The handler export must survive the added exports, or every leads request
  // 500s and the CRM is gone.
  t.ok(/exports\.handler = async \(event\)/.test(leadsJs), "leads.js still exports its handler");
  t.ok(!/^module\.exports = \{/m.test(leadsJs),
    "leads.js never REPLACES module.exports (that would drop exports.handler)");

  // A CJS twin would be picked up by Netlify as an HTTP endpoint — an unauthed
  // one that rewrites the whole leads store.
  t.throws(() => fs.readFileSync(path.join(FN, "geo-purge.js")),
    "there is no geo-purge.js — the sweep is the scheduled .mjs only");

  // House pattern: bounded concurrency, a deadline, and a run log.
  t.ok(/PURGE_CONCURRENCY/.test(purge), "geo-purge bounds its concurrency");
  t.ok(/DEADLINE/.test(purge) && /timedOut = true/.test(purge),
    "geo-purge stops dispatching at a deadline and records that it did");
  t.ok(/blobsStore\("runlog"\)\.setJSON\(`geo-purge:/.test(purge),
    "geo-purge writes a runlog record like the other schedulers");
  for (const field of ["fn:", "startedAt:", "finishedAt:", "scanned", "purged", "failed", "remaining", "timedOut"]) {
    t.ok(purge.includes(field), `the run record carries ${field.replace(":", "")}`);
  }

  // === A failed purge write is a FAILURE, not a purge =====================
  //
  // leads.js did `.catch(() => {})` on the purge write and then counted the lead
  // as purged. A failed write therefore reported success while the coordinates
  // survived — an undetectable failure of the exact obligation being enforced.
  t.ok(!/setJSON\(b\.key, l\)\.catch\(\(\) => \{\}\)/.test(leadsJs),
    "REGRESSION: leads.js no longer swallows the purge write failure");
  t.ok(/purgeFailed/.test(leadsJs), "leads.js counts failed purge writes separately");
  // The counter must only be incremented where the write SUCCEEDED.
  const purgeBlock = leadsJs.match(/if \(geoExpired\(l, nowMs\)\) \{[\s\S]*?\n      \}/);
  t.ok(!!purgeBlock, "the read-path purge block is still there");
  const block = purgeBlock ? purgeBlock[0] : "";
  t.ok(/await leadsStore\.setJSON\(b\.key, l\);\s*\n\s*purged\+\+/.test(block),
    "purged++ happens only after the write resolves");
  t.ok(/catch[\s\S]*purgeFailed\+\+/.test(block), "a throwing write increments the failure count");
  t.ok(/console\.error\([^)]*PURGE WRITE FAILED/i.test(leadsJs) || /PURGE WRITE FAILED/.test(leadsJs),
    "a failed purge write is logged loudly, not silently");

  // Same rule in the sweep: purged means gone from the store, not attempted.
  t.ok(/await leadsStore\.setJSON\(key, stripGeo\(lead\)\);\s*\n\s*purged\+\+/.test(purge),
    "geo-purge counts a purge only after the write resolves");
  t.ok(/PURGE WRITE FAILED/.test(purge) && /failed\+\+/.test(purge),
    "geo-purge counts and logs a failed purge write");
  t.ok(!/\.catch\(\(\) => \{\}\)/.test(purge), "geo-purge swallows nothing");

  // === The score no longer scores what it never checked ===================
  //
  // (a) normalise() hard-coded attributeCount and questionCount to 0, capping
  //     the live score at 88 with two quick wins nobody could ever clear.
  // (b) the live score read client.reviewsLast90 / ownerResponseRate /
  //     postedRecently, and nothing has ever written those to a client record.
  // Comments are stripped first: the file EXPLAINS the three phantom client
  // fields at length, and a test that matched the explanation would fail the
  // moment somebody documented the bug they'd just fixed.
  const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const check = fn("profile-check.js");
  const checkCode = codeOnly(check);
  t.ok(/attributeCount: null/.test(check), "normalise() reports attributes as unmeasured, not zero");
  t.ok(/questionCount: null/.test(check), "normalise() reports Q&A as unmeasured, not zero");
  t.ok(/hasLogo: null/.test(check),
    "normalise() no longer infers a logo from the photo count");
  t.ok(!/attributeCount: 0/.test(check) && !/questionCount: 0/.test(check),
    "REGRESSION: the hard-coded zeros are gone");
  t.ok(!/client\.reviewsLast90/.test(checkCode),
    "REGRESSION: the live score no longer reads a client field nothing writes");
  t.ok(!/client\.ownerResponseRate/.test(checkCode),
    "REGRESSION: ownerResponseRate is not read off a client record");
  t.ok(!/client\.postedRecently/.test(checkCode),
    "REGRESSION: postedRecently is not read off a client record");
  // Publishing a Google Post must actually show up in the score.
  t.ok(/blobsStore\("posts"\)/.test(check) && /status !== "posted"/.test(check),
    "the score is measured from posts Trey actually published");
  t.ok(/not measurable yet/i.test(check) || /Not measurable yet/.test(check),
    "the page tells the customer what it couldn't measure");

  // --- and the behaviour, not just the source -----------------------------
  const unknownish = audit.scoreBusiness({
    reputation: { rating: 4.5, reviewCount: 40 },   // recency + reply rate unknown
    activity: {},                                   // nothing we can see
    completeness: { primaryCategory: true, phone: "01332 000000", website: "https://x" },
  });
  const keys = unknownish.unmeasured.map((u) => u.key);
  for (const k of ["reviewsLast90", "replyRate", "posted", "photos", "attributeCount"]) {
    t.ok(keys.includes(k), `${k} is reported as unmeasured`);
  }
  t.eq(unknownish.outOf, 41, "unmeasured components leave the denominator");
  t.eq(unknownish.total, 34, "only measured components earn points");
  t.eq(unknownish.pct, 83, "the band is judged on what was actually checked");
  t.ok(unknownish.outOf < 100, "the total is NOT presented out of 100");
  // The old behaviour was 44/100 ("Needs work") — a verdict on a profile nobody
  // had looked at.
  t.eq(unknownish.band, "Strong", "a good rating is not dragged down by unchecked components");

  // An explicit value — including an explicit zero — is still a measurement.
  const measuredZero = audit.scoreBusiness({
    reputation: { rating: 4.5, reviewCount: 40, reviewsLast90: 0, replyRate: 0 },
    activity: { postedRecently: false, photosSome: false },
    completeness: { primaryCategory: true, phone: "p", website: "w" },
  });
  t.eq(measuredZero.unmeasured.map((u) => u.key).includes("reviewsLast90"), false,
    "an explicit 0 is measured, not excluded");
  t.eq(measuredZero.outOf, 41 + 15 + 10 + 8 + 7, "explicit zeros stay in the denominator");
  t.eq(measuredZero.total, 34, "explicit zeros earn no points");

  // Nothing measurable at all must not read as a zero verdict.
  const nothing = audit.scoreBusiness({});
  t.eq(nothing.outOf, 0, "nothing measured means nothing to score out of");
  t.eq(nothing.pct, null, "no percentage is invented from an empty measurement");

  // Everything measured behaves exactly as it always did, out of 100.
  const full = audit.scoreBusiness({
    reputation: { rating: 4.6, reviewCount: 60, reviewsLast90: 9, replyRate: 0.8 },
    activity: { postedRecently: true, photosFresh: true },
    completeness: { primaryCategory: true, secondaryCount: 3, description: "x".repeat(130),
      serviceCount: 4, hoursSet: true, website: "w", phone: "p", attributeCount: 2 },
  });
  t.eq(full.outOf, 100, "a fully measured profile is still scored out of 100");
  t.eq(full.total, 93, "the weights themselves are unchanged");
  t.eq(full.unmeasured, [], "nothing is excluded when everything is known");

  // Lead ranking is deliberately unchanged: every lead must be scored out of the
  // same 100 or the ordering is meaningless.
  const lead = audit.estimateFromLead({ rating: 4.2, reviewCount: 30, category: "cafe", website: "x" });
  t.eq(lead.outOf, 100, "lead estimates stay on the 100-point scale");
  t.eq(lead.total, 39, "lead scoring is unchanged (leads.html mirrors this)");

  // The two phantom quick wins are gone from the completeness checker.
  const prof = audit.scoreProfile({
    primaryCategory: true, secondaryCount: 3, description: "y".repeat(130), serviceCount: 4,
    hoursSet: true, phone: "p", website: "w", photoCount: 12, openingDate: true,
    hasLogo: null, attributeCount: null, questionCount: null,
  });
  const gapKeys = prof.gaps.map((g) => g.key);
  t.ok(!gapKeys.includes("attributes"), "attributes is not listed as a fixable gap");
  t.ok(!gapKeys.includes("questions"), "Q&A is not listed as a fixable gap");
  t.eq(prof.gaps.length, 0, "a profile with everything we can see set has no phantom quick wins");
  t.eq(prof.pct, 100, "the 88-point ceiling is gone");
  t.eq(prof.outOf, 83, "the unreadable components leave the denominator instead");
  t.eq(prof.unmeasured.map((u) => u.key), ["logo", "attributes", "questions"],
    "and they are reported so the page can say why");

  // === referralCredited and needsReview can now be cleared ================
  const clientJs = fn("client.js");
  t.ok(/action === "flags"/.test(clientJs), "client.js has a dedicated flag-write path");
  t.ok(/record\.referralCredited = v/.test(clientJs), "client.js writes referralCredited");
  t.ok(/record\.needsReview = v/.test(clientJs), "client.js writes needsReview");
  // Narrow by construction: the flags path must not spread the request body.
  const flagsPath = clientJs.match(/action === "flags"\)\s*\{[\s\S]*?\n  \}/);
  t.ok(!!flagsPath, "the flags path is findable");
  const flags = flagsPath ? flagsPath[0] : "";
  t.ok(!/\.\.\.requestBody/.test(flags),
    "the flags path never spreads the request body — no arbitrary field writes");
  t.ok(/\{ \.\.\.existing \}/.test(flags), "it starts from the stored record");
  // Auth is not weakened: the whole handler is already behind adminIdentity, and
  // recording money as paid is owner-only.
  t.ok(/can\(who, "billing"\)/.test(flags),
    "marking a referral credit as applied is behind the billing gate");
  t.ok(/const who = adminIdentity\(event, requestBody\);/.test(clientJs),
    "client.js still resolves an admin identity before anything else");

  // Somebody must actually be able to reach it.
  const adminHtml = read("admin.html");
  t.ok(/action: "flags"/.test(adminHtml), "admin.html calls the flags path");
  t.ok(/needsReview: false/.test(adminHtml), "admin.html can clear needsReview");
  t.ok(/referralCredited: true/.test(adminHtml), "admin.html can set referralCredited");
  t.ok(/function markReviewed/.test(adminHtml) && /function markCreditApplied/.test(adminHtml),
    "both actions exist as their own functions");
  t.ok(/markReviewed\("\$\{esc\(c\.locationId\)\}"\)/.test(adminHtml),
    "the Reviewed button escapes the locationId it renders");
  t.ok(/markCreditApplied\("\$\{esc\(r\.locationId\)\}"\)/.test(adminHtml),
    "the credit button escapes the locationId it renders");
  t.ok(/esc\(r\.businessName \|\| r\.locationId\)/.test(adminHtml),
    "the referred business name is escaped before rendering");
  // The new actions must not have introduced token storage of their own —
  // admin.html uses sessionStorage for the token on purpose (localStorage there
  // is only the backup-reminder bookkeeping).
  t.ok(!/localStorage\.setItem\(\s*["']treyAdminToken/.test(adminHtml),
    "admin.html still keeps the token out of localStorage");
  t.ok(/sessionStorage\.setItem\("treyAdminToken"/.test(adminHtml),
    "admin.html still stores the token in sessionStorage");

  // signup.js is still the only place that raises them, so the loop is closed
  // rather than duplicated.
  const signupJs = fn("signup.js");
  t.ok(/referralCredited: false/.test(signupJs), "signup.js still starts a referral uncredited");
  t.ok(/needsReview: true/.test(signupJs), "signup.js still flags a self-serve signup for review");
};
