// Netlify Scheduled Function — sends every eligible client their MONTHLY
// Trey report over WhatsApp. Runs on the 1st and reports the month that just
// finished. Fires a few hours after monthly-google-sync (00:00 UTC) so the
// Google ratings are freshly refreshed before we quote them.
//
// Schedule: "0 9 1 * *" = 09:00 UTC on the 1st of each month.
//
// Monthly template `trey_monthly_report_v2` (Call to action + URL button).
// Variable order:
//   {{1}} business name
//   {{2}} stand taps this month
//   {{3}} new reviews via the Trey stand this month
//   {{4}} other (organic) Google reviews this month
//   {{5}} Google rating "from"  (at sign-up)
//   {{6}} Google rating "to"    (current)
//   {{7}} report-link query string appended to the button URL:
//         loc=<id>&m=<YYYY-MM>&k=<key>
//
// The button URL in the template is  .../report?{{7}}  — so {{7}} is the whole
// query string. The key is derived exactly as report.js derives it, so the
// link this send builds passes report.js's access check.

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

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


export const config = { schedule: "0 9 1 * *" };

// Fallback to the live Utility SID (trey_monthly_report_v3) so this works even
// before the env var is set. Override with TWILIO_MONTHLY_CONTENT_SID on Netlify.
const MONTHLY_CONTENT_SID =
  process.env.TWILIO_MONTHLY_CONTENT_SID || "HX71ca271a874e3d0dee582ea32301b2f1";

// MUST match KEY_LEN in report.js. If you change one, change both.
const KEY_LEN = 32;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Same signing scheme as report.js: HMAC-SHA256(locationId, secret), truncated.
function reportKey(locationId) {
  return crypto
    .createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update(String(locationId))
    .digest("hex")
    .slice(0, KEY_LEN);
}

// Previous calendar month as YYYY-MM (the month being reported).
function prevMonthKey(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

const clean = (v, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Format a rating for the message; blank/unknown becomes an em dash.
const rating = (v) => (v === 0 || v ? clean(v, 8) : "—");

function isSendable(c) {
  if (!c || !c.phone) return false;
  if (c.reportsOptOut === true) return false;
  const status = (c.subscriptionStatus || "").toLowerCase();
  if (status === "paused" || status === "cancelled" || status === "canceled") return false;
  return true;
}

async function sendWhatsApp(params) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    }
  );
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${await resp.text()}`);
}

export default async () => {
  const now = new Date();
  const mKey = prevMonthKey(now);

  if (!process.env.TREY_REPORT_SECRET) {
    console.warn("[monthly-report-send] TREY_REPORT_SECRET not set — report links will not validate.");
  }

  const clientsStore = blobsStore("clients");
  const tapTallyStore = blobsStore("taptally");
  const reviewTallyStore = blobsStore("reviewtally");
  const sentStore = blobsStore("reportssent"); // idempotency: one send per client per month

  const twilioFrom = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  const summary = { month: mKey, sent: 0, skipped: 0, failed: 0 };

  let blobs = [];
  try {
    ({ blobs } = await clientsStore.list());
  } catch (err) {
    console.error("[monthly-report-send] could not list clients:", err.message);
    return new Response("no clients");
  }

  for (const b of blobs) {
    let client;
    try {
      client = await clientsStore.get(b.key, { type: "json" });
    } catch {
      continue;
    }
    if (!isSendable(client)) { summary.skipped++; continue; }

    const loc = client.locationId || b.key;
    // Already sent this client their report for this month? Skip — so a re-fire
    // or redeploy-trigger never double-messages anyone.
    if (await sentStore.get(`monthly:${loc}:${mKey}`)) { summary.skipped++; continue; }
    const monthTally = (await tapTallyStore.get(`${loc}:${mKey}`, { type: "json" })) || {};
    const monthReviews = (await reviewTallyStore.get(`${loc}:${mKey}`, { type: "json" })) || {};

    const taps = monthTally.taps || 0;
    const tapReviews = monthReviews.tapReviews || 0;
    const organicReviews = monthReviews.organicReviews || 0;
    const hasRating = client.googleRating || client.initialGoogleRating;

    // Skip only a truly empty month with no rating to show — nothing to say.
    if (taps === 0 && tapReviews === 0 && organicReviews === 0 && !hasRating) {
      summary.skipped++;
      continue;
    }

    // Rating "from" (sign-up) -> "to" (current). Fall back to each other so we
    // never show a dash on one side when the other is known.
    const ratingFrom = client.initialGoogleRating ?? client.googleRating;
    const ratingTo = client.googleRating ?? client.initialGoogleRating;

    const reportQuery =
      `loc=${encodeURIComponent(loc)}&m=${mKey}&k=${reportKey(loc)}`;

    const params = messagingServiceSid
      ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
      : { To: `whatsapp:${toE164(client.phone)}`, From: twilioFrom };
    params.ContentSid = MONTHLY_CONTENT_SID;
    params.ContentVariables = JSON.stringify({
      1: clean(client.businessName, 60),
      2: clean(taps, 12),
      3: clean(tapReviews, 12),
      4: clean(organicReviews, 12),
      5: rating(ratingFrom),
      6: rating(ratingTo),
      7: clean(reportQuery, 300),
    });

    try {
      await sendWhatsApp(params);
      await sentStore.setJSON(`monthly:${loc}:${mKey}`, { at: new Date().toISOString() });
      summary.sent++;
    } catch (err) {
      summary.failed++;
      console.error(`[monthly-report-send] ${loc} failed:`, err.message);
    }
  }

  console.log("[monthly-report-send] done:", JSON.stringify(summary));
  return new Response("ok");
};
