// netlify/functions/manual-review.js
//
// Log a review by hand (admin only). Until the Google Business Profile API is
// approved, this is the only way to get a real review into a client's inbox —
// and it doubles as the sales demo: it feeds the review through the SAME
// pipeline a Google review takes (review-webhook → Gemini draft → WhatsApp →
// approve page), so what a prospect sees is the real product, not a mock.
//
// The review id is always prefixed "manual-" so every hand-logged review can
// be found (and deleted) by prefix before Google syncing goes live —
// fetch-reviews dedupes on Google's own review ids, so a manual copy of a
// real review would otherwise appear twice once syncing starts.
//
// Auth: same as the other admin endpoints — `Authorization: Bearer
// <CLIENT_ADMIN_TOKEN>`. The compare is byte-length-safe (Buffer.byteLength
// before timingSafeEqual), deliberately avoiding the multibyte-input 500 that
// inbox.js:318 / report.js:696 still carry.
//
// Contract with review-webhook — VERIFIED 20 Aug 2026 against the source of
// both sides (fetch-reviews.mjs's POST and review-webhook.js's checks):
//   - secret travels in the `X-Trey-Signature` header (constant-time checked)
//   - payload is {locationId, reviewId, reviewerName, rating, comment},
//     rating numeric 1-5
//   - reviewId must match /^[A-Za-z0-9_-]{1,80}$/ (it becomes a blob key) —
//     manual-YYYYMMDD-xxxxxxxx fits
//   - comment capped at 4000 chars; the client record must exist (404 if not)
// If fetch-reviews' call ever changes shape, change this file to match it —
// fetch-reviews is the production caller and wins.
// ───────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const WEBHOOK_SECRET_HEADER = "X-Trey-Signature"; // same header fetch-reviews.mjs sends
const WEBHOOK_PATH = "/.netlify/functions/review-webhook";
const MANUAL_PREFIX = "manual-";

// Byte-length-safe constant-time token compare. String.length counts UTF-16
// units but timingSafeEqual compares byte buffers, so comparing lengths on the
// strings lets a multibyte token through to a throw. Compare byte lengths.
function tokenOk(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Netlify lowercases event headers, but read case-insensitively anyway —
// a header lookup should never depend on the platform's normalisation.
function header(headers, name) {
  if (!headers) return "";
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k] || "";
  }
  return "";
}

function bearer(headers) {
  const m = /^Bearer\s+(.+)$/i.exec(header(headers, "authorization") || "");
  return m ? m[1].trim() : "";
}

// manual-YYYYMMDD-xxxxxxxx — sortable, greppable, collision-safe enough for
// hand-entered volume. `now`/`rand` are injectable for tests only.
function makeManualId(now, rand) {
  const d = now || new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const hex = rand || crypto.randomBytes(4).toString("hex");
  return MANUAL_PREFIX + ymd + "-" + hex;
}

function validate(body) {
  const errors = [];
  const review = {};
  const b = body && typeof body === "object" ? body : {};

  const loc = typeof b.locationId === "string" ? b.locationId.trim() : "";
  if (!loc) errors.push("locationId is required");
  else if (loc.length > 100 || !/^[\w.-]+$/.test(loc)) errors.push("locationId looks wrong (letters, numbers, _ . - only)");
  else review.locationId = loc;

  const name = typeof b.reviewerName === "string" ? b.reviewerName.trim() : "";
  if (!name) errors.push("reviewerName is required");
  else if (name.length > 100) errors.push("reviewerName too long (max 100)");
  else review.reviewerName = name;

  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.push("rating must be a whole number from 1 to 5");
  else review.rating = rating;

  // Star-only reviews have no comment — that's valid, and downstream wa.js
  // already sanitises empty template variables for Twilio.
  let comment = b.comment == null ? "" : String(b.comment).trim();
  if (comment.length > 4000) errors.push("comment too long (max 4000)");
  else review.comment = comment;

  return { ok: errors.length === 0, errors, review };
}

function buildPayload(review, reviewId) {
  return {
    locationId: review.locationId,
    reviewId,
    reviewerName: review.reviewerName,
    rating: review.rating,
    comment: review.comment,
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// `deps.fetch` is injectable for tests; production uses global fetch (Node 24).
async function run(event, deps) {
  const fetchFn = (deps && deps.fetch) || fetch;

  if ((event.httpMethod || "").toUpperCase() !== "POST") {
    return json(405, { ok: false, error: "POST only" });
  }

  const adminToken = process.env.CLIENT_ADMIN_TOKEN || "";
  if (!adminToken || !tokenOk(bearer(event.headers), adminToken)) {
    // 403, not 401 — the admin page treats a 403 as "token invalid, sign out".
    return json(403, { ok: false, error: "Forbidden" });
  }

  const secret = process.env.TREY_WEBHOOK_SECRET || "";
  if (!secret) {
    // Fail loudly, never silently — a missing env var must not look like a
    // working request that quietly did nothing.
    return json(500, { ok: false, error: "TREY_WEBHOOK_SECRET is not set on this deploy" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { ok: false, error: "Body must be JSON" });
  }

  const v = validate(body);
  if (!v.ok) return json(400, { ok: false, errors: v.errors });

  const reviewId = makeManualId();
  const base = process.env.URL || "https://treyv1.netlify.app"; // same fallback as fetch-reviews/review-webhook

  let res;
  try {
    res = await fetchFn(base + WEBHOOK_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SECRET_HEADER]: secret,
      },
      body: JSON.stringify(buildPayload(v.review, reviewId)),
    });
  } catch (err) {
    return json(502, { ok: false, reviewId, error: "review-webhook unreachable: " + (err && err.message) });
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return json(502, {
      ok: false,
      reviewId,
      webhookStatus: res.status,
      // Enough of the body to diagnose, never so much it floods the admin UI.
      webhookBody: String(text).slice(0, 500),
      error: "review-webhook rejected the review",
    });
  }

  return json(200, {
    ok: true,
    reviewId,
    note:
      "Logged. The AI draft and WhatsApp alert are being sent through the normal pipeline. " +
      "Delete id " + reviewId + " from the reviews store before Google syncing goes live.",
  });
}

exports.handler = (event) => run(event, {});

// Exposed for tests only — not an API surface.
exports._internals = {
  run,
  validate,
  makeManualId,
  buildPayload,
  tokenOk,
  header,
  bearer,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_PATH,
  MANUAL_PREFIX,
};
