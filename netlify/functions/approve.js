const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

// --- Which plan is this client on? -------------------------------------------
//   "founding" -> £25/mo for life (the first 20; index.html advertises it)
//   "standard" -> £35/mo (the default for everyone else)
//   "free"     -> complimentary. Family, friends and test accounts. Never
//                 billed, never nagged to subscribe, never paused.
//
// Centralised because these decisions appear on FIVE separate pages — the inbox,
// the monthly report, the approve page, the profile-check paywall and the paused
// stand. A founding member quoted £25 in one place and £35 in another doesn't
// read that as a bug, they read it as a bait-and-switch; and a comped friend
// being asked to pay is worse.
function planOf(client) {
  const p = String((client && client.plan) || "").toLowerCase();
  if (p === "founding" || p === "free" || p === "standard") return p;
  // Back-compat with the short-lived boolean this replaced.
  if (client && client.foundingMember === true) return "founding";
  return "standard";
}

// A comped account. Treated as permanently subscribed: no payment link, no
// upgrade banner, no paywall, and the stand never pauses.
function isComped(client) {
  return planOf(client) === "free";
}

// If the founding link isn't configured we fall back to standard rather than
// showing nothing — a missing env var must not leave an unpayable page.
function payLinkFor(client) {
  const plan = planOf(client);
  if (plan === "free") return "";   // nothing to sell them
  if (plan === "founding") return process.env.STRIPE_FOUNDING_PAYMENT_LINK || process.env.STRIPE_PAYMENT_LINK || "";
  return process.env.STRIPE_PAYMENT_LINK || "";
}


function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Signed, login-free link back to this client's Inbox (same key model as
// inbox.js / report.js) so the owner can jump back to their review list.
function inboxUrl(locationId) {
  if (!locationId || !process.env.TREY_REPORT_SECRET) return "";
  const k = crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET).update(String(locationId)).digest("hex").slice(0, 32);
  const base = process.env.URL || "https://treyv1.netlify.app";
  return `${base}/.netlify/functions/inbox?loc=${encodeURIComponent(locationId)}&k=${k}`;
}
function backToInbox(locationId) {
  const u = inboxUrl(locationId);
  return u ? `<div style="margin-top:20px;"><a href="${u}" style="color:#4f46e5;font-weight:700;text-decoration:none;font-size:14px;">&larr; Back to your reviews</a></div>` : "";
}

// Source badge — same logos as the Inbox: an indigo Trey squircle for tap-driven
// reviews, the Google "G" for a direct Google review.
function viaGoogle(r) {
  const s = String((r && r.source) || "");
  return /google|direct|organic/i.test(s) && !/trey|tappy|tap\b/i.test(s);
}
function sourceBadge(r) {
  if (viaGoogle(r)) {
    return `<span title="Direct Google review" style="display:inline-flex;width:28px;height:28px;border-radius:8px;background:#fff;border:1px solid #e2e8f0;align-items:center;justify-content:center;flex:0 0 auto;"><svg viewBox="0 0 48 48" width="17" height="17" xmlns="http://www.w3.org/2000/svg" aria-label="Google"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg></span>`;
  }
  return `<span title="Via a Trey tap" style="display:inline-flex;width:28px;height:28px;border-radius:8px;background:#4338ca;align-items:center;justify-content:center;flex:0 0 auto;"><svg viewBox="0 0 100 100" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="Trey"><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.32"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.6"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="#fff"/><rect x="46" y="39" width="8" height="25" rx="2" fill="#fff"/></svg></span>`;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Per-review capability signature. Each approve link carries a signature bound
// to its OWN reviewId — sig = HMAC-SHA256("approve:" + reviewId, TREY_REPORT_SECRET)
// truncated to 128 bits — so a leaked link only works for that one review and
// can't be reused across reviews or tenants. Replaces the old shared global token.
function signReview(reviewId) {
  return crypto
    .createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update("approve:" + String(reviewId))
    .digest("hex")
    .slice(0, 32);
}
function sigValid(reviewId, provided) {
  if (!reviewId || !process.env.TREY_REPORT_SECRET) return false;
  const expected = signReview(reviewId);
  const got = String(provided || "");
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

// A gentle "days of free trial left + Subscribe" banner. Shows only while the
// client is on trial (or lapsed); nothing once subscribed. Needs STRIPE_PAYMENT_LINK.
function trialBanner(client, locationId) {
  if (!client) return "";
  // A comped account has nothing to buy — never show them a Subscribe nag.
  if (isComped(client)) return "";
  const status = client.subscriptionStatus;
  if (status === "active") return "";
  // 14 days normally; 30 for a business that arrived via a referral link.
  const TRIAL_DAYS = (function(){ const n = Number(client && client.trialDays);
    return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 14; })();
  const onTrial = status === "trial";
  // Effective trial start: trialStartedAt (set on the stand's first live tap)
  // or, for legacy clients without the new flag, createdAt.
  let startedMs = null;
  if (client.trialStartedAt) { const t = new Date(client.trialStartedAt).getTime(); if (!isNaN(t)) startedMs = t; }
  else if (!client.trialStartsOnTap && client.createdAt) { const t = new Date(client.createdAt).getTime(); if (!isNaN(t)) startedMs = t; }
  const payBase = payLinkFor(client);
  const payUrl = payBase ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "") : "";
  const bar = (inner) => `<div style="background:#fff1f2;border-bottom:1px solid #fecdd3;color:#9f1239;font-size:13px;line-height:1.45;text-align:center;padding:10px 14px">${inner}</div>`;
  const link = (t) => (payUrl ? `<a href="${escapeHtml(payUrl)}" style="color:#4f46e5;font-weight:800;text-decoration:underline;white-space:nowrap">${t}</a>` : `<strong>${t}</strong>`);
  // On-tap trial that hasn't started yet — waiting on the stand's first tap.
  if (onTrial && startedMs === null) {
    return bar(`Your ${TRIAL_DAYS}-day free trial starts once you activate your Trey stand.`);
  }
  let daysLeft = null;
  if (startedMs !== null) daysLeft = Math.ceil((startedMs + TRIAL_DAYS * 86400000 - Date.now()) / 86400000);
  const ended = status === "paused" || status === "past_due" || status === "cancelled" || status === "canceled" || (onTrial && daysLeft !== null && daysLeft <= 0);
  if (!onTrial && !ended) return "";
  let msg;
  if (ended) {
    msg = `Your Trey stand is paused — ${link("resubscribe")} to switch it back on.`;
  } else if (daysLeft !== null && daysLeft <= 3) {
    msg = `Just ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left of your free trial — ${link("keep Trey going")} whenever you're ready.`;
  } else if (daysLeft !== null) {
    msg = `${daysLeft} days left of your free trial. Enjoying Trey? ${link("Set up your subscription")}.`;
  } else {
    msg = `You're on your free trial — ${link("set up your subscription")} whenever you're ready.`;
  }
  return bar(msg);
}

function page(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trey \u2014 Approve Reply</title></head><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#e4eefc;">${body}</body></html>`,
  };
}

function errorPage(title, message, statusCode) {
  return {
    statusCode: statusCode || 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: page(`
      <div style="max-width:420px;margin:80px auto;text-align:center;padding:0 24px;">
        <div style="font-size:40px;">\u26d4</div>
        <h1 style="color:#ef4444;font-size:20px;margin:12px 0 6px;">${escapeHtml(title)}</h1>
        <p style="color:#64748b;font-size:14px;">${escapeHtml(message)}</p>
      </div>
    `).body,
  };
}

// A clean "already handled" page, shown when an alert is re-opened after the
// owner has already approved or skipped that review.
function donePage(pending) {
  const skipped = pending.status === "skipped";
  const who = escapeHtml(pending.reviewerName || "this customer");
  const title = skipped ? "Already skipped" : "Already responded";
  const msg = skipped
    ? `You skipped ${who}'s review — no reply was posted.`
    : `You've already replied to ${who}'s review. Nothing more to do here.`;
  const replyBlock = (!skipped && pending.finalReply)
    ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:left;font-size:13px;color:#334155;white-space:pre-line;margin-top:16px;">"${escapeHtml(pending.finalReply)}"</div>`
    : "";
  return page(`
    <div style="max-width:420px;margin:0 auto;padding:24px;">
      <div style="background:white;border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.05);margin-top:60px;">
        <div style="background:#dcfce7;width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;"><span style="font-size:32px;">${skipped ? "⏭️" : "✅"}</span></div>
        <h2 style="color:#0f172a;margin:0 0 8px;">${title}</h2>
        <p style="color:#64748b;font-size:14px;margin:0;">${msg}</p>
        ${replyBlock}
        ${backToInbox(pending.locationId)}
        <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Trey • Reputation on Autopilot</p>
      </div>
    </div>
  `);
}

// (The post-approval "✅ Sorted" WhatsApp confirmation was removed on purpose:
// WhatsApp is only the inbound "new review" prompt now, and the Inbox is the
// source of truth for what's already been handled.)

exports.handler = async (event) => {
  const params =
    event.httpMethod === "POST"
      ? Object.fromEntries(new URLSearchParams(event.body || ""))
      : event.queryStringParameters || {};

  // Authorisation is a per-review signature. A link carries either explicit
  // reviewId + sig, or a single combined `r` (sig[32] + reviewId) — the shape
  // the WhatsApp template's one-variable button URL uses.
  let { reviewId, sig, r, replyText } = params;
  if (!reviewId && r) { sig = String(r).slice(0, 32); reviewId = String(r).slice(32); }

  if (!reviewId) {
    return errorPage("Missing review", "No review reference was provided.", 400);
  }
  if (!sigValid(reviewId, sig)) {
    return errorPage("Unauthorized", "This link isn't valid. Please open the most recent link from your WhatsApp.", 403);
  }

  const reviewsStore = blobsStore("reviews");
  const pending = await reviewsStore.get(`pending:${reviewId}`, { type: "json" });

  if (!pending) {
    return errorPage("Not found", "This review link has expired or has already been actioned.", 404);
  }

  // Already approved or skipped? Show a clean "done" page instead of the form,
  // so re-opening an alert never lets you respond twice or wonder if you did.
  if (pending.status === "approved" || pending.status === "skipped") {
    return donePage(pending);
  }

  if (event.httpMethod === "POST") {
    // Live posting to Google is OFF by default. Set TREY_LIVE_POSTING="true" on
    // Netlify once Business Profile API access is confirmed to turn it on.
    const MOCK_MODE = process.env.TREY_LIVE_POSTING !== "true";
    const finalReply = replyText || pending.replyDraft;

    try {
      if (!MOCK_MODE) {
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
            grant_type: "refresh_token",
          }),
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) throw new Error(tokenData.error_description || "Token refresh failed");

        const googleApiUrl = `https://mybusiness.googleapis.com/v4/accounts/${pending.accountId}/locations/${pending.locationId}/reviews/${reviewId}/reply`;
        const replyResponse = await fetch(googleApiUrl, {
          method: "PUT",
          headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ comment: finalReply }),
        });
        if (!replyResponse.ok) {
          const errorData = await replyResponse.json();
          throw new Error(JSON.stringify(errorData));
        }
      }

      const updated = { ...pending, status: "approved", finalReply, approvedAt: new Date().toISOString() };
      await reviewsStore.setJSON(`pending:${reviewId}`, updated);

      // Update the permanent review record so the Inbox reflects the reply.
      // Use the record's OWN stored key (pending.recordKey) — recomputing it
      // from createdAt's month can point at the wrong month and miss the record,
      // which left approved reviews stuck in the Inbox's "waiting" list.
      const recordKey = pending.recordKey
        || `review:${pending.locationId}:${(pending.createdAt || new Date().toISOString()).slice(0, 7)}:${reviewId}`;
      const existingRecord = await reviewsStore.get(recordKey, { type: "json" });
      await reviewsStore.setJSON(recordKey, { ...(existingRecord || pending), finalReply, status: "approved" });

      // No WhatsApp message after approval — WhatsApp is only the inbound
      // "new review" prompt; the Inbox reflects what's already been handled.

      const okTitle = MOCK_MODE ? "Reply approved" : "Reply posted";
      const okMsg = MOCK_MODE
        ? `Your reply is approved and saved — it'll post to Google for ${escapeHtml(pending.businessName)} as soon as live posting is switched on.`
        : `Your reply is now live on ${escapeHtml(pending.businessName)}'s Google Business Profile.`;

      return page(`
        <div style="max-width:420px;margin:0 auto;padding:24px;">
          <div style="background:white;border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.05);margin-top:60px;">
            <div style="background:#dcfce7;width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
              <span style="font-size:32px;">\u2705</span>
            </div>
            <h2 style="color:#0f172a;margin:0 0 8px;">${okTitle}</h2>
            <p style="color:#64748b;font-size:14px;margin-bottom:20px;">${okMsg}</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:left;font-size:13px;color:#334155;white-space:pre-line;">"${escapeHtml(finalReply)}"</div>
            ${backToInbox(pending.locationId)}
            <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Trey \u2022 Reputation on Autopilot</p>
          </div>
        </div>
      `);
    } catch (error) {
      console.error("Approve error:", error.message);
      return errorPage("Posting failed", "Something went wrong posting your reply. Please try again in a moment.", 500);
    }
  }

  // GET — render the approve form.
  const bannerClient = await blobsStore("clients").get(pending.locationId, { type: "json" });
  const ratingNum = Number(pending.rating) || 0;
  const stars = "\u2b50".repeat(Math.max(0, Math.min(5, Math.round(ratingNum))));

  return page(`
    ${trialBanner(bannerClient, pending.locationId)}
    <div style="max-width:420px;margin:0 auto;padding:20px 20px 40px;">
      <div style="display:flex;align-items:center;gap:9px;padding:12px 0 20px;">
        <svg viewBox="0 0 100 100" width="30" height="30" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Trey"><rect width="100" height="100" rx="24" fill="#4338ca"/><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.32"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.6"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="#fff"/><rect x="46" y="39" width="8" height="25" rx="2" fill="#fff"/></svg>
        <span style="font-weight:800;color:#0f172a;font-size:17px;letter-spacing:-.3px;">trey</span>
      </div>
      <h1 style="font-size:18px;color:#0f172a;margin:0 0 4px;">New review \u2014 ${escapeHtml(pending.businessName)}</h1>
      <p style="font-size:14px;color:#64748b;margin:0 0 20px;">Review the reply below, then approve to post it to Google.</p>

      <div style="background:white;border:1px solid #f1f5f9;border-radius:16px;padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:500;color:#0f172a;font-size:14px;">${escapeHtml(pending.reviewerName)}</div>
            <div style="font-size:13px;">${stars}</div>
          </div>
          ${sourceBadge(pending)}
        </div>
        <p style="font-size:14px;color:#475569;margin-top:12px;line-height:1.5;">"${escapeHtml(pending.comment)}"</p>
      </div>

      <form method="POST" action="">
        <input type="hidden" name="reviewId" value="${escapeHtml(reviewId)}" />
        <input type="hidden" name="sig" value="${escapeHtml(sig)}" />
        <label style="font-size:14px;font-weight:500;color:#334155;">Draft reply</label>
        <textarea name="replyText" rows="7" style="width:100%;box-sizing:border-box;margin-top:6px;border-radius:16px;border:1px solid #e2e8f0;padding:14px;font-size:14px;color:#334155;line-height:1.5;font-family:inherit;">${escapeHtml(pending.replyDraft)}</textarea>
        <button type="submit" style="width:100%;margin-top:20px;background:#4f46e5;color:white;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:700;">\u2713 Approve &amp; post reply</button>
      </form>
    </div>
  `);
};
