// Netlify Scheduled Function — runs once a month and refreshes every
// client's live Google rating + review count by calling the existing
// refresh-google-stats function. No input needed; Netlify fires it.
//
// Schedule: "@monthly" = 00:00 UTC on the 1st of each month.

export const config = { schedule: "@monthly" };

export default async () => {
  const base = process.env.URL || "https://treyv1.netlify.app";
  const token = process.env.CLIENT_ADMIN_TOKEN;
  if (!token) {
    console.error("[monthly-google-sync] CLIENT_ADMIN_TOKEN is not set — cannot run the sync.");
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
      return new Response("sync failed", { status: 502 });
    }
    console.log("[monthly-google-sync] done:", JSON.stringify(data));
  } catch (err) {
    console.error("[monthly-google-sync] failed:", err.message);
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
};
