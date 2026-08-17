// link-keys.js — the one place capability links are signed and verified.
//
// WHY THIS FILE EXISTS (17 Aug 2026)
// ----------------------------------
// Every client-facing page used to derive its key the same way:
//
//     HMAC(TREY_REPORT_SECRET, locationId).slice(0, 32)
//
// The signed message was ONLY the locationId. No purpose, no audience. That
// meant the `k` in a monthly report link was byte-identical to the `k` that
// billing.js accepts — and billing.js cancels a live Stripe subscription on
// POST. A shop owner forwarding their report to their accountant was handing
// over a cancel button, the review inbox, and the ability to change the phone
// number our alerts go to.
//
// approve.js and google-post.js already did this correctly, binding a purpose
// into the message ("approve:" + id, "post:" + id). This file applies the same
// idea to the location-scoped links, and puts it in ONE place so the six
// copies can never drift apart again.
//
// A key is now HMAC over `${purpose}:${locationId}`, so a report key only
// opens the report, an account key only opens account, and so on.
//
// NOTE ON require() ACROSS FUNCTIONS: the old inline copies carried a comment
// saying they were duplicated deliberately "because a require() across them is
// another cold start". That is not how Netlify works — each function is bundled
// independently, so a sibling require is inlined at build time and costs
// nothing at runtime. admin-auth.js is already shared this way by five
// functions. Sharing is strictly better here: it is what stops the drift.

const crypto = require("crypto");

const KEY_LEN = 32;

// The complete set. A typo like linkKey("bilingual", loc) must fail loudly at
// the call site rather than quietly mint a key nothing will ever accept.
const PURPOSES = Object.freeze([
  "report",   // report.js        — the monthly/weekly report page
  "inbox",    // inbox.js         — the review inbox (the hub page)
  "account",  // account.js       — edit contact details
  "billing",  // billing.js       — view/cancel the subscription
  "refer",    // refer.js         — referral link page
  "profile",  // profile-check.js — Google profile audit
]);

function assertPurpose(purpose) {
  if (!PURPOSES.includes(purpose)) {
    throw new Error(
      `link-keys: unknown purpose "${purpose}". Must be one of: ${PURPOSES.join(", ")}`
    );
  }
}

/** Is the signing secret actually configured? */
function secretConfigured() {
  return !!process.env.TREY_REPORT_SECRET;
}

/**
 * Mint a capability key for one purpose and one location.
 *
 * THROWS when TREY_REPORT_SECRET is unset, deliberately. The old code used
 * `process.env.TREY_REPORT_SECRET || ""`, which meant a missing secret still
 * produced a plausible-looking 32-char key — and the schedulers cheerfully
 * WhatsApped every client a real message containing a link that lands on
 * "this link isn't valid or has expired". Refusing to mint a dead link is the
 * only safe behaviour: a send that fails loudly beats a customer receiving a
 * broken link from us.
 *
 * Bulk senders should call secretConfigured() once up front and hard-stop,
 * the way google-post-send.mjs already does.
 */
function linkKey(purpose, locationId) {
  assertPurpose(purpose);
  const secret = process.env.TREY_REPORT_SECRET;
  if (!secret) {
    throw new Error(
      "link-keys: TREY_REPORT_SECRET is not set — refusing to mint a link that cannot be validated."
    );
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}:${String(locationId)}`)
    .digest("hex")
    .slice(0, KEY_LEN);
}

/**
 * Verify a key. Always fails CLOSED — an unset secret, a wrong length, a bad
 * purpose or a malformed input all return false rather than throwing.
 *
 * Buffer.byteLength (not String.length) is compared before timingSafeEqual,
 * because timingSafeEqual throws on a length mismatch and a multibyte string
 * can be 32 characters but 64 bytes. Four functions previously hand-rolled
 * this with String.length and could be made to 500 by an unauthenticated
 * request containing non-ASCII.
 */
function linkValid(purpose, locationId, provided) {
  try {
    if (!PURPOSES.includes(purpose)) return false;
    if (!provided || typeof provided !== "string") return false;
    if (!secretConfigured()) return false;
    if (provided.length !== KEY_LEN) return false;

    const expected = linkKey(purpose, locationId);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/**
 * Build a full URL to one of the client-facing pages, correctly signed.
 * Centralising this stops a caller from minting an "inbox" key and pasting it
 * onto a /billing URL, which is exactly the class of mistake this file exists
 * to prevent.
 *
 * `fn` is the Netlify function name; `purpose` defaults to the matching one.
 */
const FN_TO_PURPOSE = Object.freeze({
  report: "report",
  inbox: "inbox",
  account: "account",
  billing: "billing",
  refer: "refer",
  "profile-check": "profile",
});

function linkUrl(fn, locationId, extraParams) {
  const purpose = FN_TO_PURPOSE[fn];
  if (!purpose) throw new Error(`link-keys: no purpose mapped for function "${fn}"`);
  const base = process.env.URL || "https://trey.today";
  const k = linkKey(purpose, locationId);
  let qs = `loc=${encodeURIComponent(locationId)}&k=${k}`;
  if (extraParams && typeof extraParams === "object") {
    for (const [key, val] of Object.entries(extraParams)) {
      if (val === undefined || val === null || val === "") continue;
      qs += `&${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
    }
  }
  return `${base}/.netlify/functions/${fn}?${qs}`;
}

module.exports = {
  KEY_LEN,
  PURPOSES,
  secretConfigured,
  linkKey,
  linkValid,
  linkUrl,
  FN_TO_PURPOSE,
};
