const { getStore } = require("@netlify/blobs");

// NFC/QR "Tappy Stand" landing endpoint.
//
//  - Logs the tap so review-webhook.js can attribute a review to it.
//  - Counts taps per month for reporting ("6 taps -> 4 completed reviews").
//  - Enforces the free-trial pause promised in the Terms (14 days, or 30 if
//    the business arrived through a referral link): once a
//    client's trial has ended and they haven't subscribed, the stand shows an
//    "unavailable" page (with a billing link) instead of the Google review page.
//  - Active clients are redirected straight to Google to leave a review.
//
// Clients with no subscriptionStatus are treated as active ("grandfathered"),
// so stands that were live before this feature shipped never pause by surprise.

// How long is this client's free trial? Normally 14 days; a business that came
// in through a referral link gets 30 (set by signup.js). Anything odd falls back
// to 14 so a bad value can never hand out an unlimited trial.
function trialDaysFor(client) {
  const n = Number(client && client.trialDays);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 14;
}

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

// When did the trial actually start (ms since epoch), or null if it hasn't yet.
// New model: the trial starts when the business OWNER activates the stand (the
// button on the activation page below), stamped as trialStartedAt. Clients
// flagged trialStartsOnTap follow this model; older clients without the flag fall
// back to createdAt so stands live before this feature keep their clock.
function trialStartMs(client) {
  if (!client) return null;
  if (client.trialStartedAt) {
    const t = new Date(client.trialStartedAt).getTime();
    if (!isNaN(t)) return t;
  }
  if (client.trialStartsOnTap) return null; // new model — not started until activated
  if (client.createdAt) {
    const t = new Date(client.createdAt).getTime();
    if (!isNaN(t)) return t;
  }
  return null;
}

// The small indigo Trey mark, inline so these pages stay self-contained.
function treyMarkSvg(size) {
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#4338ca"/><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.32"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.6"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="#fff"/><rect x="46" y="39" width="8" height="25" rx="2" fill="#fff"/></svg>`;
}

// Shown when a "ready to send" stand is tapped before the owner has activated it
// (in the customer's hands, or in transit). Reassures a delivery driver, shows
// who the package is for, and lets the OWNER start their trial. The button POSTs
// (never a GET link) so a scanner/bot pre-fetch cannot trigger activation.
function activationPage(client, locationId) {
  const name = escapeHtml((client && client.businessName) || "your business");
  const logoUrl = client && client.logoUrl ? escapeHtml(client.logoUrl) : "";
  const logoChip = logoUrl ? `<div class="lchip"><img src="${logoUrl}" alt="${name}"></div>` : "";
  const action = `/.netlify/functions/tap?locationId=${encodeURIComponent(locationId)}&activate=1`;
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Activate your Trey stand</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#eef3fc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:22px}
 .wrap{max-width:400px;width:100%}
 .driver{background:#fff;border:1px solid #dbe4f3;border-radius:12px;padding:13px 15px;font-size:13px;color:#475569;line-height:1.5;margin-bottom:16px}
 .driver b{color:#0f172a}
 .recipient{text-align:center;margin:6px 0 22px}
 .lchip{display:inline-block;background:#fff;border:1px solid #dbe4f3;border-radius:14px;padding:14px 20px;box-shadow:0 6px 18px rgba(15,23,42,.06)}
 .lchip img{max-height:64px;max-width:210px;display:block;object-fit:contain}
 .bizname{font-size:20px;font-weight:800;letter-spacing:-.4px;margin-top:12px}
 .card{background:#fff;border:1px solid #cfe0f6;border-radius:18px;padding:22px 20px;text-align:center;box-shadow:0 14px 40px rgba(79,70,229,.12)}
 .card h1{font-size:19px;margin:0 0 8px;letter-spacing:-.3px}
 .card p{font-size:14.5px;color:#475569;line-height:1.55;margin:0 0 18px}
 .btn{display:block;width:100%;background:linear-gradient(180deg,#4f46e5,#4338ca);color:#fff;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 8px 18px rgba(67,56,202,.28)}
 .fine{font-size:12px;color:#94a3b8;margin-top:12px}
 .foot{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:22px;color:#64748b;font-size:12px;font-weight:600}
</style></head><body>
 <div class="wrap">
   <div class="driver">&#128230; <b>Just delivering?</b> You've tapped a small NFC tag inside this package &mdash; nothing's wrong and there's nothing you need to do, you can close this. This package is on its way to the business below.</div>
   <div class="recipient">${logoChip}<div class="bizname">${name}</div></div>
   <div class="card">
     <h1>Is this you, ${name}? &#128075;</h1>
     <p>Your Trey stand is ready. Press the button below to start your <b>${trialDaysFor(client)}-day free trial</b> &mdash; the countdown only begins now, not while it was in the post.</p>
     <form method="POST" action="${action}"><button class="btn" type="submit">Activate my stand &rarr;</button></form>
     <div class="fine">Only press this once your stand is set up and ready for customers.</div>
   </div>
   <div class="foot">${treyMarkSvg(24)} Powered by Trey</div>
 </div>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
}

// Shown right after the owner presses Activate — trial has started, stand is live.
function activatedPage(client, target) {
  const safeTarget = escapeHtml(target);
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your stand is live</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#eef3fc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:22px}
 .card{max-width:400px;width:100%;background:#fff;border:1px solid #cfe0f6;border-radius:18px;padding:26px 22px;text-align:center;box-shadow:0 14px 40px rgba(79,70,229,.12)}
 .tick{width:56px;height:56px;border-radius:50%;background:#ecfdf5;color:#059669;display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 14px}
 h1{font-size:21px;margin:0 0 8px;letter-spacing:-.3px}
 p{font-size:14.5px;color:#475569;line-height:1.55;margin:0 0 18px}
 a.preview{color:#4338ca;font-size:13px;text-decoration:none;font-weight:600}
 .foot{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:22px;color:#64748b;font-size:12px;font-weight:600}
</style></head><body>
 <div style="max-width:400px;width:100%">
   <div class="card">
     <div class="tick">&#10003;</div>
     <h1>You're live!</h1>
     <p>Your ${trialDaysFor(client)}-day free trial has started. From now on, anyone who taps your stand goes straight to your Google review page.</p>
     <a class="preview" href="${safeTarget}">Preview your review page &rarr;</a>
   </div>
   <div class="foot">${treyMarkSvg(24)} Powered by Trey</div>
 </div>
</body></html>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
}

// Should the stand be paused for this client (trial over, not subscribed)?
function isPaused(client) {
  if (!client) return false;
  const status = client.subscriptionStatus;
  if (status === "active") return false;
  if (status === "paused" || status === "past_due" || status === "cancelled" || status === "canceled" || status === "expired") return true;
  if (status === "trial") {
    const started = trialStartMs(client);
    if (started === null) return false; // trial hasn't started yet -> stand still works (test)
    return Date.now() > started + trialDaysFor(client) * 24 * 60 * 60 * 1000;
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

// Why is the stand deactivated? Drives which message the pause page shows.
//   "payment"     — a subscription payment failed (status paused / past_due)
//   "cancelled"   — the subscription was cancelled
//   "trial_ended" — the free trial (14 days, or 30 if referred) elapsed without subscribing
function pauseReason(client) {
  if (!client) return null;
  const s = client.subscriptionStatus;
  if (s === "paused" || s === "past_due") return "payment";
  if (s === "cancelled" || s === "canceled" || s === "expired") return "cancelled";
  if (s === "trial") {
    const started = trialStartMs(client);
    if (started !== null && Date.now() > started + trialDaysFor(client) * 24 * 60 * 60 * 1000) return "trial_ended";
  }
  return null;
}

function pausedPage(client, locationId, reasonOverride) {
  const name = escapeHtml(displayName(client));
  const reason = reasonOverride || pauseReason(client) || "trial_ended";
  const isPayment = reason === "payment";
  const isCancelled = reason === "cancelled";
  const payBase = process.env.STRIPE_PAYMENT_LINK || "";
  const payUrl = payBase
    ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "")
    : "";

  const heading = isPayment ? "This review link is temporarily unavailable" : "This review link is currently unavailable";
  let ownerMsg, btnLabel;
  if (isPayment) {
    ownerMsg = `<strong>${name}</strong> &mdash; there's a problem with your payment details, so your Trey stand is temporarily disconnected. Update your payment to reconnect it right away.`;
    btnLabel = "Update payment details";
  } else if (isCancelled) {
    ownerMsg = `<strong>${name}</strong> &mdash; your Trey subscription has been cancelled, so your stand is switched off. Resubscribe whenever you'd like it back on.`;
    btnLabel = "Resubscribe";
  } else {
    ownerMsg = `<strong>${name}</strong> &mdash; your ${trialDaysFor(client)}-day free trial has ended. Subscribe to switch your Trey stand back on and keep every review answered.`;
    btnLabel = "Subscribe via Stripe";
  }
  const payButton = payUrl
    ? `<a href="${escapeHtml(payUrl)}" style="display:inline-block;margin-top:20px;background:linear-gradient(180deg,#4f46e5,#4338ca);color:#fff;text-decoration:none;border-radius:12px;padding:15px 28px;font-size:16px;font-weight:700;box-shadow:0 8px 18px rgba(67,56,202,.28);">${btnLabel} &rarr;</a>`
    : `<p style="color:#94a3b8;font-size:13px;margin-top:20px;">Billing link coming soon &mdash; please contact us to reactivate.</p>`;
  const support = `<p style="color:#94a3b8;font-size:12.5px;margin-top:18px;">${isPayment ? "Payment already sorted, or think this is a mistake? " : "Questions? "}Contact us at <a href="mailto:info@trey.today" style="color:#4338ca;">info@trey.today</a></p>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Review link unavailable</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#eef3fc;">
  <div style="max-width:440px;margin:0 auto;padding:24px;">
    <div style="background:#fff;border:1px solid #cfe0f6;border-radius:18px;padding:34px 26px;text-align:center;box-shadow:0 14px 40px rgba(79,70,229,.12);margin-top:60px;">
      <div style="font-size:40px;">&#9203;</div>
      <h1 style="color:#0f172a;font-size:20px;margin:12px 0 8px;">${heading}</h1>
      <p style="color:#64748b;font-size:15px;line-height:1.5;margin:0;">If you were about to leave a review, thank you &mdash; please let <strong>${name}</strong> know their Trey stand needs reactivating.</p>
      <hr style="border:none;border-top:1px solid #eef2f7;margin:22px 0;">
      <p style="color:#475569;font-size:14px;line-height:1.55;margin:0;">${ownerMsg}</p>
      ${payButton}
      ${support}
      <p style="color:#94a3b8;font-size:12px;margin-top:22px;">Trey &bull; Reputation on Autopilot</p>
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

  // Unknown location = no such client. Show the gentle notice instead of counting
  // bogus taps or redirecting to a broken Google URL.
  if (!client) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not found</title></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding:80px 24px;color:#64748b;">This tap link isn't set up correctly. Please let the business know.</body></html>`,
    };
  }

  // Preview mode lets an owner/admin see a deactivated page without changing
  // anything. ?preview=paused|trial_ended -> trial-ended message; ?preview=payment
  // -> payment-problem message.
  if (preview === "paused" || preview === "trial_ended") return pausedPage(client, locationId, "trial_ended");
  if (preview === "payment") return pausedPage(client, locationId, "payment");

  // Enforce the trial / subscription gate.
  if (isPaused(client)) {
    return pausedPage(client, locationId);
  }

  const status = client && client.subscriptionStatus;
  // A trial stand whose owner hasn't activated it yet.
  const notStarted = status === "trial" && trialStartMs(client) === null;

  // OWNER ACTIVATION. The activation page's button POSTs here (POST only, so a
  // link-preview bot or NFC scanner pre-fetch — always a GET — can never trigger
  // it). The first activation stamps the trial start and switches the stand live.
  if (event.httpMethod === "POST" && params.activate === "1") {
    if (notStarted && client) {
      try {
        await clientsStore.setJSON(locationId, { ...client, trialStartedAt: new Date().toISOString() });
      } catch (e) {
        console.error("Activation write failed:", e);
        // Don't tell the owner they're live when the write failed — ask them to retry.
        return {
          statusCode: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Try again</title></head><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#eef3fc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;text-align:center;"><div style="max-width:400px;"><div style="font-size:38px;">&#9888;&#65039;</div><h1 style="font-size:20px;margin:10px 0 8px;">That didn't go through</h1><p style="color:#475569;font-size:15px;line-height:1.55;">We couldn't switch your stand on just then &mdash; please tap Activate again in a moment. If it keeps happening, email <a href="mailto:info@trey.today" style="color:#4338ca;">info@trey.today</a>.</p></div></body></html>`,
        };
      }
      return activatedPage(client, safeReviewTarget(googleUrl, client, locationId));
    }
    // Already live / not a trial -> just send them onward.
    return { statusCode: 303, headers: { Location: safeReviewTarget(googleUrl, client, locationId), "Cache-Control": "no-store" }, body: "" };
  }

  // "Ready to send" stand, not yet activated -> show the activation page (driver
  // notice + the owner's Activate button) instead of redirecting to Google.
  if (notStarted && client && client.standMode === "ship") {
    return activationPage(client, locationId);
  }

  // Otherwise: an admin "Test" stand (redirect to Google so it can be checked,
  // but don't count), or a live/active/grandfathered stand (redirect AND count).
  if (!notStarted) {
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
  }

  const target = safeReviewTarget(googleUrl, client, locationId);

  // Active clients: redirect STRAIGHT to Google — no interstitial. The tap is
  // already logged above, so attribution is unaffected. The old 1.6s thank-you
  // page was unreadable and only cost drop-off between tap and review form.
  // (The pause/notice pages above are kept — the message only matters when the
  // subscription isn't paid.)
  return {
    statusCode: 302,
    headers: { Location: target, "Cache-Control": "no-store" },
    body: "",
  };
};
