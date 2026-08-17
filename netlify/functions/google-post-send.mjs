// Netlify Scheduled Function — MONTHLY "keep your profile active" Google Post
// nudge. On the 5th of each month (spaced from the report on the 1st) it drafts
// a short, on-brand Google Post for every active client and WhatsApps it to them
// with a one-tap link to approve + publish (or copy/paste until the Google API
// is live). Google rewards profiles that post regularly.
//
// Schedule: "0 9 5 * *" = 09:00 UTC on the 5th.
//
// FAIL-SAFE: if TWILIO_POST_CONTENT_SID isn't set, this sends nothing and just
// logs — so committing/deploying it does nothing until you create the template.
//
// WhatsApp template `trey_google_post` (Call to action + URL button). Variables:
//   {{1}} business name
//   {{2}} the drafted post (preview shown in the chat)
//   {{3}} link query string appended to the button URL  .../google-post?{{3}}
//         -> p=<postId>&sig=<sig>

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


export const config = { schedule: "0 9 5 * *" };

const KEY_LEN = 32;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// WHY THIS ISN'T A PLAIN for-LOOP ANY MORE.
//
// It used to walk every client strictly one at a time, and each client costs a
// Gemini draft AND a Twilio send, so the list is slow. When the run hit the
// platform's time limit part-way down, the clients already done had their
// `post:<loc>:<mKey>` marker written and the rest had nothing — and because that
// marker key embeds the MONTH, the next run looks for a different key entirely.
// The tail of the client list never got that month's nudge at all. Not delayed:
// skipped, permanently, and silently.
//
// So: a worker pool so the list actually finishes, a deadline so we stop
// STARTING work before the platform kills us mid-send, and a run log plus a
// summary that always prints, so a short run is loud instead of invisible.

// Six at a time, deliberately modest — every unit of work here ends in a Twilio
// send and Twilio rate-limits an account that fires them too fast.
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
    await blobsStore("runlog").setJSON(`google-post-send:${record.finishedAt}`, record);
  } catch (e) {
    console.error("[google-post-send] run log write failed:", e.message);
  }
}

// Per-post signature — the approve link only works for this one post. Matches
// signPost() in google-post.js.
function signPost(postId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update("post:" + String(postId)).digest("hex").slice(0, KEY_LEN);
}

const clean = (v, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function monthName(now) {
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][now.getUTCMonth()];
}
function monthKey(now) { return now.toISOString().slice(0, 7); }

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

// A safe, on-brand fallback post if the AI call is unavailable — so we always
// have something sensible to send.
function fallbackPost(client, mName) {
  const name = client.businessName || "our place";
  const type = client.businessType || "business";
  return `${mName} at ${name} — we're open and ready to help, whether it's your first visit or your tenth. Pop in or get in touch, and if we've looked after you recently a quick Google review always makes our day. ⭐`;
}

// Draft a short Google Post with Gemini (same model as generate-reply), tailored
// to the business + month. Falls back to a templated post on any failure.
async function draftPost(client, mName) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallbackPost(client, mName);
  const brandVoice = (client.brandVoice && String(client.brandVoice).trim())
    ? `\nBrand voice to match: "${String(client.brandVoice).trim()}"` : "";
  const prompt = `Write a short Google Business Profile post for ${client.businessName || "a local business"} (a ${client.businessType || "local business"}). It is ${mName}. UK English. 2–3 short sentences, warm and human, no hashtags, no emoji spam (one tasteful emoji at most), no placeholders or brackets. Encourage people to visit or get in touch, and it's fine to gently invite a Google review. Do not use quotation marks around the whole post.${brandVoice}\nReturn ONLY the post text.`;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await resp.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    const out = text && String(text).trim().replace(/^["']|["']$/g, "");
    return out && out.length > 10 ? out : fallbackPost(client, mName);
  } catch (e) {
    console.error("[google-post-send] draft failed, using fallback:", e.message);
    return fallbackPost(client, mName);
  }
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
  const contentSid = process.env.TWILIO_POST_CONTENT_SID;
  if (!contentSid) {
    console.log("[google-post-send] TWILIO_POST_CONTENT_SID not set — nothing sent (feature not configured yet).");
    return new Response("not configured");
  }
  // Hard stop, not a warning: signPost() would sign with "" and google-post.js
  // rejects every such signature, so we'd send a batch of real WhatsApps whose
  // Approve button lands on "Link not valid" — and those signatures stay dead
  // even after the secret is set later.
  if (!process.env.TREY_REPORT_SECRET) {
    console.error("[google-post-send] TREY_REPORT_SECRET not set — nothing sent (approve links would be dead).");
    return new Response("not configured");
  }

  const START = Date.now();
  const DEADLINE = START + TIME_BUDGET_MS;

  const now = new Date();
  const mKey = monthKey(now);
  const mName = monthName(now);

  const clientsStore = blobsStore("clients");
  const postsStore = blobsStore("posts");
  const sentStore = blobsStore("postsent");

  const from = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const summary = { month: mKey, sent: 0, skipped: 0, failed: 0 };
  const failedLocationIds = [];
  const noteFailure = (loc) => { if (failedLocationIds.length < MAX_FAILED_IDS) failedLocationIds.push(loc); };

  let blobs = [];
  try { ({ blobs } = await clientsStore.list()); }
  catch (err) {
    console.error("[google-post-send] list clients failed:", err.message);
    // A failed list means EVERY client goes without this month's nudge. That is
    // the loudest version of the silent-skip this run log exists to catch, so
    // record it rather than leaving one console line behind.
    await writeRunLog({
      fn: "google-post-send", month: mKey,
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
    if (await sentStore.get(`post:${loc}:${mKey}`)) { summary.skipped++; return; }

    const summaryText = await draftPost(client, mName);
    const postId = `${loc}:${mKey}`;
    const sig = signPost(postId);

    // Store the pending post so the approve page can show + publish it.
    await postsStore.setJSON(`pending:${postId}`, {
      postId, locationId: loc,
      accountId: client.googleAccountId || "",
      businessName: client.businessName || "your business",
      placeId: client.placeId || "",
      summary: summaryText,
      status: "pending",
      month: mKey,
      createdAt: new Date().toISOString(),
    });

    // ONE opaque token for the template button, not a query string. A WhatsApp
    // URL-button variable must be a plain suffix, and Meta's reviewers reject
    // templates whose variable carries "p=…&sig=…" or whose URL trails a bare "?".
    // Button URL is therefore:  https://trey.today/.netlify/functions/google-post?r={{3}}
    // google-post.js splits it back into sig + postId. Same shape approve.js uses.
    const token = `${sig}${postId}`;
    const params = messagingServiceSid
      ? { To: `whatsapp:${toE164(client.phone)}`, MessagingServiceSid: messagingServiceSid }
      : { To: `whatsapp:${toE164(client.phone)}`, From: from };
    // Twilio returns 201 on ACCEPT, not on delivery. StatusCallback is how we
    // find out what actually happened to it — see twilio-status.js.
    params.StatusCallback = `${process.env.URL || "https://trey.today"}/.netlify/functions/twilio-status`;
    params.ContentSid = contentSid;
    params.ContentVariables = JSON.stringify({
      1: clean(client.businessName, 60),
      2: clean(summaryText, 500),
      3: clean(token, 300),
    });

    try {
      await sendWhatsApp(params);
      try { await sentStore.setJSON(`post:${loc}:${mKey}`, { at: new Date().toISOString() }); }
      catch (e) { console.error(`[google-post-send] ${loc} sent but marker failed:`, e.message); }
      summary.sent++;
    } catch (err) {
      summary.failed++;
      noteFailure(loc);
      console.error(`[google-post-send] ${loc} failed:`, err.message);
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
        // A blob read or a pending-post write blowing up used to take the whole
        // run down with it and strand every client after this one. Now it costs
        // one client.
        summary.failed++;
        noteFailure(blobs[i].key);
        console.error(`[google-post-send] ${blobs[i].key} errored:`, err.message);
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
      fn: "google-post-send", month: mKey,
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
    if (timedOut || remaining > 0) console.error("[google-post-send] done:", line);
    else console.log("[google-post-send] done:", line);
  }
  return new Response("ok");
};
