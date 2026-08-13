// Inbound WhatsApp webhook (Twilio "A message comes in").
//
// Default behaviour: the Trey number sends automated alerts and isn't monitored,
// so any inbound message gets a short "how to reach us" auto-reply.
//
// PHASE 2 photo branch (DORMANT unless TREY_PHOTO_UPLOAD="true" AND the Google
// API is live): if a client replies to the quarterly photo nudge with photos
// AND they have an open photo-request window (opened by photo-refresh-send.mjs),
// Trey downloads the images from Twilio and uploads them straight to their
// Google Business Profile, then confirms. Until enabled, this branch never runs
// and behaviour is exactly the "how to reach us" reply below.

const { getStore } = require("@netlify/blobs");
const googleApi = require("./google-api.js");

const SUPPORT_REPLY =
  "Thanks for messaging Trey. This number sends your review-approval alerts and isn't monitored for replies. " +
  "For any help, please call or message us on +44 7941 052034, or email mmkazan@gmail.com and we'll get straight back to you.";

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
  // Photo uploads only run when explicitly switched on AND Google creds exist.
  const uploadsOn = process.env.TREY_PHOTO_UPLOAD === "true" && googleApi.isEnabled();
  if (!uploadsOn) return twiml(SUPPORT_REPLY);

  const p = parseBody(event);
  const numMedia = parseInt(p.NumMedia || "0", 10) || 0;
  if (numMedia < 1) return twiml(SUPPORT_REPLY);

  const digits = String(p.From || "").replace(/\D/g, "");
  if (!digits) return twiml(SUPPORT_REPLY);

  // Is there an open "send us your photos" window for this number?
  let req;
  try { req = await blobsStore("photoreq").get(digits, { type: "json" }); } catch (e) { req = null; }
  if (!req || !req.locationId || (req.expiresMs && Date.now() > req.expiresMs)) {
    return twiml(SUPPORT_REPLY);
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
