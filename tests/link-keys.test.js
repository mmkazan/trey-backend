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

  // === The /i/:token short link ===========================================
  //
  // ADDED 17 Aug. The activation WhatsApp used to paste a naked inbox URL into
  // the message body because a WhatsApp URL-BUTTON variable must be a plain
  // suffix on a fixed base — it cannot carry `?loc=…&k=…`. So the inbox link is
  // now expressible as one opaque token, `<32 hex key><locationId>`, behind the
  // /i/:t rewrite. This is an AUTH path, so it gets the same treatment as the
  // rest of this file: the split must be exact, and every malformed shape must
  // fail closed rather than resolve to something.
  {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(FN, "inbox.js"), "utf8");

    // Lift readLink() out and run it for real, rather than pattern-matching it.
    const start = src.indexOf("function readLink(");
    let readLinkSrc = "";
    if (start >= 0) {
      let i = src.indexOf("{", start), depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") { depth--; if (depth === 0) { readLinkSrc = src.slice(start, j + 1); break; } }
      }
    }
    t.ok(!!readLinkSrc, "inbox.js has a readLink() that resolves both link forms");
    // If readLink is missing, report that ONCE and carry on. Letting the eval
    // throw would abort the suite and take the ten assertions below with it —
    // the _redirects rule and tap.js's variable are checked down there, and a
    // run that silently stops testing them is how a regression net rots.
    const readLink = readLinkSrc
      ? eval("(function(){ " + readLinkSrc + " return readLink; })()")
      : null;

    if (readLink) withSecret("test-secret-value", () => {
      const key = lk.linkKey("inbox", LOC);
      const token = key + LOC;

      // --- the short form ---------------------------------------------------
      const short = readLink({ queryStringParameters: { r: token } });
      t.eq(short.loc, LOC, "the token's tail is the locationId");
      t.eq(short.k, key, "the token's first 32 chars are the key");
      t.ok(lk.linkValid("inbox", short.loc, short.k),
        "a token built from linkKey verifies once split — the round trip closes");

      // --- the long form still works ---------------------------------------
      // Every link already sent by email, WhatsApp or the admin panel uses it.
      const long = readLink({ queryStringParameters: { loc: LOC, k: key } });
      t.eq(long.loc, LOC, "the two-parameter form still resolves");
      t.eq(long.k, key, "…with its key");

      // --- the path fallback -----------------------------------------------
      // On 15 Aug a _redirects rule fired but did not substitute into the
      // destination QUERY STRING, and every NFC tag minted from admin was dead.
      // Reading the token off the path too means a repeat is survivable.
      const viaPath = readLink({ queryStringParameters: {}, path: "/i/" + token });
      t.eq(viaPath.loc, LOC, "the token is also read straight from the request path");
      t.eq(viaPath.k, key, "…key included, if the rewrite drops the query string");

      // --- everything malformed must fail CLOSED ---------------------------
      t.eq(readLink({ queryStringParameters: {} }).loc, "",
        "no token and no loc resolves to nothing, which the handler 400s");
      t.eq(readLink({ queryStringParameters: { r: "" } }).loc, "",
        "an empty token resolves to nothing");
      // A token shorter than the key must NOT yield an empty key that then gets
      // compared against something — it must yield no location at all.
      t.eq(readLink({ queryStringParameters: { r: "abc" } }).loc, "",
        "a token shorter than the key yields no location");
      const truncated = readLink({ queryStringParameters: { r: key } });
      t.eq(truncated.loc, "", "a token that is ONLY a key has no location to open");

      // A tampered key must not validate, however well-formed the token looks.
      const forged = readLink({ queryStringParameters: { r: "0".repeat(32) + LOC } });
      t.eq(forged.loc, LOC, "a forged token still parses…");
      t.ok(!lk.linkValid("inbox", forged.loc, forged.k), "…but does not validate");

      // Cross-purpose still blocked through the new door — the C2 fix must hold
      // for the short form exactly as it does for the long one.
      const billingTok = lk.linkKey("billing", LOC) + LOC;
      const viaBilling = readLink({ queryStringParameters: { r: billingTok } });
      t.ok(!lk.linkValid("inbox", viaBilling.loc, viaBilling.k),
        "a billing key packed into an inbox token does not open the inbox");
    });

    // --- the rewrite itself ------------------------------------------------
    const redirects = fs.readFileSync(path.join(__dirname, "..", "_redirects"), "utf8");
    t.ok(/^\/i\/:t\s+\/\.netlify\/functions\/inbox\?r=:t\s+200/m.test(redirects),
      "_redirects maps /i/:t to inbox with a NAMED placeholder, not :splat");
    t.ok(!/\/i\/\*/.test(redirects),
      "…not the splat form, which silently failed to substitute into a query string");

    // --- and tap.js sends the token, not the URL ---------------------------
    const tap = fs.readFileSync(path.join(FN, "tap.js"), "utf8");
    t.ok(/function inboxToken\(/.test(tap), "tap.js can mint the single-token form");
    t.ok(/3: inboxTok/.test(tap),
      "the activation template's {{3}} is the button SUFFIX, not a full URL");
    t.ok(/inbox: inboxUrl\(locationId\)/.test(tap),
      "…while the email keeps the long URL, which has no button constraint");
  }

  // === safeEqual — the multibyte 500 ======================================
  //
  // Three functions hand-rolled the admin-token compare as
  //   provided.length === expected.length && crypto.timingSafeEqual(...)
  // String.length counts UTF-16 code units; Buffer.from counts BYTES. A token
  // with any non-ASCII character passed that guard and then threw INSIDE
  // timingSafeEqual, turning an unauthenticated request into a 500 on demand.
  // It failed closed, so never a bypass — but a stranger could make the function
  // throw at will, and this file has documented the correct pattern all along.
  {
    const TOKEN = "correct-horse-battery-staple";
    t.ok(lk.safeEqual(TOKEN, TOKEN) === true, "safeEqual matches an identical token");
    t.ok(lk.safeEqual(TOKEN, TOKEN + "x") === false, "…and rejects a longer one");
    t.ok(lk.safeEqual("", "") === false, "an EMPTY expected token never matches, even against empty");
    t.ok(lk.safeEqual(TOKEN, "") === false, "an unset token never matches anything");
    t.ok(lk.safeEqual("", TOKEN) === false, "an empty attempt never matches a real token");

    // The actual bug: 32 characters, more than 32 bytes.
    const multibyte = "é".repeat(TOKEN.length);
    t.eq(multibyte.length, TOKEN.length, "the probe really is the same STRING length…");
    t.ok(Buffer.byteLength(multibyte, "utf8") !== Buffer.byteLength(TOKEN, "utf8"),
      "…and a different BYTE length, which is what used to throw");
    t.ok(lk.safeEqual(multibyte, TOKEN) === false,
      "REGRESSION: a multibyte token of equal string length returns false instead of throwing");

    // Every junk shape fails closed rather than exploding.
    for (const junk of [null, undefined, 0, 1, {}, [], true, Buffer.from("x")]) {
      t.ok(lk.safeEqual(junk, TOKEN) === false, `safeEqual(${typeof junk}) fails closed`);
      t.ok(lk.safeEqual(TOKEN, junk) === false, `safeEqual(_, ${typeof junk}) fails closed`);
    }

    // And the call sites actually use it — the point of centralising.
    const fs = require("fs");
    for (const f of ["inbox.js", "report.js", "refer.js"]) {
      const s = fs.readFileSync(path.join(FN, f), "utf8");
      t.ok(/safeEqual\(provided, expected\)/.test(s), `${f} compares the admin token with safeEqual`);
      t.ok(!/provided\.length === expected\.length/.test(s),
        `${f} no longer compares String.length before timingSafeEqual`);
    }
  }
};
