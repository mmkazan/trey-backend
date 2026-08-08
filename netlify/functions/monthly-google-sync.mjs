// Netlify Scheduled Function — runs once a month and refreshes every
// client's live Google rating + review count by calling the existing
// refresh-google-stats function. No input needed; Netlify fires it.
//
// Schedule: "@monthly" = 00:00 UTC on the 1st of each month.

export const config = { schedule: "@monthly" };

export default async () => {
  const base = process.env.URL || "https://treyv1.netlify.app";
  const token = process.env.CLIENT_ADMIN_TOKEN;
  try {
    const res = await fetch(
      `${base}/.netlify/functions/refresh-google-stats?token=${encodeURIComponent(token)}`
    );
    const data = await res.json().catch(() => ({}));
    console.log("[monthly-google-sync] done:", JSON.stringify(data));
  } catch (err) {
    console.error("[monthly-google-sync] failed:", err.message);
  }
  return new Response("ok");
};
