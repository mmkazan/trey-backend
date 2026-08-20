// tests/manual-review.test.js — the "log a review by hand" admin endpoint.
//
// House harness: exports run(t), async, picked up by tests/run.js. No network,
// no @netlify/blobs, no live secrets — env values are throwaway and restored.
//
// The webhook contract asserted here (X-Trey-Signature header, the five
// payload keys, numeric rating, manual- id shape) was verified 20 Aug 2026
// against fetch-reviews.mjs and review-webhook.js, not assumed.

const path = require("path");
const mod = require(path.join(__dirname, "..", "netlify", "functions", "manual-review.js"));
const {
  run: handlerRun, validate, makeManualId, buildPayload, tokenOk, header, bearer,
  WEBHOOK_SECRET_HEADER, WEBHOOK_PATH, MANUAL_PREFIX,
} = mod._internals;

function goodEvent(overrides) {
  return Object.assign(
    {
      httpMethod: "POST",
      headers: { authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ locationId: "loc_derby_101", reviewerName: "Sarah M.", rating: 5, comment: "Brilliant" }),
    },
    overrides || {}
  );
}

function stubFetch(status, bodyText) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, text: async () => bodyText || "" };
  };
  fn.calls = calls;
  return fn;
}

async function run(t) {
  // ---- validate ----------------------------------------------------------

  {
    const v = validate({ locationId: " loc_derby_101 ", reviewerName: "  Sarah M.  ", rating: "5", comment: "  Great cut!  " });
    t.ok(v.ok, "manual-review: valid review passes validation");
    t.eq(v.review.locationId, "loc_derby_101", "manual-review: locationId trimmed");
    t.eq(v.review.reviewerName, "Sarah M.", "manual-review: reviewerName trimmed");
    t.eq(v.review.rating, 5, "manual-review: form-sent string rating lands as integer 5");
    t.eq(v.review.comment, "Great cut!", "manual-review: comment trimmed");
  }

  {
    const v = validate({ locationId: "loc1", reviewerName: "Tom", rating: 4 });
    t.ok(v.ok, "manual-review: star-only review (no comment) is valid");
    t.eq(v.review.comment, "", "manual-review: missing comment normalises to empty string");
  }

  t.ok(!validate({ reviewerName: "Tom", rating: 4 }).ok, "manual-review: missing locationId rejected");
  t.ok(!validate({ locationId: "loc1", rating: 4 }).ok, "manual-review: missing reviewerName rejected");

  for (const bad of ["two words", "../etc", "a/b", "loc?x=1", ""]) {
    t.ok(!validate({ locationId: bad, reviewerName: "Tom", rating: 4 }).ok,
      "manual-review: locationId " + JSON.stringify(bad) + " rejected");
  }

  for (const bad of [0, 6, 2.5, "abc", null, undefined, NaN]) {
    t.ok(!validate({ locationId: "loc1", reviewerName: "Tom", rating: bad }).ok,
      "manual-review: rating " + String(bad) + " rejected");
  }

  t.ok(!validate({ locationId: "loc1", reviewerName: "x".repeat(101), rating: 3 }).ok,
    "manual-review: over-long reviewerName rejected");
  t.ok(!validate({ locationId: "loc1", reviewerName: "Tom", rating: 3, comment: "x".repeat(4001) }).ok,
    "manual-review: over-long comment rejected (matches review-webhook's 4000 cap)");

  // ---- makeManualId ------------------------------------------------------

  t.eq(makeManualId(new Date("2026-08-20T09:00:00Z"), "deadbeef"), "manual-20260820-deadbeef",
    "manual-review: id shape is manual-YYYYMMDD-hex");
  {
    const a = makeManualId(), b = makeManualId();
    t.ok(a !== b, "manual-review: two generated ids differ");
    t.ok(/^manual-\d{8}-[0-9a-f]{8}$/.test(a), "manual-review: generated id matches expected shape");
    t.ok(/^[A-Za-z0-9_-]{1,80}$/.test(a), "manual-review: id passes review-webhook's reviewId key guard");
    t.ok(a.startsWith(MANUAL_PREFIX), "manual-review: id carries the greppable manual- prefix");
  }

  // ---- buildPayload ------------------------------------------------------

  {
    const p = buildPayload({ locationId: "loc1", reviewerName: "Tom", rating: 4, comment: "hi" }, "manual-x");
    t.eq(Object.keys(p).sort(), ["comment", "locationId", "rating", "reviewId", "reviewerName"],
      "manual-review: payload carries exactly the five keys review-webhook reads");
    t.eq(p.reviewId, "manual-x", "manual-review: payload uses the minted id");
    t.ok(typeof p.rating === "number", "manual-review: payload rating stays numeric");
  }

  // ---- tokenOk -----------------------------------------------------------

  t.ok(tokenOk("secret-token", "secret-token"), "manual-review: tokenOk accepts an exact match");
  t.ok(!tokenOk("secret-tokeN", "secret-token"), "manual-review: tokenOk rejects a near-miss");
  t.ok(!tokenOk("", "secret-token"), "manual-review: tokenOk rejects empty provided");
  t.ok(!tokenOk("secret-token", ""), "manual-review: tokenOk rejects empty expected");
  t.ok(!tokenOk(null, "secret-token"), "manual-review: tokenOk rejects null");

  // "é" is 1 UTF-16 unit but 2 bytes — a String.length equality check passes it
  // through to a timingSafeEqual throw (the live inbox.js:318 bug). The
  // byte-length compare must just say no, without throwing.
  {
    let threw = false, result = null;
    try { result = tokenOk("é", "e"); } catch (e) { threw = true; }
    t.ok(!threw, "manual-review: multibyte token never throws (the inbox.js:318 trap)");
    t.eq(result, false, "manual-review: multibyte length-mismatch compares false");
  }

  // ---- header / bearer ---------------------------------------------------

  t.eq(header({ Authorization: "Bearer abc" }, "authorization"), "Bearer abc",
    "manual-review: header lookup is case-insensitive");
  t.eq(bearer({ authorization: "Bearer abc" }), "abc", "manual-review: bearer extracts the token");
  t.eq(bearer({ authorization: "bearer  abc " }), "abc", "manual-review: bearer is case/space tolerant");
  t.eq(bearer({}), "", "manual-review: bearer empty when absent");
  t.eq(bearer({ authorization: "Token abc" }), "", "manual-review: bearer ignores non-Bearer schemes");

  // ---- handler -----------------------------------------------------------

  const ENV_KEYS = ["CLIENT_ADMIN_TOKEN", "TREY_WEBHOOK_SECRET", "URL"];
  const envBackup = {};
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  process.env.CLIENT_ADMIN_TOKEN = "test-admin-token";
  process.env.TREY_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.URL = "https://example.test";

  try {
    {
      const res = await handlerRun(goodEvent({ httpMethod: "GET" }), { fetch: stubFetch(200) });
      t.eq(res.statusCode, 405, "manual-review: GET is 405");
    }

    {
      const f = stubFetch(200);
      const res = await handlerRun(goodEvent({ headers: {} }), { fetch: f });
      t.eq(res.statusCode, 403, "manual-review: no token is 403");
      t.eq(f.calls.length, 0, "manual-review: unauthenticated request never reaches the webhook");
    }

    {
      const res = await handlerRun(goodEvent({ headers: { authorization: "Bearer wrong" } }), { fetch: stubFetch(200) });
      t.eq(res.statusCode, 403, "manual-review: wrong token is 403");
    }

    {
      const res = await handlerRun(goodEvent({ body: "{not json" }), { fetch: stubFetch(200) });
      t.eq(res.statusCode, 400, "manual-review: invalid JSON body is 400");
    }

    {
      const f = stubFetch(200);
      const res = await handlerRun(goodEvent({ body: JSON.stringify({ locationId: "loc1", reviewerName: "", rating: 9 }) }), { fetch: f });
      t.eq(res.statusCode, 400, "manual-review: validation failure is 400");
      const body = JSON.parse(res.body);
      t.ok(Array.isArray(body.errors) && body.errors.length >= 2, "manual-review: 400 carries the error list");
      t.eq(f.calls.length, 0, "manual-review: invalid review never reaches the webhook");
    }

    {
      const f = stubFetch(200, '{"success":true}');
      const res = await handlerRun(goodEvent(), { fetch: f });
      t.eq(res.statusCode, 200, "manual-review: happy path returns 200");
      t.eq(f.calls.length, 1, "manual-review: exactly one webhook call");
      const call = f.calls[0];
      t.eq(call.url, "https://example.test" + WEBHOOK_PATH, "manual-review: posts to review-webhook on the site URL");
      t.eq(call.opts.headers[WEBHOOK_SECRET_HEADER], "test-webhook-secret",
        "manual-review: secret travels in " + WEBHOOK_SECRET_HEADER);
      t.eq(WEBHOOK_SECRET_HEADER, "X-Trey-Signature",
        "manual-review: header name matches what review-webhook checks");
      const sent = JSON.parse(call.opts.body);
      t.eq(Object.keys(sent).sort(), ["comment", "locationId", "rating", "reviewId", "reviewerName"],
        "manual-review: forwarded payload has exactly the five keys");
      t.eq(sent.locationId, "loc_derby_101", "manual-review: locationId forwarded intact");
      t.eq(sent.rating, 5, "manual-review: rating forwarded as a number");
      t.ok(sent.reviewId.startsWith("manual-"), "manual-review: forwarded id is manual-prefixed");
      const out = JSON.parse(res.body);
      t.ok(out.ok, "manual-review: response says ok");
      t.eq(out.reviewId, sent.reviewId, "manual-review: response returns the same id it sent");
    }

    {
      const f = stubFetch(500, "x".repeat(2000));
      const res = await handlerRun(goodEvent(), { fetch: f });
      t.eq(res.statusCode, 502, "manual-review: webhook rejection surfaces as 502");
      const out = JSON.parse(res.body);
      t.eq(out.webhookStatus, 500, "manual-review: 502 carries the webhook's status");
      t.ok(out.webhookBody.length <= 500, "manual-review: webhook body is truncated to 500 chars");
      t.ok(out.reviewId.startsWith("manual-"), "manual-review: failed attempt still reports its id");
    }

    {
      const res = await handlerRun(goodEvent(), { fetch: async () => { throw new Error("boom"); } });
      t.eq(res.statusCode, 502, "manual-review: webhook network failure is 502, not a crash");
      t.ok(JSON.parse(res.body).error.includes("boom"), "manual-review: network error message surfaces");
    }

    {
      delete process.env.TREY_WEBHOOK_SECRET;
      const f = stubFetch(200);
      const res = await handlerRun(goodEvent(), { fetch: f });
      t.eq(res.statusCode, 500, "manual-review: missing TREY_WEBHOOK_SECRET is a loud 500");
      t.eq(f.calls.length, 0, "manual-review: unconfigured secret never reaches the webhook");
      process.env.TREY_WEBHOOK_SECRET = "test-webhook-secret";
    }
  } finally {
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  }
}

module.exports = { run };
