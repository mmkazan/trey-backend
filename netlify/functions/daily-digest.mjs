// Netlify Scheduled Function — one email a morning with everything that moved.
//
// Schedule: "0 7 * * *" = 07:00 UTC daily, i.e. 08:00 BST in summer and 07:00
// GMT in winter. Netlify cron is UTC-only and there is no way to pin it to a
// local hour, so the winter hour drifts by one. Deliberate: the alternative is
// running twice a day and suppressing one, which is worse.
//
// This file is IO and orchestration ONLY. Every section builder, the window
// arithmetic and the email renderer live in digest-lib.js so they can be tested
// without the Netlify runtime — @netlify/blobs does not exist outside it.
//
// WHY EMAIL AND NOT WHATSAPP
// --------------------------
// A digest cannot go over WhatsApp. Meta only delivers a free-form message
// inside a 24-hour session window, so a 07:00 push would land only on days
// Matthew had already messaged the Trey number — and a digest's content varies
// far too much to fit a fixed template. That is the exact trap that hid the
// broken approval loop for weeks: Twilio accepts the request, the code sees
// success, and nothing arrives. Email through the verified trey.today Resend
// domain always lands.
//
// WHY A SNAPSHOT AND NOT "YESTERDAY"
// ----------------------------------
// Taps are stored as COUNTERS, not timestamped events — tap.js keeps
// `<loc>:total`, a month bucket and a week bucket, and nothing per day. Adding a
// daily bucket would mean another blob write on the tap hot path, which is the
// one path a customer stands at a counter waiting for. So this function keeps
// its own snapshot of those counters and reports the DELTA since its last run.
//
// That also makes a missed run self-healing: if Thursday's run dies, Friday's
// covers both days and says so in the header, rather than losing a day silently.
// Everything else — clients, reviews, message statuses, run logs, walks — is
// already timestamped and gets filtered by the window directly.
//
// NOTHING HERE MAY THROW. A digest that fails is a digest that stops being read,
// and its whole purpose is surfacing silent failure. Every section is wrapped
// independently; one that breaks reports itself as broken IN the email and the
// other nine still go out.

import { getStore } from "@netlify/blobs";
import digest from "./digest-lib.js";

const {
  iso, ts, renderEmail,
  sectionNewCustomers, sectionActivations, sectionTrialsEnding, sectionTaps,
  sectionReviews, sectionAwaitingApproval, sectionDelivery, sectionSchedulers,
  sectionWalks, sectionBilling, sectionComeBacks, latestRunKeys,
} = digest;

export const config = { schedule: "0 7 * * *" };

// The repo is PUBLIC. No address literal in source — this is an env var, with a
// business inbox already published in the site's own footer as the default.
const DIGEST_TO = process.env.TREY_DIGEST_TO || "info@trey.today";
const RESEND_FROM = process.env.RESEND_FROM || "Trey <hello@trey.today>";

// Netlify allows a scheduled function 15 minutes. Stop starting work at eight,
// leaving room to render, send and write the run log. Same reasoning as the
// senders: a run killed part-way must never look like a quiet day.
const TIME_BUDGET_MS = 480_000;
const LIST_CONCURRENCY = 6;
const MAX_SNAPSHOT_KEYS = 5000;

// First run has no baseline. Reporting "0 taps" would be a lie and reporting the
// all-time total a worse one, so the first run says what it is.
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// List a store's keys, tolerating one that does not exist yet. A store nothing
// has ever written to is not an error.
async function listKeys(name) {
  try {
    const { blobs } = await blobsStore(name).list();
    return (blobs || []).map((b) => b.key);
  } catch (e) {
    console.warn(`[daily-digest] could not list ${name}: ${e.message}`);
    return [];
  }
}

// Fetch many keys with a bounded pool. Sequential reads inside a timed function
// is the defect this codebase has shipped six times. Do not reintroduce it.
async function getMany(name, keys) {
  const s = blobsStore(name);
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(LIST_CONCURRENCY, keys.length || 1) }, async () => {
    while (i < keys.length) {
      const k = keys[i++];
      try {
        const v = await s.get(k, { type: "json" });
        if (v) out.push({ key: k, value: v });
      } catch { /* one unreadable record must not lose the other 200 */ }
    }
  });
  await Promise.all(workers);
  return out;
}

async function sendEmail(subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.error("[daily-digest] RESEND_API_KEY not set — cannot send");
    return { sent: false, reason: "RESEND_API_KEY not set" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [DIGEST_TO], subject, html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[daily-digest] Resend ${res.status}: ${detail.slice(0, 300)}`);
    return { sent: false, reason: `Resend ${res.status}` };
  }
  return { sent: true };
}

export default async () => {
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const notes = [];

  // Each read and each section runs behind its own catch. `label` goes into the
  // email if it fails, so an incomplete digest announces itself instead of
  // quietly reading as a quiet day.
  const guard = async (label, fn) => {
    try {
      if (Date.now() > deadline) { notes.push(`${label}: skipped, the run was out of time.`); return null; }
      return await fn();
    } catch (e) {
      console.error(`[daily-digest] ${label} failed:`, e.message);
      notes.push(`${label}: could not be read (${e.message}).`);
      return null;
    }
  };

  const cfg = blobsStore("config");
  let state = null;
  try { state = await cfg.get("daily-digest:state", { type: "json" }); } catch { /* first run */ }

  const now = Date.now();
  const firstRun = !state || !Number.isFinite(ts(state.finishedAt));
  const from = firstRun ? now - FIRST_RUN_WINDOW_MS : ts(state.finishedAt);
  const baseline = (state && state.tapTotals) || null;

  // --- read once, share between sections -----------------------------------
  const clients = (await guard("Clients", async () => getMany("clients", await listKeys("clients")))) || [];
  const nameOf = (loc) => {
    const hit = clients.find((c) => c.key === loc);
    return (hit && hit.value.businessName) || loc || "(unknown)";
  };

  const reviews = (await guard("Reviews", async () => {
    const keys = (await listKeys("reviews")).filter((k) => k.startsWith("review:"));
    return getMany("reviews", keys);
  })) || [];

  // `tapsOk` is load-bearing, not cosmetic — see nextSnapshot() in digest-lib.js
  // for what writing a failed read as the baseline would do to tomorrow's email.
  const tapsRead = await guard("Taps", async () => {
    const keys = (await listKeys("taptally")).filter((k) => k.endsWith(":total")).slice(0, MAX_SNAPSHOT_KEYS);
    const rows = await getMany("taptally", keys);
    const out = {};
    for (const r of rows) out[r.key.slice(0, -":total".length)] = Number(r.value.taps) || 0;
    return out;
  });
  const tapsOk = tapsRead !== null;
  const tapTotals = tapsRead || {};

  // Leads, for the come-back reminders. Same guard as everything else: if the
  // store cannot be read the section is named as unreadable in the email rather
  // than silently reporting "no callbacks today".
  const leads = (await guard("Leads", async () => getMany("leads", await listKeys("leads")))) || [];

  const statuses = (await guard("Message statuses", async () => getMany("messagestatus", await listKeys("messagestatus")))) || [];
  // Keys are cheap; records are not — fetch-reviews alone writes 96 a day. So:
  // list the keys, work out the newest one per scheduler, and fetch only those
  // few. Reading every run log ever written to answer "did the last one work"
  // would be the sequential-reads defect this codebase keeps finding.
  const runlogKeys = (await guard("Run log", async () => listKeys("runlog"))) || [];
  const latestRuns = (await guard("Scheduler outcomes", async () => {
    const wanted = latestRunKeys(runlogKeys);
    const rows = await getMany("runlog", Object.values(wanted));
    const byKey = {};
    for (const r of rows) byKey[r.key] = r.value;
    const out = {};
    for (const [name, key] of Object.entries(wanted)) out[name] = byKey[key] || null;
    return out;
  })) || {};
  const walks = (await guard("Trey Go", async () => getMany("walks", await listKeys("walks")))) || [];
  const stripeEvents = (await guard("Stripe events", async () => getMany("stripeevents", await listKeys("stripeevents")))) || [];

  // --- build the sections ---------------------------------------------------
  const built = await Promise.all([
    guard("New signups", () => sectionNewCustomers(clients, from, now)),
    guard("Activations", () => sectionActivations(clients, from, now)),
    guard("Trials ending", () => sectionTrialsEnding(clients, now)),
    guard("Come backs", () => sectionComeBacks(leads, now)),
    guard("Replies unapproved", () => sectionAwaitingApproval(reviews, now)),
    guard("Delivery failures", () => sectionDelivery(statuses, from, now)),
    guard("Schedulers", () => sectionSchedulers(runlogKeys, latestRuns, now)),
    guard("New reviews", () => sectionReviews(reviews, from, now, nameOf)),
    guard("Tap counts", () => sectionTaps(tapTotals, baseline, nameOf)),
    guard("Trey Go activity", () => sectionWalks(walks, from, now)),
    guard("Billing", () => sectionBilling(stripeEvents, from, now)),
  ]);

  // Alerts first — the point of the email is the thing that needs him.
  const sections = built.filter(Boolean).sort((a, b) => (b.alert ? 1 : 0) - (a.alert ? 1 : 0));

  const { subject, html } = renderEmail({ from, to: now, sections, notes, firstRun });
  const sendResult = await sendEmail(subject, html);

  // Advance the snapshot ONLY on a successful send. If the email never went out,
  // tomorrow's run must cover today too rather than reporting a delta against a
  // window nobody ever read.
  const finishedAt = new Date().toISOString();
  if (sendResult.sent) {
    try {
      await cfg.setJSON("daily-digest:state", digest.nextSnapshot(state, tapTotals, tapsOk, finishedAt));
    } catch (e) {
      console.error("[daily-digest] state write failed:", e.message);
    }
  }

  const record = {
    finishedAt, windowFrom: iso(from), windowTo: iso(now),
    sections: sections.map((s) => s.title), alerts: sections.filter((s) => s.alert).length,
    notes, sent: sendResult.sent, reason: sendResult.reason || "", ms: Date.now() - started,
  };
  try { await blobsStore("runlog").setJSON(`daily-digest:${finishedAt}`, record); }
  catch (e) { console.error("[daily-digest] run log write failed:", e.message); }

  console.log("[daily-digest]", JSON.stringify(record));
  return new Response(JSON.stringify(record), { headers: { "Content-Type": "application/json" } });
};
