// phone.js — the one E.164 normaliser.
//
// WHY THIS FILE EXISTS (17 Aug 2026)
// ----------------------------------
// There were EIGHT copies of toE164(), and they had drifted. Four carried the
// "(0)" fix; four did not — and it was the four in the scheduled senders:
//
//   tap.js                    ✅ fixed
//   signup.js                 ✅ fixed
//   review-webhook.js         ✅ fixed
//   account.js                ✅ fixed
//   weekly-report-send.mjs    ❌
//   monthly-report-send.mjs   ❌
//   google-post-send.mjs      ❌
//   photo-refresh-send.mjs    ❌
//
// The practical effect: a client stored as "+44 (0)7933 189216" — which is how
// a large share of UK businesses write their number, and which client.js stores
// verbatim from the admin form — received review alerts (fixed copy) and never
// received a weekly report, a monthly report, a Google Post nudge or a photo
// prompt. All four died on Twilio error 21211, were counted in summary.failed,
// and were logged once.
//
// The comment explaining the trap was sitting in the four fixed copies and
// absent from the four broken ones. One module, one behaviour, one place to fix.

/**
 * Normalise a phone number to E.164 (+<country><subscriber>), UK-default.
 * Returns "" for anything unusable rather than a half-formed number, because a
 * malformed To: is a silent delivery failure rather than a loud error.
 */
function toE164(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";

  // "(0)" is the international convention for an OPTIONAL trunk digit — it is
  // never part of an E.164 number. "+44 (0)7933 189216" naively stripped of
  // non-digits yields "+4407933189216", which Twilio rejects with 21211 and the
  // owner never finds out, because their messages simply stop arriving. Same
  // trap for "+353 (0)86…". Remove it before anything else.
  const cleaned = raw.replace(/\(\s*0\s*\)/g, "");
  const d = cleaned.replace(/[^\d]/g, "");
  if (!d) return "";

  // A trunk 0 written straight after the country code ("+44 07933…") is the
  // same mistake without the brackets. No UK subscriber number begins with 0,
  // so "440…" is always a trunk zero, never a real number.
  if (cleaned.startsWith("+")) return d.startsWith("440") ? "+44" + d.slice(3) : "+" + d;
  if (d.startsWith("00")) {
    const rest = d.slice(2);
    return rest.startsWith("440") ? "+44" + rest.slice(3) : "+" + rest;
  }
  if (d.startsWith("0")) return "+44" + d.slice(1);   // UK national
  if (d.startsWith("440")) return "+44" + d.slice(3);
  if (d.startsWith("44")) return "+" + d;
  return "+" + d;
}

/**
 * The last 9 digits, which is the key shape used by the `suppressed` store.
 * Kept here so the STOP list and the doorstep-withdrawal path can never key
 * their records differently — they are the same list and must agree.
 */
function phoneTail(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : "";
}

module.exports = { toE164, phoneTail };
