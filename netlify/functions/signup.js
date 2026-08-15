// PUBLIC self-serve signup endpoint (no admin token). Creates a TRIAL client
// record from the details a business knows about itself. It deliberately does
// NOT accept any admin/Google fields, always generates its own locationId (so a
// submission can never overwrite an existing client), forces status to "trial",
// and flags the record needsReview:true so the admin verifies + adds the Google
// details before it goes live. No side effects (no WhatsApp/Twilio).
//
//   POST /.netlify/functions/signup   { firstName, surname, phone, email,
//        businessName, businessType, companyAddress, brandVoice,
//        voicePerspective, publicSignOffName, googleReviewUrl, termsAccepted }

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

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
// SENDING DOMAIN: Resend is verified on the send.trey.today SUBDOMAIN, not the
// root. That was the right call — it keeps Resend's SPF away from the root
// record, so the Microsoft 365 SPF that carries info@trey.today can't be broken
// by anything done here. The consequence is that FROM must be @send.trey.today;
// sending as info@trey.today would fail authentication. Reply-To puts replies
// back in the real Outlook mailbox, so the customer never has to care.
const RESEND_FROM = "Trey <hello@send.trey.today>";
const RESEND_REPLY_TO = "info@trey.today";
const EMAIL_TIMEOUT_MS = 5000;
const KEY_LEN = 32;

// Signed inbox link — same derivation as inbox.js / approve.js / report.js.
// Trey has no login by design, so this URL *is* the account. It goes in the
// welcome email because the email is the one thing every signup gets: the
// WhatsApp route only exists if they message us first, which not everyone will.
// (Found the hard way — a real signup had no way into their inbox at all.)
function reportKey(locationId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update(String(locationId)).digest("hex").slice(0, KEY_LEN);
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

  const text =
`${hello},

Thanks for signing up ${biz} to Trey — we've got your details.

What happens next:
1. We set up your Google review link and send out your tap stand or key fob.
2. When it arrives, you tap it once and press Activate.
3. That's when your ${days}-day free trial starts — not a day is lost while it's in the post.

Your Trey inbox is here — no password, nothing to remember, just a link worth
bookmarking:
${inbox}
It'll be quiet until your stand is live, and that's where every review and reply
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
  <li>We set up your Google review link and send out your tap stand or key fob.</li>
  <li>When it arrives, you tap it once and press Activate.</li>
  <li>That's when your ${days}-day free trial starts — not a day is lost while it's in the post.</li>
</ol>
<p><b>Your Trey inbox</b> — no password, nothing to remember, just a link worth bookmarking:<br>
<a href="${inbox}" style="color:#4338ca">Open your Trey inbox</a><br>
<span style="color:#64748b;font-size:13.5px">It'll be quiet until your stand is live — that's where every review and reply will appear.</span></p>
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

// code -> referrer locationId. Fast path is the refcodes index written by
// refer.js; the fallback scan covers a code shared before the index existed.
async function resolveReferrer(code, clientsStore) {
  const c = String(code || "").trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(c)) return "";           // shape check — cheap reject
  if (!process.env.TREY_REPORT_SECRET) return "";
  try {
    const hit = await blobsStore("refcodes").get(c, { type: "json" });
    if (hit && hit.locationId) {
      // Re-derive rather than trust the stored value.
      if (refCode(hit.locationId) === c) return hit.locationId;
    }
  } catch (e) { /* fall through to scan */ }
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
  const phone = clean(body.phone, 40);
  const email = clean(body.email, 120);

  if (!businessName || (!phone && !email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Business name and a contact (phone or email) are required." }) };
  }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please enter a valid email address." }) };
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
    email,
    companyAddress: clean(body.companyAddress, 200),
    brandVoice: clean(body.brandVoice, 400),
    voicePerspective: voice,
    publicSignOffName: clean(body.publicSignOffName, 60),
    // Optional — the business's own Google review link, if they have it. The
    // admin resolves the real Place ID / account before going live.
    googleReviewUrl: clean(body.googleReviewUrl, 300),
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
  await sendWelcomeEmail(record);


  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, businessName }) };
};
