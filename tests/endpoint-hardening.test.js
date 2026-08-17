// Public-endpoint hardening — signup.js and tap.js (17 Aug 2026).
//
// Three bugs, all on endpoints anyone on the internet can hit:
//
//   1. signup.js had NO rate limit. Every request mailed an attacker-chosen
//      address from a domain with real DKIM and wrote a permanent record.
//   2. tap.js's activate POST needed nothing but the locationId — which is
//      printed on the stand and encoded in the QR — so a stranger could start a
//      trial while the stand was still in the courier's van.
//   3. tap.js's redirect allow-list accepted ALL of *.google.com, including
//      sites.google.com and script.google.com, both of which serve arbitrary
//      third-party content. googleReviewUrl comes from the PUBLIC signup form.

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");

const src = (f) => fs.readFileSync(path.join(FN, f), "utf8");

// tap.js is a Netlify handler, not a module of exports, so the pieces under test
// are lifted out of the source and evaluated — same approach as
// xss-and-storage.test.js. It also means the test fails loudly if the function
// is renamed or moved rather than silently testing nothing.
function lift(source, firstDecl, fnName) {
  const start = source.indexOf(firstDecl);
  if (start < 0) throw new Error(`could not find "${firstDecl}" in source`);
  const fnStart = source.indexOf(`function ${fnName}`, start);
  if (fnStart < 0) throw new Error(`could not find function ${fnName}`);
  const fnEnd = source.indexOf("\n}\n", fnStart);
  if (fnEnd < 0) throw new Error(`could not find the end of ${fnName}`);
  const block = source.slice(start, fnEnd + 3);
  return eval(`${block}\n${fnName}`);
}

exports.run = function (t) {
  const tapJs = src("tap.js");
  const signupJs = src("signup.js");

  // === The Google redirect allow-list ======================================
  const allowedGoogleUrl = lift(tapJs, "const GOOGLE_TARGETS", "allowedGoogleUrl");

  // --- genuine review destinations must still work -------------------------
  // If this list breaks, every stand in the field stops going where the shop
  // asked it to go — a worse outage than the bug being fixed.
  const ACCEPT = [
    "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
    "https://g.page/r/CQoQoiSSXQlaEBM/review",
    "https://www.g.page/r/CQoQoiSSXQlaEBM/review",
    "https://maps.app.goo.gl/aBcDeFgH123",
    "https://www.google.com/maps/place/Sharp+Cuts/@51.5074,-0.1278,17z",
    "https://maps.google.com/maps?cid=1234567890",
    "https://google.com/maps/place/Sharp+Cuts",
  ];
  for (const url of ACCEPT) {
    t.ok(allowedGoogleUrl(url) !== null, `ACCEPTS a genuine review URL: ${url}`);
  }

  // --- google.com origins that serve anybody's content ---------------------
  // The whole point of the narrowing. An address bar reading "google.com" is the
  // most convincing possible place to ask a customer for their Google password.
  t.eq(allowedGoogleUrl("https://sites.google.com/view/trey-login/home"), null,
    "REGRESSION: sites.google.com is rejected (anyone can publish a page there)");
  t.eq(allowedGoogleUrl("https://sites.google.com/maps"), null,
    "sites.google.com is rejected even on a /maps path");
  t.eq(allowedGoogleUrl("https://script.google.com/macros/s/AKfycbxSCRIPTID/exec"), null,
    "REGRESSION: script.google.com is rejected (anyone can deploy an Apps Script)");
  for (const host of ["docs", "drive", "groups"]) {
    t.eq(allowedGoogleUrl(`https://${host}.google.com/anything`), null,
      `${host}.google.com is rejected`);
  }

  // --- scheme and redirector defences, preserved from the original ----------
  t.eq(allowedGoogleUrl("javascript:alert(document.cookie)"), null,
    "javascript: is rejected");
  t.eq(allowedGoogleUrl("javascript:void(0)//https://g.page/r/x/review"), null,
    "javascript: dressed up as a g.page link is rejected");
  t.eq(allowedGoogleUrl("data:text/html,<script>alert(1)</script>"), null,
    "data: is rejected");
  t.eq(allowedGoogleUrl("http://search.google.com/local/writereview?placeid=x"), null,
    "plain http is rejected even on an allowed host");
  t.eq(allowedGoogleUrl("https://www.google.com/url?q=https://evil.example"), null,
    "REGRESSION: the /url?q= open redirector is rejected");
  t.eq(allowedGoogleUrl("https://www.google.com//url?q=https://evil.example"), null,
    "REGRESSION: //url survives path normalisation and is still rejected");
  t.eq(allowedGoogleUrl("https://www.google.com/url/?q=https://evil.example"), null,
    "/url/ is rejected");
  t.eq(allowedGoogleUrl("https://www.google.com/amp/s/evil.example"), null,
    "the AMP redirector is rejected");

  // --- host confusion ------------------------------------------------------
  t.eq(allowedGoogleUrl("https://www.google.com.evil.example/maps"), null,
    "a suffix-confusion host is rejected");
  t.eq(allowedGoogleUrl("https://g.page.evil.example/r/x/review"), null,
    "g.page as a prefix of another domain is rejected");
  t.eq(allowedGoogleUrl("https://evil.example/maps/place/x"), null,
    "a non-Google host is rejected");
  t.eq(allowedGoogleUrl("https://goo.gl/aBcDeF"), null,
    "the general goo.gl shortener stays excluded");

  // --- right host, wrong path ----------------------------------------------
  t.eq(allowedGoogleUrl("https://www.google.com/search?q=trey"), null,
    "www.google.com is only allowed on /maps");
  t.eq(allowedGoogleUrl("https://www.google.com/mapsomething"), null,
    "/maps is a path segment, not a prefix match");
  t.eq(allowedGoogleUrl("https://search.google.com/maps/place/x"), null,
    "search.google.com is only allowed on /local/writereview");

  // --- malformed input never throws ----------------------------------------
  for (const bad of ["", null, undefined, "not a url", "//g.page/r/x/review", 12345]) {
    t.eq(allowedGoogleUrl(bad), null, `malformed input rejected without throwing: ${String(bad)}`);
  }

  // === toE164 — one module, one behaviour ==================================
  // Eight copies existed and four had drifted, so a client stored as
  // "+44 (0)7933 189216" got review alerts and never got a weekly report.
  const { toE164 } = require(path.join(FN, "phone.js"));
  t.eq(toE164("+44 (0)7933 189216"), "+447933189216",
    "REGRESSION: the (0) trunk digit is stripped, not turned into +4407933…");
  t.eq(toE164("+44 7933189216"), "+447933189216", "the display space is removed");
  t.eq(toE164("07933189216"), "+447933189216", "a UK national number gets +44");
  t.eq(toE164("+44 07933 189216"), "+447933189216", "a bare trunk 0 after +44 is dropped");
  t.eq(toE164("00447933189216"), "+447933189216", "a 00 international prefix becomes +");
  t.eq(toE164("+353 (0)86 1234567"), "+353861234567", "the same trap in Ireland");
  t.eq(toE164(""), "", "empty in, empty out");
  t.eq(toE164("not a number"), "", "unusable input yields nothing, not a half-formed number");

  // Both endpoints must use that module rather than a private copy.
  for (const [file, source] of [["tap.js", tapJs], ["signup.js", signupJs]]) {
    t.ok(/require\("\.\/phone"\)/.test(source), `${file} requires the shared phone module`);
    t.ok(!/function toE164\s*\(/.test(source), `${file} no longer carries a local toE164 copy`);
  }

  // === signup.js rate limiting =============================================
  t.ok(/blobsStore\(RATE_STORE\)/.test(signupJs) && /RATE_STORE = "signuprate"/.test(signupJs),
    "signup.js keeps its rate counters in the signuprate store");
  t.ok(/IP_BUCKET_CAPACITY = 5\b/.test(signupJs), "5 signups per IP");
  t.ok(/IP_BUCKET_REFILL_MS = 60 \* 60 \* 1000/.test(signupJs), "…per hour");
  t.ok(/GLOBAL_DAILY_CAP = 100\b/.test(signupJs),
    "a global daily cap backstops a distributed attempt against the Resend quota");
  t.ok(/statusCode: 429/.test(signupJs), "a refusal is a 429");
  t.ok(/JSON\.stringify\(\{ error: message \}\)/.test(signupJs),
    "the refusal uses the same { error } JSON shape as every other failure here");
  t.ok(signupJs.indexOf("await consumeRateToken(event)") < signupJs.indexOf("blobsStore(\"clients\")"),
    "the limit is checked before anything with a side effect");

  // Fail OPEN on an unreadable store — a Blobs outage must not take the only
  // funnel into the product down with it — but say so loudly.
  const consumeSrc = signupJs.slice(
    signupJs.indexOf("async function consumeRateToken"),
    signupJs.indexOf("\n}\n", signupJs.indexOf("async function consumeRateToken")));
  t.ok(/RATE STORE UNREADABLE/.test(consumeSrc) && /console\.error/.test(consumeSrc),
    "an unreadable rate store is logged as an error");
  t.ok(/return \{ allowed: true, reason: "" \};/.test(consumeSrc),
    "…and fails OPEN rather than blocking real signups");

  // The IP comes from the header Netlify sets from the TCP peer, which cannot be
  // spoofed; x-forwarded-for is only the fallback, and only its first entry.
  const clientIp = lift(signupJs, "function clientIp", "clientIp");
  t.eq(clientIp({ headers: { "x-nf-client-connection-ip": "203.0.113.7" } }), "203.0.113.7",
    "the Netlify client IP header is preferred");
  t.eq(clientIp({
    headers: { "x-nf-client-connection-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
  }), "203.0.113.7", "a spoofed x-forwarded-for cannot displace it");
  t.eq(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }), "1.2.3.4",
    "the fallback takes the FIRST x-forwarded-for entry");
  t.eq(clientIp({}), "", "no headers yields empty, not a crash");
  t.eq(clientIp(), "", "no event yields empty, not a crash");

  // The welcome email is suppressed for a repeat address; the RECORD is not.
  t.ok(/welcomeEmailAlreadySent/.test(signupJs), "signup.js dedupes the welcome email");
  t.ok(/EMAIL_DEDUPE_MS = 24 \* 60 \* 60 \* 1000/.test(signupJs), "the dedupe window is 24h");
  t.ok(signupJs.indexOf("clientsStore.setJSON(locationId, record)") <
    signupJs.indexOf("welcomeEmailAlreadySent(record.email)"),
    "the record is still written when the email is suppressed");

  // Raw IPs and email addresses are hashed before becoming blob keys.
  t.ok(/createHash\("sha256"\)/.test(signupJs),
    "the limiter hashes its keys rather than storing raw IPs and addresses");

  // === signup.js referral amplification ====================================
  // A shape-valid but unknown ?ref used to trigger a FULL clients listing plus
  // one HMAC per client, on every anonymous POST — the endpoint got more
  // expensive to attack the more customers Trey had.
  const resolveSrc = signupJs.slice(
    signupJs.indexOf("async function resolveReferrer"),
    signupJs.indexOf("\n}\n", signupJs.indexOf("async function resolveReferrer")));
  t.ok(/indexThrew = true/.test(resolveSrc), "resolveReferrer records whether the index read threw");
  t.ok(/if \(!indexThrew\) return "";/.test(resolveSrc),
    "REGRESSION: an absent refcodes entry returns immediately and does NOT scan");
  t.ok(resolveSrc.indexOf("if (!indexThrew) return \"\";") < resolveSrc.indexOf("clientsStore.list()"),
    "the scan is unreachable unless the index read genuinely threw");

  // === tap.js activation signing ===========================================
  t.ok(/const \{ linkKey, linkValid, secretConfigured \} = require\("\.\/link-keys"\)/.test(tapJs),
    "tap.js uses the shared link-keys module");
  t.ok(!/"activate"/.test(src("link-keys.js")),
    "no new purpose was added to link-keys.js");
  t.ok(/linkValid\("inbox", locationId, providedKey\)/.test(tapJs),
    "the activate POST verifies a signed inbox key");
  t.ok(/<input type="hidden" name="k" value="\$\{escapeHtml\(activationKey\)\}">/.test(tapJs),
    "the key is embedded as a hidden input in the activation form");
  t.ok(/activationKey = linkKey\("inbox", locationId\)/.test(tapJs),
    "…minted with the inbox purpose for that location");

  // Order matters twice over: the POST-only gate stays, and the key check runs
  // BEFORE trialStartedAt is stamped.
  t.ok(/event\.httpMethod === "POST" && params\.activate === "1"/.test(tapJs),
    "the POST-only gate is intact (a GET pre-fetch can never activate)");
  const keyCheckAt = tapJs.indexOf("linkValid(\"inbox\", locationId, providedKey)");
  const stampAt = tapJs.indexOf("trialStartedAt: new Date().toISOString()");
  t.ok(keyCheckAt > 0 && stampAt > keyCheckAt,
    "the key is verified before the trial clock is stamped");
  t.ok(/return activationRefusedPage\(\);/.test(tapJs) && /statusCode: 403/.test(tapJs),
    "a bad key gets the refusal page, not an activation");

  // linkKey THROWS on a missing secret by design; the courier's screen must not
  // 500 because of it.
  t.ok(/cannot mint an activation key/.test(tapJs),
    "a missing signing secret is caught and logged rather than 500-ing the page");
};
