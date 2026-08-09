const { getStore } = require("@netlify/blobs");

// NFC/QR "Tappy Stand" landing endpoint.
//
//  - Logs the tap so review-webhook.js can attribute a review to it.
//  - Counts taps per month for reporting ("6 taps -> 4 completed reviews").
//  - Enforces the 14-day free-trial pause promised in the Terms: once a
//    client's trial has ended and they haven't subscribed, the stand shows an
//    "unavailable" page (with a billing link) instead of the Google review page.
//  - Active clients are redirected straight to Google to leave a review.
//
// Clients with no subscriptionStatus are treated as active ("grandfathered"),
// so stands that were live before this feature shipped never pause by surprise.

const TRIAL_DAYS = 14;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Monday (UTC) of the given date's week, as YYYY-MM-DD — used as the weekly key.
function weekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun .. 6=Sat
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

// A quick branded "thank you" screen shown for ~1.6s before we send the
// customer on to Google. Uses the client's saved logoUrl when present.
function thankYouPage(client, target) {
  const name = escapeHtml((client && client.businessName) || displayName(client) || "");
  const logoUrl = client && client.logoUrl ? escapeHtml(client.logoUrl) : "";
  const safeTarget = escapeHtml(target);
  const greeting = name ? `Thanks for visiting ${name}!` : "Thanks for visiting!";
  const logoImg = logoUrl
    ? `<img src="${logoUrl}" alt="${name}" style="max-height:88px;max-width:220px;margin:0 auto 22px;display:block;object-fit:contain;">`
    : "";
  const body = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2;url=${safeTarget}">
<title>Thank you</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{max-width:420px;width:100%;text-align:center}
  h1{font-size:24px;margin:0 0 10px;letter-spacing:-0.4px}
  p{font-size:16px;color:#475569;margin:0 0 24px;line-height:1.55}
  .spinner{width:32px;height:32px;border:4px solid #d1fae5;border-top-color:#059669;border-radius:50%;margin:0 auto 20px;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  a.go{color:#059669;font-size:14px;text-decoration:none}
  .foot{margin-top:32px;font-size:12px;color:#94a3b8}
</style></head>
<body>
  <div class="card">
    ${logoImg}
    <h1>${greeting}</h1>
    <p>Taking you to Google to leave a quick review &mdash; it only takes a moment and really helps other customers find us.</p>
    <div class="spinner"></div>
    <a class="go" id="go" href="${safeTarget}">Not redirected? Tap here</a>
    <div class="foot">Powered by Trey</div>
  </div>
  <script>setTimeout(function(){var g=document.getElementById('go');if(g){window.location.replace(g.href);}},1600);</script>
</body></html>`;
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body,
  };
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Resolve where to send the customer. A `googleUrl` from the tag is only
// accepted if it is an https URL on a Google host — this stops an attacker
// turning a stand link into an open redirect to a phishing site or a
// javascript: link. Otherwise we build the review URL from the client's saved
// placeId (preferred) or the locationId. Netlify already URL-decodes query
// params once, so we must NOT decodeURIComponent again (double-decode corrupts
// valid targets and throws on a literal %).
function safeReviewTarget(googleUrl, client, locationId) {
  const fallbackId = (client && client.placeId) || locationId;
  const fallback = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(fallbackId)}`;
  if (!googleUrl) return fallback;
  try {
    const u = new URL(googleUrl);
    const host = u.hostname.toLowerCase();
    // Google review/maps hosts only. Note: goo.gl (a link shortener) is
    // deliberately excluded, and Google's own /url?q= open-redirector is
    // rejected below — both could otherwise bounce a visitor to any site.
    const okHost =
      host === "google.com" || host.endsWith(".google.com") ||
      host === "g.page" || host.endsWith(".g.page");
    const isRedirector = u.pathname === "/url"; // e.g. https://www.google.com/url?q=https://evil.com
    if (u.protocol === "https:" && okHost && !isRedirector) return u.href;
  } catch (e) { /* not a valid absolute URL — fall through */ }
  return fallback;
}

// Should the stand be paused for this client (trial over, not subscribed)?
function isPaused(client) {
  if (!client) return false;
  const status = client.subscriptionStatus;
  if (status === "active") return false;
  if (status === "paused" || status === "cancelled") return true;
  if (status === "trial") {
    const started = new Date(client.createdAt || Date.now()).getTime();
    const trialEnds = started + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    return Date.now() > trialEnds;
  }
  return false; // no status recorded = grandfathered active
}

// Name to show on the pause page: the individual's sign-off, else the business.
function displayName(client) {
  if (!client) return "the business owner";
  const isIndividual = (client.voicePerspective || "").toLowerCase() === "individual";
  return (isIndividual ? client.publicSignOffName : client.businessName) ||
    client.businessName || client.publicSignOffName || "the business owner";
}

function pausedPage(client, locationId) {
  const name = escapeHtml(displayName(client));
  const payBase = process.env.STRIPE_PAYMENT_LINK || "";
  const payUrl = payBase
    ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "")
    : "";
  const payButton = payUrl
    ? `<a href="${escapeHtml(payUrl)}" style="display:inline-block;margin-top:22px;background:#059669;color:white;text-decoration:none;border-radius:12px;padding:15px 28px;font-size:16px;font-weight:600;">Reactivate subscription</a>`
    : `<p style="color:#94a3b8;font-size:13px;margin-top:22px;">Billing link coming soon.</p>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Review link unavailable</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;">
  <div style="max-width:440px;margin:0 auto;padding:24px;">
    <div style="background:white;border-radius:16px;padding:36px 26px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.05);margin-top:70px;">
      <div style="font-size:40px;">&#9203;</div>
      <h1 style="color:#0f172a;font-size:20px;margin:14px 0 8px;">This review link is currently unavailable</h1>
      <p style="color:#64748b;font-size:15px;line-height:1.5;margin:0;">If you were about to leave a review, thank you &mdash; please let <strong>${name}</strong> know their Trey Tappy Stand needs reactivating.</p>
      <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0;">
      <p style="color:#475569;font-size:14px;line-height:1.5;margin:0;"><strong>${name}</strong> &mdash; if this is you, your free trial has ended. Reactivate below to switch your Trey Tappy Stand back on.</p>
      ${payButton}
      <p style="color:#94a3b8;font-size:12px;margin-top:26px;">Trey &bull; Reputation on Autopilot</p>
    </div>
  </div>
</body></html>`,
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { locationId, googleUrl, preview } = params;

  // No location on the tag = misconfigured stand. Show a gentle notice rather
  // than bouncing the customer to a broken Google URL.
  if (!locationId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invalid link</title></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:80px 24px;color:#64748b;">This tap link isn't set up correctly. Please let the business know.</body></html>`,
    };
  }

  const clientsStore = blobsStore("clients");
  const client = await clientsStore.get(locationId, { type: "json" });

  // Preview mode lets an owner/admin see the pause page without pausing anything.
  if (preview === "paused") {
    return pausedPage(client, locationId);
  }

  // Enforce the trial / subscription gate.
  if (isPaused(client)) {
    return pausedPage(client, locationId);
  }

  // Active (or grandfathered / unknown) -> log the tap and count it, then send
  // the customer on to Google.
  try {
    const tapsStore = blobsStore("taps");
    await tapsStore.setJSON(locationId, {
      timestamp: new Date().toISOString(),
      processed: false,
    });

    // Tap tallies for reporting: one per month, plus an all-time total since sign-up.
    const tallyStore = blobsStore("taptally");
    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
    const tallyKey = `${locationId}:${monthKey}`;
    const tally = (await tallyStore.get(tallyKey, { type: "json" })) || { taps: 0 };
    tally.taps += 1;
    await tallyStore.setJSON(tallyKey, tally);

    const totalKey = `${locationId}:total`;
    const total = (await tallyStore.get(totalKey, { type: "json" })) || { taps: 0 };
    total.taps += 1;
    await tallyStore.setJSON(totalKey, total);

    // Weekly bucket (Mon-Sun) for the weekly report.
    const weekTallyKey = `${locationId}:week:${weekKey(new Date())}`;
    const weekTally = (await tallyStore.get(weekTallyKey, { type: "json" })) || { taps: 0 };
    weekTally.taps += 1;
    await tallyStore.setJSON(weekTallyKey, weekTally);
  } catch (err) {
    console.error("Tap logging error:", err);
  }

  const target = safeReviewTarget(googleUrl, client, locationId);

  return thankYouPage(client, target);
};
