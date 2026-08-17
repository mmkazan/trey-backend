// PUBLIC self-serve signup endpoint (no admin token). Creates a TRIAL client
// record from the details a business knows about itself. It deliberately does
// NOT accept any admin/Google fields, always generates its own locationId (so a
// submission can never overwrite an existing client), forces status to "trial",
// and flags the record needsReview:true so the admin verifies + adds the Google
// details before it goes live. No side effects (no WhatsApp/Twilio).
//
//   POST /.netlify/functions/signup   { firstName, surname, phone, email,
//        businessName, businessType, companyAddress, brandVoice,
//        voicePerspective, publicSignOffName, googleReviewUrl, hardware,
//        termsAccepted }

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const { linkKey, secretConfigured } = require("./link-keys");
// Store phone numbers in E.164, never the pretty display format. signup.html
// formats as you type ("+44 7933189216") because that reads better in the box —
// but that space is a hard failure at Twilio (21211, "not a valid phone
// number"). It killed Raven Holistics' first review alert on 15 Aug. Format for
// humans on screen; store the machine form.
//
// This was a LOCAL copy until 17 Aug. There were eight copies of toE164() and
// four had drifted — see phone.js. A normaliser that differs between the write
// path (here) and the send path is a silent delivery failure, so there is now
// exactly one.
const { toE164 } = require("./phone");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Replace ASCII control characters with spaces, collapse whitespace, trim, cap.
// (Loop over char codes so no control characters appear in this source file.)
function clean(v, max) {
  const s = String(v == null ? "" : v);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += (c < 32 || c === 127) ? " " : s[i];
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max || 300);
}
function slugify(s) {
  return (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "business");
}

// ---- Abuse limits ----------------------------------------------------------
//
// WHY THIS EXISTS (17 Aug 2026)
// This is a fully public, unauthenticated endpoint and its ONLY defence was the
// honeypot below — which stops a naive form-filler and nothing else. Every
// accepted request does two things an attacker wants:
//
//   1. Sends a Resend email to an ATTACKER-SUPPLIED address, with an
//      attacker-influenced subject ("You're all set, <their first name>"), FROM
//      a domain carrying real DKIM and a strict DMARC alignment. That is a
//      mail-bomb aimed at a third party and a phishing template — both burnt
//      out of TREY'S OWN sending reputation. Losing hello@trey.today to a
//      blocklist takes every welcome email, review alert and report with it.
//   2. Writes a permanent client record flagged needsReview:true, so the admin
//      review queue fills with rubbish and a real signup is lost inside it.
//
// A token bucket per IP plus a global daily ceiling. The bucket is the right
// shape here rather than a fixed window: a genuine person who mistypes and
// resubmits twice is unaffected, while a script gets a hard ceiling.
const RATE_STORE = "signuprate";
const IP_BUCKET_CAPACITY = 5;              // burst, and the hourly allowance
const IP_BUCKET_REFILL_MS = 60 * 60 * 1000; // time to refill the bucket from empty
// The global ceiling is the Resend-quota backstop: 5/IP stops one attacker, it
// does not stop a botnet with a thousand of them. 100/day is roughly an order of
// magnitude above any real day Trey has ever had, so it can only ever bite
// during an attack — and if it ever bites legitimately, that is a very good
// problem and the constant is one deploy away.
const GLOBAL_DAILY_CAP = 100;
// Same address signing up twice in a day gets ONE welcome email. Stops the
// endpoint being used to bomb a single inbox even from rotating IPs.
const EMAIL_DEDUPE_MS = 24 * 60 * 60 * 1000;

// Netlify sets x-nf-client-connection-ip from the actual TCP peer, so it cannot
// be spoofed by a header. x-forwarded-for CAN be, and is only a fallback for
// local/dev invocation — first entry, because the left-most hop is the client.
function clientIp(event) {
  const h = (event && event.headers) || {};
  const direct = h["x-nf-client-connection-ip"] || h["X-NF-Client-Connection-IP"];
  if (direct) return String(direct).trim();
  const xff = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  return String(xff).split(",")[0].trim();
}

// Hash before it becomes a blob key. Two reasons: an IPv6 address and an email
// address are both awkward as key literals, and both are personal data under
// GDPR — an abuse counter has no business being a readable log of who visited.
// The digest is all the limiter ever needs.
function rateKey(prefix, value) {
  return prefix + ":" + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

/**
 * Consume one token for this IP and one from today's global allowance.
 *
 * FAILS OPEN, deliberately, and ONLY when the rate store itself is unreadable.
 * A Netlify Blobs outage must not take the signup form down with it — refusing
 * real businesses to prevent a hypothetical attacker is the wrong trade for a
 * product whose entire funnel is this one form. It shouts into the log when that
 * happens so a silent unlimited window is at least a visible one.
 *
 * The read-modify-write is not atomic and Blobs is eventually consistent, so a
 * burst of simultaneous requests can slip a few over the line. That is fine: the
 * job is to turn "unbounded" into "bounded", not to be exact.
 *
 * @returns {Promise<{allowed:boolean, reason:string}>} reason is "ip" | "global" | ""
 */
async function consumeRateToken(event) {
  const store = blobsStore(RATE_STORE);
  const now = Date.now();
  const ip = clientIp(event);
  const ipKey = rateKey("ip", ip || "unknown");
  const dayKey = "global:" + new Date(now).toISOString().slice(0, 10);

  let bucket, day;
  try {
    bucket = await store.get(ipKey, { type: "json" });
    day = await store.get(dayKey, { type: "json" });
  } catch (e) {
    console.error("[signup] RATE STORE UNREADABLE — failing OPEN, signups are unlimited until this clears:", e && e.message);
    return { allowed: true, reason: "" };
  }

  // Refill continuously rather than on a window boundary, so an attacker can't
  // line up two full buckets either side of the tick.
  const prevTokens = bucket && Number.isFinite(Number(bucket.tokens)) ? Number(bucket.tokens) : IP_BUCKET_CAPACITY;
  const prevAt = bucket && Number(bucket.updatedAt) ? Number(bucket.updatedAt) : now;
  const elapsed = Math.max(0, now - prevAt);
  const refilled = Math.min(IP_BUCKET_CAPACITY, prevTokens + (elapsed / IP_BUCKET_REFILL_MS) * IP_BUCKET_CAPACITY);

  if (refilled < 1) {
    console.warn(`[signup] rate limit hit for ip hash ${ipKey}`);
    return { allowed: false, reason: "ip" };
  }

  const dayCount = day && Number.isFinite(Number(day.count)) ? Number(day.count) : 0;
  if (dayCount >= GLOBAL_DAILY_CAP) {
    console.error(`[signup] GLOBAL daily cap of ${GLOBAL_DAILY_CAP} reached — distributed signup abuse is likely. Check the review queue.`);
    return { allowed: false, reason: "global" };
  }

  // A failed WRITE must not block the signup either — the customer has done
  // nothing wrong, and the worst case is one uncounted request.
  try {
    await store.setJSON(ipKey, { tokens: refilled - 1, updatedAt: now });
    await store.setJSON(dayKey, { count: dayCount + 1, updatedAt: now });
  } catch (e) {
    console.error("[signup] rate counter write failed (allowing the signup):", e && e.message);
  }
  return { allowed: true, reason: "" };
}

/**
 * Has this email address already had a welcome email in the last 24h?
 *
 * The RECORD is still written when this returns true — the admin needs to see a
 * duplicate submission, and swallowing it would hide the abuse. Only the send is
 * skipped, because the send is the part that reaches a stranger's inbox.
 *
 * Fails OPEN (returns false, i.e. "send it") for the same reason as above: a
 * blob outage must not cost a genuine first customer their welcome email.
 */
async function welcomeEmailAlreadySent(email) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr) return false;
  const store = blobsStore(RATE_STORE);
  const key = rateKey("email", addr);
  try {
    const seen = await store.get(key, { type: "json" });
    const at = seen && Number(seen.at);
    if (at && Date.now() - at < EMAIL_DEDUPE_MS) return true;
  } catch (e) {
    console.error("[signup] email dedupe read failed — sending anyway:", e && e.message);
    return false;
  }
  try {
    await store.setJSON(key, { at: Date.now() });
  } catch (e) {
    console.error("[signup] email dedupe write failed:", e && e.message);
  }
  return false;
}

// ---- Referrals ------------------------------------------------------------
// A ?ref=<code> on signup.html means an existing client sent this business. The
// code is HMAC-derived from the referrer's locationId (see refer.js), so it can
// be verified rather than trusted. Resolving it earns the new business a 30-day
// trial instead of 14; the REFERRER's free month is credited later, only once
// this business actually subscribes (see admin.html) — never at signup, or the
// scheme could be farmed with fake sign-ups.
const REFERRED_TRIAL_DAYS = 30;
const CODE_LEN = 8;

// --- Confirmation email (Resend) ---------------------------------------------
// Added 15 Aug. The first real signup went through and the person heard nothing
// at all — no email, no message. Silence is a poor first impression from a
// service asking to look after your reputation, and it makes people wonder
// whether the form even worked.
//
// SENDING DOMAIN — corrected 15 Aug after the first send came back 403
// "Domain not verified: Verify send.trey.today or update your from domain."
//
// The comment that used to sit here was wrong: the domain registered in Resend
// is the ROOT trey.today, not the send.trey.today subdomain, so a FROM of
// @send.trey.today was never going to authenticate.
//
// Sending as @trey.today is safe and does NOT threaten the Microsoft 365 SPF
// that carries info@trey.today. Resend puts its own bounce/return-path on
// send.trey.today (MX + TXT "v=spf1 include:amazonses.com ~all" on the `send`
// label), and SPF is evaluated against the return-path, not the From header.
// The root TXT record is never touched. DKIM signs as d=trey.today via
// resend._domainkey, so DMARC aligns strictly. Nothing about Outlook changes.
//
// DO NOT add Resend's "Enable Receiving" MX record on the root — that one WOULD
// break inbound mail to info@trey.today. It stays switched off.
//
// Env-overridable because getting this wrong cost a real customer their welcome
// email, and the fix should not need a code deploy next time.
const RESEND_FROM = process.env.RESEND_FROM || "Trey <hello@trey.today>";
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || "info@trey.today";
const EMAIL_TIMEOUT_MS = 5000;
const KEY_LEN = 32;

// Signed inbox link — same derivation as inbox.js / approve.js / report.js.
// Trey has no login by design, so this URL *is* the account. It goes in the
// welcome email because the email is the one thing every signup gets: the
// WhatsApp route only exists if they message us first, which not everyone will.
// (Found the hard way — a real signup had no way into their inbox at all.)
function reportKey(locationId) {
  return linkKey("inbox", locationId);
}
function inboxUrl(locationId) {
  const base = process.env.URL || "https://trey.today";
  return `${base}/.netlify/functions/inbox?loc=${encodeURIComponent(locationId)}&k=${reportKey(locationId)}`;
}

/**
 * Send the welcome email. Never throws, never blocks a signup.
 *
 * Three separate protections, because a signup is worth far more than an email:
 *   1. No RESEND_API_KEY -> quiet no-op. (A missing key here is a not-configured
 *      feature, not a security hole, so warn-and-continue is right — unlike the
 *      webhook guards, which fail closed.)
 *   2. Hard 5s timeout. Without it a slow Resend leaves the customer staring at
 *      a spinner having already been saved.
 *   3. Everything wrapped — a bounce, a bad address or an outage is logged and
 *      swallowed. The business is signed up either way.
 */
async function sendWelcomeEmail(record) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[signup] RESEND_API_KEY not set — no confirmation email sent.");
    return false;
  }
  if (!record || !record.email) return false;

  const first = (record.contactFirstName || "").trim();
  const hello = first ? `Hi ${first}` : "Hello";
  const biz = record.businessName || "your business";
  const days = record.trialDays === REFERRED_TRIAL_DAYS ? "30" : "14";
  const wa = "https://wa.me/447476909484?text=" +
    encodeURIComponent(`Hi Trey - it's ${first || "me"} from ${biz}. Just signed up!`);
  const inbox = inboxUrl(record.locationId || record.id || "");
  const hw = record.hardware === "keyfob" ? "key fob" : "tap stand";

  const text =
`${hello},

Thanks for signing up ${biz} to Trey — we've got your details.

What happens next:
1. We give you a quick call to finish setting up your Google review link.
2. Your ${hw} goes in the post. When it arrives, tap it once and press Activate.
3. That's when your ${days}-day free trial starts — not a day is lost while it's in the post.

Your Trey inbox is here — no password, nothing to remember, just a link worth
bookmarking:
${inbox}
It'll be quiet until your ${hw} is live, and that's where every review and reply
will appear.

One thing worth doing now: send us a quick hello on WhatsApp and save the number.
${wa}
Your review alerts come from that number, and it's much easier to trust a name
than an unknown number when the first one lands.

Any questions, just reply to this email.

Matthew
Trey — more Google reviews, without the chasing`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:520px">
<p>${escapeHtml(hello)},</p>
<p>Thanks for signing up <b>${escapeHtml(biz)}</b> to Trey — we've got your details.</p>
<p><b>What happens next:</b></p>
<ol style="padding-left:20px">
  <li>We give you a quick call to finish setting up your Google review link.</li>
  <li>Your <b>${escapeHtml(hw)}</b> goes in the post. When it arrives, tap it once and press Activate.</li>
  <li>That's when your ${days}-day free trial starts — not a day is lost while it's in the post.</li>
</ol>
<p><b>Your Trey inbox</b> — no password, nothing to remember, just a link worth bookmarking:<br>
<a href="${inbox}" style="color:#4338ca">Open your Trey inbox</a><br>
<span style="color:#64748b;font-size:13.5px">It'll be quiet until your ${escapeHtml(hw)} is live — that's where every review and reply will appear.</span></p>
<p>One thing worth doing now: send us a quick hello on WhatsApp and save the number. Your review alerts come from there, and it's much easier to trust a name than an unknown number when the first one lands.</p>
<p><a href="${wa}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:700">Say hello on WhatsApp</a></p>
<p>Any questions, just reply to this email.</p>
<p style="color:#475569">Matthew<br><span style="color:#94a3b8;font-size:13px">Trey — more Google reviews, without the chasing</span></p>
</div>`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMAIL_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [record.email],
        reply_to: RESEND_REPLY_TO,
        subject: `You're all set${first ? ", " + first : ""} — welcome to Trey`,
        text, html,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.error(`[signup] Resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[signup] welcome email failed:", e && e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function refCode(locationId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update("ref:" + String(locationId)).digest("hex").slice(0, CODE_LEN);
}

// code -> referrer locationId. The refcodes index written by refer.js is the
// path; the scan below is now a LAST RESORT and no longer the normal miss path.
//
// WHY THAT CHANGED (17 Aug 2026)
// The old code fell through to the scan on ANY miss — including the ordinary
// "that code isn't real" miss, which is what an attacker sends. One anonymous
// POST with ?ref=deadbeef therefore cost a FULL listing of the clients store
// plus one HMAC per client. With no rate limit above that multiplied every
// attack request by the customer count: the endpoint got more expensive to
// attack the more successful Trey became, which is exactly backwards.
//
// The scan now runs only when the index read genuinely THREW — a real blob
// error, not an absent key. The trade-off, stated plainly: a referral code
// minted before refer.js started writing the index will no longer resolve, and
// that business gets the standard 14-day trial instead of 30. That is a small,
// recoverable disappointment (the admin can fix the record); an amplified DoS
// on the only funnel into the product is not.
async function resolveReferrer(code, clientsStore) {
  const c = String(code || "").trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(c)) return "";           // shape check — cheap reject
  if (!process.env.TREY_REPORT_SECRET) return "";
  let indexThrew = false;
  try {
    const hit = await blobsStore("refcodes").get(c, { type: "json" });
    if (hit && hit.locationId) {
      // Re-derive rather than trust the stored value.
      if (refCode(hit.locationId) === c) return hit.locationId;
    }
  } catch (e) {
    indexThrew = true;
    console.error("[signup] refcodes index read threw:", e && e.message);
  }
  // Absent key = the code is not ours. Answer "no referrer" for the cost of one
  // blob read and stop.
  if (!indexThrew) return "";
  try {
    const { blobs } = await clientsStore.list();
    for (const b of blobs) {
      if (refCode(b.key) === c) return b.key;
    }
  } catch (e) {
    console.error("[signup] referrer scan failed:", e.message);
  }
  return "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Bad request" }) }; }

  // Honeypot — bots fill hidden fields. Pretend success, write nothing.
  if (body.website || body.hp) return { statusCode: 200, body: JSON.stringify({ success: true }) };

  const businessName = clean(body.businessName, 120);
  const phoneRaw = clean(body.phone, 40);
  const phone = toE164(phoneRaw);
  const email = clean(body.email, 120);

  if (!businessName || (!phone && !email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Business name and a contact (phone or email) are required." }) };
  }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please enter a valid email address." }) };
  }

  // Rate limit AFTER the cheap validation above and BEFORE anything with a side
  // effect. Deliberately in that order: a real person who mistypes their email
  // and resubmits must not burn their allowance on a 400 they never saw the
  // point of, and an attacker gains nothing by sending invalid payloads because
  // those write nothing and send nothing anyway.
  const rate = await consumeRateToken(event);
  if (!rate.allowed) {
    const message = rate.reason === "global"
      ? "We're taking more signups than usual right now. Please try again shortly, or email info@trey.today and we'll set you up by hand."
      : "That's a few signups from this connection already. Please try again in a little while, or email info@trey.today and we'll set you up by hand.";
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: message }),
    };
  }

  const clientsStore = blobsStore("clients");

  // Generate a fresh, non-colliding locationId server-side. NEVER trust a
  // client-supplied id — this is what stops a public submission overwriting an
  // existing client.
  let locationId = "";
  for (let i = 0; i < 6; i++) {
    const candidate = `${slugify(businessName)}-${crypto.randomBytes(3).toString("hex")}`;
    let exists = null;
    try { exists = await clientsStore.get(candidate, { type: "json" }); } catch (e) { /* treat as free */ }
    if (!exists) { locationId = candidate; break; }
  }
  if (!locationId) return { statusCode: 503, body: JSON.stringify({ error: "Please try again in a moment." }) };

  const voice = clean(body.voicePerspective, 20) === "Company" ? "Company" : "Individual";

  // Resolve the referral code, if any. A business can't refer itself: the
  // locationId is generated above and can't match an existing client's, but we
  // guard explicitly in case that ever changes.
  const referredBy = await resolveReferrer(clean(body.ref, 20), clientsStore);
  const validReferral = !!referredBy && referredBy !== locationId;

  const record = {
    locationId,
    businessName,
    businessType: clean(body.businessType, 80),
    contactFirstName: clean(body.firstName, 60),
    contactSurname: clean(body.surname, 60),
    phone,
    // The number EXACTLY as it was typed. toE164() assumes a bare 0-number is
    // British and rewrites it to +44 — correct today, silently wrong the first
    // time a business outside the UK signs up, and by then unrecoverable because
    // the original is gone. Keeping the raw string costs nothing and makes any
    // future re-normalisation possible. See country, below.
    phoneRaw,
    email,
    companyAddress: clean(body.companyAddress, 200),
    brandVoice: clean(body.brandVoice, 400),
    voicePerspective: voice,
    publicSignOffName: clean(body.publicSignOffName, 60),
    // Optional — the business's own Google review link, if they have it. The
    // admin resolves the real Place ID / account before going live.
    googleReviewUrl: clean(body.googleReviewUrl, 300),
    // What physically goes in the envelope. An allow-list, not clean(): this
    // string is read by inbox.js to choose a noun and by the admin to decide
    // what to pack, and an unexpected value should quietly become the default
    // rather than print "your Trey <script> is in the post".
    hardware: clean(body.hardware, 20) === "keyfob" ? "keyfob" : "stand",
    // Dispatch tracking, set by the admin — drives the inbox banners. Empty
    // means "we haven't posted it yet", which is what a new signup sees.
    hardwareDispatchedAt: "",
    subscriptionStatus: "trial",
    // The trial clock does NOT start now — it starts on the stand's first tap
    // once the admin sets a go-live (delivery) date. See tap.js.
    trialStartsOnTap: true,
    // 30 days for a referred business, otherwise the standard 14. Read by
    // tap.js / inbox.js / report.js / approve.js via trialDaysFor().
    trialDays: validReferral ? REFERRED_TRIAL_DAYS : 14,
    // Who sent them (a locationId), and whether their free month has been paid
    // out. referralCredited flips to true when the admin applies it in Stripe.
    referredBy: validReferral ? referredBy : "",
    referralCredited: false,
    source: "self-serve",
    // WHO BROUGHT THEM IN. Self-serve signups have no runner, hence "". Set on
    // creation because attribution exists only at this moment — it cannot be
    // reconstructed later, which is exactly where commission arguments start.
    ownerId: "",
    // Stamped so a UK record is positively marked as UK rather than merely
    // assumed to be. Everything else about localisation (currency, timezone,
    // the PECR rules) can be added later without touching existing records —
    // this is the one fact that becomes unknowable once phone is normalised.
    country: "GB",
    needsReview: true,
    termsAccepted: !!body.termsAccepted,
    termsAcceptedAt: body.termsAccepted ? new Date().toISOString() : "",
    createdAt: new Date().toISOString(),
  };

  try {
    await clientsStore.setJSON(locationId, record);
  } catch (e) {
    console.error("[signup] save failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong saving your details. Please try again." }) };
  }

  // Confirmation email. Deliberately AFTER the save, and deliberately incapable
  // of failing the signup — see sendWelcomeEmail().
  //
  // Skipped when this address already had one in the last 24h. The record above
  // is written either way, so the admin still sees the duplicate; it is only the
  // mail to a possibly-unwilling stranger that we decline to send twice.
  if (await welcomeEmailAlreadySent(record.email)) {
    console.warn("[signup] welcome email suppressed — this address already had one in the last 24h.");
  } else {
    await sendWelcomeEmail(record);
  }


  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, businessName }) };
};
