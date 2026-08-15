// Netlify Scheduled Function — QUARTERLY "refresh your photos" nudge. On the 8th
// of Jan/Apr/Jul/Oct it WhatsApps every active client a tailored shot-list for
// their trade. Active profiles with fresh photos rank better, and almost no
// small business does this.
//
// Schedule: "0 9 8 1,4,7,10 *"  = 09:00 UTC on the 8th of Jan, Apr, Jul, Oct.
//
// FAIL-SAFE: sends nothing unless TWILIO_PHOTO_CONTENT_SID is set.
//
// PHASE 1 (now): the nudge is a reminder + shot-list; the owner adds the photos
// themselves in the Google app.
// PHASE 2 (once TREY_PHOTO_UPLOAD="true" AND the Google API is live): this also
// opens a "photo request" window per client, so when they reply to the WhatsApp
// with photos, whatsapp-inbound.js uploads them to Google automatically. Use the
// "reply with your photos" template copy in that phase.
//
// WhatsApp template `trey_photo_refresh`. Variables:
//   {{1}} business name
//   {{2}} tailored shot-list (one line, e.g. "a tidy bay • a happy handover • …")

import { getStore } from "@netlify/blobs";

// Normalise a stored phone number to E.164 for Twilio.
//
// WHY — 15 Aug, Raven Holistics' first real review alert died on Twilio 21211,
// "The 'To' number whatsapp:+44 7933189216 is not a valid phone number." The
// self-serve signup form formats numbers for READING ("+44 7933189216"), and
// that single space is enough for Twilio to reject the send. Every outbound
// WhatsApp to a self-serve signup was affected; it only surfaced now because
// Naomi is the first. Admin-created clients had numbers typed without a space.
//
// Normalising at SEND time as well as on write means records already saved with
// a space are fixed too, with no data migration.
function toE164(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const d = raw.replace(/[^\d]/g, "");
  if (!d) return "";
  if (raw.startsWith("+")) return "+" + d;   // already international — trust it
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith("0")) return "+44" + d.slice(1);  // UK national
  if (d.startsWith("44")) return "+" + d;
  return "+" + d;
}


export const config = { schedule: "0 9 8 1,4,7,10 *" };

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}
const clean = (v, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function quarterKey(now) {
  return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

// Only a genuinely subscribed client should get these nudges. An ALLOW-list, not
// a deny-list: Stripe has statuses we haven't thought of (unpaid, incomplete,
// incomplete_expired, …) and a deny-list silently lets every new one through.
// "" = a grandfathered client from before statuses were recorded — treat as live.
// Trial clients are deliberately EXCLUDED: the profile work, including these
// nudges, is what subscribing pays for (see profile-check.js).
function isActiveSubscriber(c) {
  const s = String((c && c.subscriptionStatus) || "").toLowerCase();
  return s === "active" || s === "";
}

function isSendable(c) {
  if (!c || !c.phone) return false;
  if (c.nudgesOptOut === true || c.reportsOptOut === true) return false;
  return isActiveSubscriber(c);
}

// A tailored 4-idea shot-list by business type. Falls back to a solid generic.
function shotList(businessType) {
  const t = String(businessType || "").toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  let ideas;
  if (has("garage", "mechanic", "mot", "auto", "car", "tyre")) ideas = ["a clean, tidy workspace", "a car mid-service or a happy handover", "your team in workwear", "the waiting area / reception"];
  else if (has("cafe", "café", "coffee", "bakery", "tea")) ideas = ["your signature drink or bake", "the counter / display", "a cosy corner of the room", "a friendly face behind the counter"];
  else if (has("restaurant", "takeaway", "pub", "bar", "food", "kitchen", "diner")) ideas = ["your best-selling dish, well lit", "the dining room or bar", "the exterior / signage", "the team at work"];
  else if (has("salon", "hair", "barber", "beauty", "nail", "spa", "lash", "brow")) ideas = ["a fresh before/after", "your styling station or chairs", "the reception / waiting area", "your team mid-treatment"];
  else if (has("gym", "fitness", "yoga", "pilates", "studio", "personal train")) ideas = ["the main floor or a class in action", "a piece of standout kit", "a coach with a member", "the changing / social area"];
  else if (has("plumb", "electric", "build", "roof", "joiner", "carpenter", "landscap", "garden", "paint", "decorat", "trade")) ideas = ["a finished job you're proud of", "a clean before/after", "you or the team on site (van + logo)", "tools or materials laid out neatly"];
  else if (has("dentist", "clinic", "physio", "doctor", "vet", "therap", "health")) ideas = ["a bright, welcoming reception", "a treatment room (tidy + modern)", "a friendly team member", "the exterior / signage"];
  else if (has("shop", "store", "retail", "boutique", "florist")) ideas = ["a well-styled window or display", "a hero product close-up", "the shopfront", "a helpful face on the floor"];
  else ideas = ["your storefront or premises", "your product or service in action", "a friendly team member", "a happy customer moment"];
  return ideas.map((x) => "• " + x).join("  ");
}

async function sendWhatsApp(params) {
  const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${await resp.text()}`);
}

export default async () => {
  const contentSid = process.env.TWILIO_PHOTO_CONTENT_SID;
  if (!contentSid) {
    console.log("[photo-refresh-send] TWILIO_PHOTO_CONTENT_SID not set — nothing sent (feature not configured yet).");
    return new Response("not configured");
  }

  // Phase 2: only open the reply-with-photos window if uploads are actually on.
  const uploadsOn = process.env.TREY_PHOTO_UPLOAD === "true" && process.env.TREY_LIVE_POSTING === "true";

  const now = new Date();
  const qKey = quarterKey(now);
  const clientsStore = blobsStore("clients");
  const sentStore = blobsStore("photosent");
  const reqStore = blobsStore("photoreq");

  const from = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const summary = { quarter: qKey, sent: 0, skipped: 0, failed: 0, uploadsOn };

  let blobs = [];
  try { ({ blobs } = await clientsStore.list()); }
  catch (err) { console.error("[photo-refresh-send] list clients failed:", err.message); return new Response("no clients"); }

  for (const b of blobs) {
    let client;
    try { client = await clientsStore.get(b.key, { type: "json" }); } catch { continue; }
    if (!isSendable(client)) { summary.skipped++; continue; }

    const loc = client.locationId || b.key;
    if (await sentStore.get(`photo:${loc}:${qKey}`)) { summary.skipped++; continue; }

    const params = messagingServiceSid
      ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
      : { To: `whatsapp:${toE164(client.phone)}`, From: from };
    params.ContentSid = contentSid;
    params.ContentVariables = JSON.stringify({
      1: clean(client.businessName, 60),
      2: clean(shotList(client.businessType), 400),
    });

    try {
      await sendWhatsApp(params);
      try { await sentStore.setJSON(`photo:${loc}:${qKey}`, { at: new Date().toISOString() }); }
      catch (e) { console.error(`[photo-refresh-send] ${loc} sent but marker failed:`, e.message); }
      // Phase 2: open a 21-day window so photos they reply with get uploaded.
      if (uploadsOn) {
        const digits = String(client.phone || "").replace(/\D/g, "");
        if (digits) {
          await reqStore.setJSON(digits, {
            locationId: loc,
            accountId: client.googleAccountId || "",
            openedAt: new Date().toISOString(),
            expiresMs: Date.now() + 21 * 86400000,
          });
        }
      }
      summary.sent++;
    } catch (err) {
      summary.failed++;
      console.error(`[photo-refresh-send] ${loc} failed:`, err.message);
    }
  }

  console.log("[photo-refresh-send] done:", JSON.stringify(summary));
  return new Response("ok");
};
