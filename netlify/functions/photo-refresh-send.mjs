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

// WHY THIS ISN'T A PLAIN for-LOOP ANY MORE.
//
// It used to walk every client strictly one at a time. When the run hit the
// platform's time limit part-way down the list, the clients already done had
// their `photo:<loc>:<qKey>` marker written and the rest had nothing — and
// because that marker key embeds the QUARTER, the next run looks for a different
// key entirely. The tail of the client list never got that quarter's nudge at
// all. Not delayed: skipped, permanently, and silently. On a quarterly send that
// is a client who hears nothing for six months.
//
// So: a worker pool so the list actually finishes, a deadline so we stop
// STARTING work before the platform kills us mid-send, and a run log plus a
// summary that always prints, so a short run is loud instead of invisible.

// Six at a time, deliberately modest — every unit of work here is a Twilio send
// and Twilio rate-limits an account that fires them too fast.
const SEND_CONCURRENCY = 6;

// Netlify gives a scheduled function 15 minutes. Don't rely on that: stop
// dispatching new clients at ten, leaving room for in-flight sends to land and
// for the run log to be written.
const TIME_BUDGET_MS = 600_000;

// The run record has to stay small however badly a run goes, so cap the list of
// failures it carries.
const MAX_FAILED_IDS = 50;

// Every run leaves a record — including a truncated one — so "who didn't get it"
// is answerable after the fact instead of being a guess.
async function writeRunLog(record) {
  try {
    await blobsStore("runlog").setJSON(`photo-refresh-send:${record.finishedAt}`, record);
  } catch (e) {
    console.error("[photo-refresh-send] run log write failed:", e.message);
  }
}

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

  const START = Date.now();
  const DEADLINE = START + TIME_BUDGET_MS;

  const now = new Date();
  const qKey = quarterKey(now);
  const clientsStore = blobsStore("clients");
  const sentStore = blobsStore("photosent");
  const reqStore = blobsStore("photoreq");

  const from = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const summary = { quarter: qKey, sent: 0, skipped: 0, failed: 0, uploadsOn };
  const failedLocationIds = [];
  const noteFailure = (loc) => { if (failedLocationIds.length < MAX_FAILED_IDS) failedLocationIds.push(loc); };

  let blobs = [];
  try { ({ blobs } = await clientsStore.list()); }
  catch (err) {
    console.error("[photo-refresh-send] list clients failed:", err.message);
    // A failed list means EVERY client goes without this quarter's nudge. That is
    // the loudest version of the silent-skip this run log exists to catch, so
    // record it rather than leaving one console line behind.
    await writeRunLog({
      fn: "photo-refresh-send", quarter: qKey,
      startedAt: new Date(START).toISOString(), finishedAt: new Date().toISOString(),
      processed: 0, sent: 0, failed: 0, skipped: 0, remaining: 0,
      timedOut: false, listFailed: true, failedLocationIds: [],
    });
    return new Response("no clients");
  }

  // One client, start to finish. This is the old loop body verbatim; the only
  // change is that "continue" is now "return".
  async function handleOne(b) {
    let client;
    try { client = await clientsStore.get(b.key, { type: "json" }); } catch { summary.skipped++; return; }
    if (!isSendable(client)) { summary.skipped++; return; }

    const loc = client.locationId || b.key;
    if (await sentStore.get(`photo:${loc}:${qKey}`)) { summary.skipped++; return; }

    const params = messagingServiceSid
      ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
      : { To: `whatsapp:${toE164(client.phone)}`, From: from };
    // Twilio returns 201 on ACCEPT, not on delivery. StatusCallback is how we
    // find out what actually happened to it — see twilio-status.js.
    params.StatusCallback = `${process.env.URL || "https://trey.today"}/.netlify/functions/twilio-status`;
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
      noteFailure(loc);
      console.error(`[photo-refresh-send] ${loc} failed:`, err.message);
    }
  }

  let cursor = 0;
  let attempted = 0;
  let timedOut = false;

  async function worker() {
    while (true) {
      // Stop STARTING work at the deadline. Anything already in flight is left
      // to finish — an abandoned send is a client who may or may not have been
      // messaged, which is worse than one who definitely wasn't.
      if (Date.now() > DEADLINE) { timedOut = true; return; }
      const i = cursor++;
      if (i >= blobs.length) return;
      attempted++;
      try {
        await handleOne(blobs[i]);
      } catch (err) {
        // A blob read or the photo-request write blowing up used to take the
        // whole run down with it and strand every client after this one. Now it
        // costs one client.
        summary.failed++;
        noteFailure(blobs[i].key);
        console.error(`[photo-refresh-send] ${blobs[i].key} errored:`, err.message);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, blobs.length) }, worker));
  } finally {
    // In a finally so a run that stopped short still says what it did. The old
    // summary line sat after the loop, which meant the runs worth knowing about
    // were exactly the ones that never printed one.
    const remaining = Math.max(0, blobs.length - attempted);
    const record = {
      fn: "photo-refresh-send", quarter: qKey,
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date().toISOString(),
      processed: attempted,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
      remaining,
      timedOut,
      failedLocationIds: failedLocationIds.slice(0, MAX_FAILED_IDS),
    };
    await writeRunLog(record);
    const line = JSON.stringify({ ...summary, processed: attempted, remaining, timedOut });
    // A client who never got their nudge is an error, not a statistic.
    if (timedOut || remaining > 0) console.error("[photo-refresh-send] done:", line);
    else console.log("[photo-refresh-send] done:", line);
  }
  return new Response("ok");
};
