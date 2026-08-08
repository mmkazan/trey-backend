// Netlify Scheduled Function — sends every eligible client their WEEKLY
// Trey report over WhatsApp. Runs Monday mornings and reports the week that
// just finished (last Monday–Sunday).
//
// Schedule: "0 8 * * 1" = 08:00 UTC every Monday (~9am UK in summer, 8am in winter).
//
// Data is read straight from the same Blobs stores that tap.js and
// review-webhook.js write to — no self-HTTP call needed. The send reuses the
// exact Twilio Content API pattern from review-webhook.js.
//
// Weekly template `trey_weekly_report` (Text, no button). Variable order:
//   {{1}} business name
//   {{2}} stand taps this week
//   {{3}} new reviews via the Trey stand this week
//   {{4}} other (organic) Google reviews this week

import { getStore } from "@netlify/blobs";

export const config = { schedule: "0 8 * * 1" };

// Fallbacks to the live SIDs so this works even before the env vars are set.
const WEEKLY_CONTENT_SID =
  process.env.TWILIO_WEEKLY_CONTENT_SID || "HX0952b59e0412f096d5e23d67e6b31d97";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Monday (UTC) of the given date's week, as YYYY-MM-DD. Must match tap.js /
// client.js so we read the same weekly keys they wrote.
function weekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun .. 6=Sat
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

// The most recently COMPLETED week's key. Take this week's Monday, step back
// one day into the previous week, and take that week's Monday.
function lastCompleteWeekKey(now) {
  const thisMonday = new Date(`${weekKey(now)}T00:00:00Z`);
  const inPrevWeek = new Date(thisMonday.getTime() - 24 * 60 * 60 * 1000);
  return weekKey(inPrevWeek);
}

// WhatsApp template variables must be single-line (no newlines/tabs, no runs
// of 4+ spaces) and reasonably short, or Twilio rejects the send.
const clean = (v, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// A client is skipped if it has no phone, has opted out, or its subscription
// is paused/cancelled. Everyone else (trial, active, or grandfathered) is in.
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
  const wKey = lastCompleteWeekKey(now);

  const clientsStore = blobsStore("clients");
  const tapTallyStore = blobsStore("taptally");
  const reviewTallyStore = blobsStore("reviewtally");

  const twilioFrom = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  const summary = { week: wKey, sent: 0, skipped: 0, failed: 0 };

  let blobs = [];
  try {
    ({ blobs } = await clientsStore.list());
  } catch (err) {
    console.error("[weekly-report-send] could not list clients:", err.message);
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
    const weekTally = (await tapTallyStore.get(`${loc}:week:${wKey}`, { type: "json" })) || {};
    const weekReviews = (await reviewTallyStore.get(`${loc}:week:${wKey}`, { type: "json" })) || {};

    const taps = weekTally.taps || 0;
    const tapReviews = weekReviews.tapReviews || 0;
    const organicReviews = weekReviews.organicReviews || 0;

    // Don't send a dead-quiet week (0 taps and 0 reviews) — it reads as spam
    // and is demoralising. They'll get the monthly summary regardless.
    if (taps === 0 && tapReviews === 0 && organicReviews === 0) { summary.skipped++; continue; }

    const params = messagingServiceSid
      ? { To: `whatsapp:${client.phone}`, MessagingServiceSid: messagingServiceSid }
      : { To: `whatsapp:${client.phone}`, From: twilioFrom };
    params.ContentSid = WEEKLY_CONTENT_SID;
    params.ContentVariables = JSON.stringify({
      1: clean(client.businessName, 60),
      2: clean(taps, 12),
      3: clean(tapReviews, 12),
      4: clean(organicReviews, 12),
    });

    try {
      await sendWhatsApp(params);
      summary.sent++;
    } catch (err) {
      summary.failed++;
      console.error(`[weekly-report-send] ${loc} failed:`, err.message);
    }
  }

  console.log("[weekly-report-send] done:", JSON.stringify(summary));
  return new Response("ok");
};
