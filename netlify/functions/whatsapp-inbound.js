// Inbound WhatsApp webhook (Twilio "A message comes in").
//
// Default behaviour: the Trey number sends automated alerts and isn't monitored,
// so any inbound message gets a short "how to reach us" auto-reply.
//
// STOP / START are handled FIRST, before anything else, and always — every
// automated message we send is a marketing message to a business, and under UK
// PECR soft opt-in only holds if opting out is trivial and honoured. STOP sets
// nudgesOptOut + reportsOptOut on the matching client (both already checked by
// the schedulers), and is recorded with a timestamp so we can show when and how
// they opted out.
//
// PHASE 2 photo branch (DORMANT unless TREY_PHOTO_UPLOAD="true" AND the Google
// API is live): if a client replies to the quarterly photo nudge with photos
// AND they have an open photo-request window (opened by photo-refresh-send.mjs),
// Trey downloads the images from Twilio and uploads them straight to their
// Google Business Profile, then confirms. Until enabled, this branch never runs
// and behaviour is exactly the "how to reach us" reply below.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");
const googleApi = require("./google-api.js");

const SUPPORT_REPLY =
  "Thanks for messaging Trey. This number sends your review-approval alerts and isn't monitored for replies. " +
  "For any help, please call or message us on +44 7941 052034, or email info@trey.today and we'll get straight back to you.";

// --- Signed inbox link -------------------------------------------------------
// Same key derivation as inbox.js / approve.js — HMAC of the locationId, first
// 32 hex chars. Kept in sync deliberately rather than shared, because these are
// separate Netlify functions and a require() across them is another cold start.
const KEY_LEN = 32;
function reportKey(locationId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update(String(locationId)).digest("hex").slice(0, KEY_LEN);
}
function inboxUrl(locationId) {
  const base = process.env.URL || "https://trey.today";
  return `${base}/.netlify/functions/inbox?loc=${encodeURIComponent(locationId)}&k=${reportKey(locationId)}`;
}

/**
 * Reply for a message we can attribute to a real client.
 *
 * WHY THIS EXISTS — feedback from the first real signup (15 Aug). Someone fills in
 * the form, hands over their business details, and hears nothing at all. The
 * success screen invites them to message this number, and this is what answers.
 *
 * It does three jobs at once:
 *   1. Confirms a human/system is actually there.
 *   2. Hands them their inbox link, which is the whole product and needs no login.
 *   3. Their reply opens WhatsApp's 24-hour session window, so anything we send
 *      next can be free-form rather than a Meta-approved template.
 *
 * The first reply is warmer and asks them to SAVE THE NUMBER. That matters more
 * than it sounds: without it, their first review-approval alert arrives from an
 * unknown number asking them to tap a link, which reads exactly like a scam.
 */
async function clientReply(match) {
  const client = match.client || {};
  const name = (client.contactFirstName || "").trim();
  const hello = name ? `Hi ${name}` : "Hi";
  const url = inboxUrl(match.key);
  const firstTime = !client.whatsappWelcomedAt;

  if (firstTime) {
    try {
      await match.store.setJSON(match.key, { ...client, whatsappWelcomedAt: new Date().toISOString() });
    } catch (e) {
      // Non-fatal: worst case they get the warm welcome twice.
      console.error("[whatsapp-inbound] welcome stamp failed:", e.message);
    }
    return `${hello}, and welcome to Trey \u{1F44B}\n\n` +
      "Please save this number — your review alerts come from here, and it's easier to trust a name than a number.\n\n" +
      `Here's your Trey inbox, no password needed:\n${url}\n\n` +
      "When a review comes in, I'll message you a ready-to-send reply. You read it, tap approve, done. " +
      "Reply STOP any time to switch messages off.";
  }

  return `${hello} — here's your Trey inbox:\n${url}\n\n` +
    "Anything else, email info@trey.today and a human will pick it up.";
}

/**
 * What to say when we're not doing anything else with the message. A known
 * client gets their inbox; a stranger gets the support line. Previously EVERY
 * inbound message got the generic support reply, including from paying clients.
 */
async function fallbackReply(fromDigits) {
  try {
    const match = await findClientByPhone(fromDigits);
    if (match) return await clientReply(match);
  } catch (e) {
    console.error("[whatsapp-inbound] fallback lookup failed:", e.message);
  }
  return SUPPORT_REPLY;
}

// Anything a person might plausibly send to make us stop. Kept deliberately
// broad — a missed opt-out is a complaint; a false positive is one auto-reply.
const STOP_WORDS  = ["stop", "stopall", "stop all", "unsubscribe", "cancel", "quit", "end", "optout", "opt out", "no more", "remove me"];
const START_WORDS = ["start", "unstop", "resubscribe", "resume", "opt in", "optin", "yes please"];

const STOP_REPLY =
  "Done — you won't get any more messages from Trey. If you change your mind, just reply START. " +
  "For anything else, email info@trey.today.";
const START_REPLY =
  "Welcome back — messages are switched back on. Reply STOP at any time to turn them off again.";

// Normalise an inbound message for matching: lowercase, strip punctuation and
// surrounding whitespace, collapse inner spaces.
function normaliseCmd(body) {
  return String(body || "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

// How good a match is this client, when a number matches MORE THAN ONE?
// Higher wins; ties break on newest.
//
// WHY THIS EXISTS — 15 Aug. One phone number, two client records: an old
// deactivated Aqua Rhythm and a new one from the self-serve signup. The lookup
// below returned whichever the blob store happened to list first, and that was
// the dead one. So the WhatsApp reply handed over the OLD account's inbox link,
// every page it opened said "your stand is paused" and locked the profile work,
// while the new stand was quietly working perfectly. Hours lost to a
// first-match-wins loop.
//
// Worse than the wrong link: a STOP reply would have written the opt-out flags
// onto the dead record and left the live one still messaging them.
function matchRank(c) {
  if (String((c && c.plan) || "").toLowerCase() === "free") return 5;   // comped, always live
  const s = String((c && c.subscriptionStatus) || "").toLowerCase();
  if (s === "active") return 4;
  // "" is "grandfathered", treated as active everywhere else — but a STALE
  // duplicate very often has no status at all, and ranking it level with a real
  // subscriber let a dead record beat a live trial and win the lookup again.
  // Sitting it level with trial means the createdAt tiebreak decides, and the
  // newer record — the one the customer actually signed up for — wins.
  if (s === "" || s === "trial") return 3;
  if (s === "paused" || s === "past_due") return 2;
  return 1;                                                             // cancelled / expired
}

// Find the client whose stored phone matches this WhatsApp number. Compares the
// last 9 digits so +447700900123 / 07700900123 / 447700900123 all match.
async function findClientByPhone(digits) {
  if (!digits) return null;
  const tail = digits.slice(-9);
  if (tail.length < 9) return null;
  try {
    const store = blobsStore("clients");
    const { blobs } = await store.list();
    const matches = [];
    for (const b of blobs) {
      const c = await store.get(b.key, { type: "json" }).catch(() => null);
      if (!c || !c.phone) continue;
      const cd = String(c.phone).replace(/\D/g, "");
      if (cd.length >= 9 && cd.slice(-9) === tail) matches.push({ key: b.key, client: c, store });
    }
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];

    matches.sort((a, b) => {
      const r = matchRank(b.client) - matchRank(a.client);
      if (r !== 0) return r;
      return new Date(b.client.createdAt || 0) - new Date(a.client.createdAt || 0);
    });
    // Loud on purpose: duplicates are a data problem to clean up, not something
    // to keep silently working around.
    console.warn(
      `[whatsapp-inbound] ${matches.length} clients share the number ending ${tail} — using "${matches[0].key}" ` +
      `(${matches[0].client.subscriptionStatus || "no status"}). Others: ` +
      matches.slice(1).map((m) => `${m.key} (${m.client.subscriptionStatus || "no status"})`).join(", ") +
      ". Clean these up in admin."
    );
    return matches[0];
  } catch (e) {
    console.error("[whatsapp-inbound] client lookup failed:", e.message);
  }
  return null;
}

async function setOptOut(match, optedOut) {
  if (!match) return false;
  try {
    await match.store.setJSON(match.key, {
      ...match.client,
      nudgesOptOut: optedOut,
      reportsOptOut: optedOut,
      optedOutAt: optedOut ? new Date().toISOString() : "",
      optOutSource: optedOut ? "whatsapp-stop" : "",
    });
    return true;
  } catch (e) {
    console.error("[whatsapp-inbound] opt-out write failed:", e.message);
    return false;
  }
}

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}
function twiml(message) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' +
      String(message).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      "</Message></Response>",
  };
}

// Parse the Twilio form-encoded webhook body into a flat map.
function parseBody(event) {
  const out = {};
  try { for (const [k, v] of new URLSearchParams(event && event.body || "").entries()) out[k] = v; } catch (e) {}
  return out;
}

exports.handler = async (event) => {
  const p = parseBody(event);
  const fromDigits = String(p.From || "").replace(/\D/g, "");

  // --- STOP / START — always, and BEFORE anything else -----------------------
  // This must not sit behind the uploadsOn check below, or an opt-out would be
  // silently ignored whenever photo uploads are switched off (i.e. right now).
  const cmd = normaliseCmd(p.Body);
  if (cmd) {
    if (STOP_WORDS.includes(cmd)) {
      const match = await findClientByPhone(fromDigits);
      await setOptOut(match, true);
      // ALWAYS record the suppression, client or not.
      //
      // This used to log "STOP from an unknown number — nothing to flag" and
      // record nothing at all. But the numbers most likely to reply STOP are
      // exactly the ones that AREN'T clients yet: cold outreach prospects from
      // the leads database. Under PECR an opt-out must be honoured, and failing
      // to honour one is the classic enforcement trigger — the ceiling rose to
      // £17.5m / 4% of turnover in February 2026. "We had no record of it" is
      // not a defence; it is the admission.
      //
      // Keyed by the last 9 digits so it matches however the number is written,
      // and it is checked before any outreach.
      try {
        const tail = String(fromDigits || "").slice(-9);
        if (tail.length === 9) {
          await blobsStore("suppressed").setJSON(tail, {
            at: new Date().toISOString(),
            source: "whatsapp-stop",
            matchedClient: match ? match.key : "",
          });
        }
      } catch (e) {
        console.error("[whatsapp-inbound] SUPPRESSION WRITE FAILED — this number may keep being contacted:", e.message);
      }
      if (!match) console.warn(`[whatsapp-inbound] STOP from a non-client (likely an outreach lead) — added to the suppression list.`);
      return twiml(STOP_REPLY);
    }
    if (START_WORDS.includes(cmd)) {
      const match = await findClientByPhone(fromDigits);
      await setOptOut(match, false);
      // Lift the suppression too — otherwise opting back in is impossible.
      try {
        const tail = String(fromDigits || "").slice(-9);
        if (tail.length === 9) await blobsStore("suppressed").delete(tail);
      } catch (e) { /* absent is fine */ }
      return twiml(START_REPLY);
    }
  }

  // Photo uploads only run when explicitly switched on AND Google creds exist.
  const uploadsOn = process.env.TREY_PHOTO_UPLOAD === "true" && googleApi.isEnabled();
  if (!uploadsOn) return twiml(await fallbackReply(fromDigits));

  const numMedia = parseInt(p.NumMedia || "0", 10) || 0;
  if (numMedia < 1) return twiml(await fallbackReply(fromDigits));

  const digits = fromDigits;
  if (!digits) return twiml(SUPPORT_REPLY);   // no number at all -> nobody to look up

  // Is there an open "send us your photos" window for this number?
  let req;
  try { req = await blobsStore("photoreq").get(digits, { type: "json" }); } catch (e) { req = null; }
  if (!req || !req.locationId || (req.expiresMs && Date.now() > req.expiresMs)) {
    return twiml(await fallbackReply(fromDigits));
  }

  const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN;
  const authHeader = "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64");
  const loc = { accountId: req.accountId, locationId: req.locationId };

  let ok = 0, failed = 0;
  const max = Math.min(numMedia, 6); // safety cap per message
  for (let i = 0; i < max; i++) {
    const url = p[`MediaUrl${i}`];
    const ctype = p[`MediaContentType${i}`] || "image/jpeg";
    if (!url || !/^image\//i.test(ctype)) { continue; }
    try {
      const media = await fetch(url, { headers: { Authorization: authHeader } });
      if (!media.ok) throw new Error("media fetch " + media.status);
      const bytes = Buffer.from(await media.arrayBuffer());
      await googleApi.uploadLocationPhoto(loc, bytes, ctype);
      ok++;
    } catch (err) {
      failed++;
      console.error("[whatsapp-inbound] photo upload failed:", err.message);
    }
  }

  if (ok > 0 && failed === 0) return twiml(`✅ Added ${ok} ${ok === 1 ? "photo" : "photos"} to your Google profile — nice one, that keeps you looking active. Send more any time this month.`);
  if (ok > 0 && failed > 0) return twiml(`Added ${ok} of your photos to Google — a couple didn't go through, please resend those. `);
  return twiml("Sorry, those photos didn't upload just now. Please try sending them again, or add them in the Google app.");
};
