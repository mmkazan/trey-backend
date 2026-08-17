// Capability keys — the C2 fix.
//
// THE BUG: every client-facing page derived its key as HMAC(locationId) with no
// purpose in the signed message, so the `k` in a monthly report link was
// byte-identical to the one billing.js accepts — and billing.js cancels a live
// Stripe subscription on POST. Forwarding your report to your accountant handed
// them a cancel button.

const path = require("path");
const FN = path.join(__dirname, "..", "netlify", "functions");

function withSecret(secret, fn) {
  const prev = process.env.TREY_REPORT_SECRET;
  if (secret === null) delete process.env.TREY_REPORT_SECRET;
  else process.env.TREY_REPORT_SECRET = secret;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.TREY_REPORT_SECRET;
    else process.env.TREY_REPORT_SECRET = prev;
  }
}

exports.run = function (t) {
  const lk = require(path.join(FN, "link-keys.js"));
  const LOC = "sharp-cuts-a1b2c3";

  withSecret("test-secret-value", () => {
    // --- every purpose produces a DIFFERENT key -----------------------------
    const keys = lk.PURPOSES.map((p) => lk.linkKey(p, LOC));
    t.eq(new Set(keys).size, lk.PURPOSES.length, "each purpose yields a distinct key");
    keys.forEach((k, i) => t.ok(/^[0-9a-f]{32}$/.test(k), `${lk.PURPOSES[i]} key is 32 hex chars`));

    // --- a key opens its own page and nothing else --------------------------
    // This is the whole point of the fix. Cross-check every pair.
    for (const mintFor of lk.PURPOSES) {
      const k = lk.linkKey(mintFor, LOC);
      for (const checkAs of lk.PURPOSES) {
        const expect = mintFor === checkAs;
        t.ok(lk.linkValid(checkAs, LOC, k) === expect,
          `${mintFor} key ${expect ? "opens" : "must NOT open"} ${checkAs}`);
      }
    }

    // --- the exact regression: a report link must not reach billing ---------
    const reportK = lk.linkKey("report", LOC);
    t.ok(lk.linkValid("report", LOC, reportK), "report key opens the report");
    t.ok(!lk.linkValid("billing", LOC, reportK),
      "REGRESSION: a forwarded report link cannot cancel a subscription");
    t.ok(!lk.linkValid("account", LOC, reportK),
      "REGRESSION: a forwarded report link cannot edit contact details");

    // --- keys are location-scoped ------------------------------------------
    t.ok(!lk.linkValid("report", "someone-else-x9y8z7", reportK),
      "a key for one business does not open another's page");

    // --- malformed input fails closed, and never throws ---------------------
    t.ok(lk.linkValid("report", LOC, "") === false, "empty key rejected");
    t.ok(lk.linkValid("report", LOC, null) === false, "null key rejected");
    t.ok(lk.linkValid("report", LOC, undefined) === false, "undefined key rejected");
    t.ok(lk.linkValid("report", LOC, 12345) === false, "non-string key rejected");
    t.ok(lk.linkValid("report", LOC, "a".repeat(31)) === false, "short key rejected");
    t.ok(lk.linkValid("report", LOC, "a".repeat(33)) === false, "long key rejected");
    t.ok(lk.linkValid("nonsense", LOC, reportK) === false, "unknown purpose rejected");

    // Multibyte: 32 CHARACTERS but 64 BYTES. Four functions previously compared
    // String.length then called timingSafeEqual, which throws on a byte-length
    // mismatch — an unauthenticated 500 anyone could trigger.
    t.ok(lk.linkValid("report", LOC, "é".repeat(32)) === false,
      "multibyte key rejected without throwing");
    t.ok(lk.linkValid("report", LOC, "\u{1F600}".repeat(16)) === false,
      "emoji key rejected without throwing");

    // --- a typo in a purpose must fail loudly at the call site --------------
    t.throws(() => lk.linkKey("bilingual", LOC), "unknown purpose throws when minting");
    t.throws(() => lk.linkKey("", LOC), "empty purpose throws when minting");

    // --- linkUrl wires the right purpose to the right function -------------
    const billingUrl = lk.linkUrl("billing", LOC);
    const kInUrl = new URL(billingUrl).searchParams.get("k");
    t.ok(lk.linkValid("billing", LOC, kInUrl), "linkUrl('billing') mints a billing key");
    t.ok(!lk.linkValid("report", LOC, kInUrl), "…and that key does not open the report");
    t.throws(() => lk.linkUrl("not-a-function", LOC), "linkUrl rejects an unmapped function");
  });

  // --- a different secret yields different keys -----------------------------
  const k1 = withSecret("secret-one", () => lk.linkKey("report", LOC));
  const k2 = withSecret("secret-two", () => lk.linkKey("report", LOC));
  t.ok(k1 !== k2, "rotating the secret changes the keys");

  // --- fail closed when the secret is missing -------------------------------
  withSecret(null, () => {
    t.ok(lk.linkValid("report", LOC, "a".repeat(32)) === false,
      "validation fails closed when TREY_REPORT_SECRET is unset");
    // Minting THROWS on purpose: the old `|| ""` fallback produced a
    // plausible-looking key, so the schedulers WhatsApped every client a real
    // message containing a link that lands on "this link isn't valid".
    t.throws(() => lk.linkKey("report", LOC),
      "minting throws rather than producing a dead link");
  });
};
