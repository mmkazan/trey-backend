// Netlify Scheduled Function — runs once a month and refreshes every
// client's live Google rating + review count by calling the existing
// refresh-google-stats function. No input needed; Netlify fires it.
//
// Schedule: "@monthly" = 00:00 UTC on the 1st of each month.

import runlogMod from "./runlog.js";
const { recordRun, recordFailure } = runlogMod;

export const config = { schedule: "@monthly" };

export default async () => {
  // EVERY EXIT IS RECORDED. Until 18 Aug this function wrote no run log at all,
  // on any path — so it was invisible to the daily digest by construction, and
  // "is the monthly Google sync working?" had no answer short of reading logs.
  const startedAt = new Date().toISOString();
  const base = process.env.URL || "https://treyv1.netlify.app";
  const token = process.env.CLIENT_ADMIN_TOKEN;
  if (!token) {
    console.error("[monthly-google-sync] CLIENT_ADMIN_TOKEN is not set — cannot run the sync.");
    await recordFailure("monthly-google-sync", "misconfigured", "CLIENT_ADMIN_TOKEN is not set", startedAt);
    return new Response("missing token", { status: 500 });
  }
  try {
    // Authenticate via header (not the query string) so the token never lands
    // in a request-log URL.
    const res = await fetch(`${base}/.netlify/functions/refresh-google-stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[monthly-google-sync] refresh failed (${res.status}):`, JSON.stringify(data));
      await recordFailure("monthly-google-sync", "refresh-failed",
        `HTTP ${res.status}: ${JSON.stringify(data)}`, startedAt);
      return new Response("sync failed", { status: 502 });
    }
    console.log("[monthly-google-sync] done:", JSON.stringify(data));
    await recordRun("monthly-google-sync", {
      ok: true, startedAt, finishedAt: new Date().toISOString(),
      processed: Number(data && data.updated) || 0, failed: 0, skipped: 0, remaining: 0, timedOut: false,
    });
  } catch (err) {
    console.error("[monthly-google-sync] failed:", err.message);
    await recordFailure("monthly-google-sync", "threw", err.message, startedAt);
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
};
