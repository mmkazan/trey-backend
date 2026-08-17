// Twilio request signatures — the C1 fix.
//
// THE BUG: whatsapp-inbound.js validated nothing. Because its reply for a
// recognised number contains that client's signed inbox link, anyone could POST
// From=<the business's own public phone number> and be handed a working
// capability link. A second hole: POST Body=STOP silently suppressed every
// alert for any number.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FN = path.join(__dirname, "..", "netlify", "functions");

// Recompute a signature the way Twilio does, for building valid test requests.
function sign(token, url, params) {
  const suffix = Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(Buffer.from(url + suffix, "utf8")).digest("base64");
}

exports.run = function (t) {
  // --- 1. The algorithm matches Twilio's own published test vector ----------
  // If this ever fails, every signature check in the repo is wrong.
  const vectorSig = sign("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675309",
    Digits: "1234",
    From: "+14158675309",
    To: "+18005551212",
  });
  t.eq(vectorSig, "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
    "signature algorithm matches Twilio's published test vector");

  // --- 2. Both webhook handlers actually verify ----------------------------
  for (const file of ["whatsapp-inbound.js", "twilio-status.js"]) {
    const src = fs.readFileSync(path.join(FN, file), "utf8");
    t.ok(/x-twilio-signature/i.test(src), `${file} reads the X-Twilio-Signature header`);
    t.ok(/createHmac\(\s*["']sha1["']/.test(src), `${file} uses HMAC-SHA1`);
    t.ok(/timingSafeEqual/.test(src), `${file} compares constant-time`);
    t.ok(/TWILIO_AUTH_TOKEN/.test(src), `${file} keys on TWILIO_AUTH_TOKEN`);
    t.ok(/403/.test(src), `${file} returns 403 on a bad signature (so Twilio stops retrying)`);
    // Fail closed: no auth token must mean refuse, not "carry on unverified".
    t.ok(/if\s*\(!token\)\s*return/.test(src) || /!token\)\s*return\s*\{?\s*ok:\s*false/.test(src),
      `${file} fails closed when TWILIO_AUTH_TOKEN is unset`);
  }

  // --- 3. The signature gate runs BEFORE any work -------------------------
  const wi = fs.readFileSync(path.join(FN, "whatsapp-inbound.js"), "utf8");
  const handlerAt = wi.indexOf("exports.handler");
  const sigCheckAt = wi.indexOf("twilioSignatureValid(event)", handlerAt);
  const stopAt = wi.indexOf("normaliseCmd", handlerAt);
  const findClientAt = wi.indexOf("findClientByPhone", handlerAt);
  t.ok(sigCheckAt > handlerAt && sigCheckAt < stopAt,
    "signature is checked before STOP/START handling");
  t.ok(sigCheckAt > handlerAt && sigCheckAt < findClientAt,
    "signature is checked before any client lookup (no unauthenticated O(n) blob reads)");

  // --- 4. Signatures are bound to the exact request -----------------------
  const TOKEN = "test-auth-token";
  const URL_ = "https://trey.today/.netlify/functions/whatsapp-inbound";
  const good = { From: "whatsapp:+447700900123", Body: "hello" };
  const goodSig = sign(TOKEN, URL_, good);

  t.eq(sign(TOKEN, URL_, good), goodSig, "same request reproduces the same signature");
  t.ok(sign(TOKEN, URL_, { ...good, Body: "STOP" }) !== goodSig,
    "changing the body invalidates the signature (a forged STOP is rejected)");
  t.ok(sign(TOKEN, URL_, { ...good, From: "whatsapp:+447700900999" }) !== goodSig,
    "changing From invalidates the signature (cannot impersonate another business)");
  t.ok(sign("wrong-token", URL_, good) !== goodSig,
    "the auth token is required — without it no valid signature can be produced");
  t.ok(sign(TOKEN, URL_ + "x", good) !== goodSig,
    "the URL is part of the signed message");

  // Parameter ORDER must not matter — Twilio sorts by key.
  const reordered = {};
  Object.keys(good).reverse().forEach((k) => { reordered[k] = good[k]; });
  t.eq(sign(TOKEN, URL_, reordered), goodSig, "parameter order does not change the signature");

  // --- 5. The media SSRF host pin ------------------------------------------
  // The Twilio account SID and auth token are attached to that fetch, so an
  // attacker-supplied MediaUrl would post our credentials to their server.
  t.ok(/TWILIO_MEDIA_HOSTS/.test(wi), "a media host allow-list exists");
  t.ok(/api\.twilio\.com/.test(wi), "…and includes api.twilio.com");
  const pinAt = wi.indexOf("twilioMediaHost(url)");
  const fetchAt = wi.indexOf("fetch(url, { headers: { Authorization: authHeader } })");
  t.ok(pinAt > 0 && fetchAt > 0 && pinAt < fetchAt,
    "the host is checked BEFORE credentials are attached to the fetch");
};
