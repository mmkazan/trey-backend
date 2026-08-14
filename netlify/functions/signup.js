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

  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true, businessName }) };
};
