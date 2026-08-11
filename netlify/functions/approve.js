const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

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

// A gentle "days of free trial left + Subscribe" banner. Shows only while the
// client is on trial (or lapsed); nothing once subscribed. Needs STRIPE_PAYMENT_LINK.
function trialBanner(client, locationId) {
  if (!client) return "";
  const status = client.subscriptionStatus;
  if (status === "active") return "";
  const TRIAL_DAYS = 14;
  let daysLeft = null;
  if (client.createdAt) {
    const ends = new Date(client.createdAt).getTime() + TRIAL_DAYS * 86400000;
    if (!isNaN(ends)) daysLeft = Math.ceil((ends - Date.now()) / 86400000);
  }
  const onTrial = status === "trial";
  const ended = status === "paused" || status === "cancelled" || (onTrial && daysLeft !== null && daysLeft <= 0);
  if (!onTrial && !ended) return "";
  const payBase = process.env.STRIPE_PAYMENT_LINK || "";
  const payUrl = payBase ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(locationId || "") : "";
  const link = (t) => (payUrl ? `<a href="${escapeHtml(payUrl)}" style="color:#4f46e5;font-weight:800;text-decoration:underline;white-space:nowrap">${t}</a>` : `<strong>${t}</strong>`);
  let msg;
  if (ended) {
    msg = `Your free trial has ended — ${link("resubscribe")} to switch Trey back on.`;
  } else if (daysLeft !== null && daysLeft <= 3) {
    msg = `Just ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left of your free trial — ${link("keep Trey going")} whenever you're ready.`;
  } else if (daysLeft !== null) {
    msg = `${daysLeft} days left of your free trial. Enjoying Trey? ${link("Set up your subscription")}.`;
  } else {
    msg = `You're on your free trial — ${link("set up your subscription")} whenever you're ready.`;
  }
  return `<div style="background:#fff1f2;border-bottom:1px solid #fecdd3;color:#9f1239;font-size:13px;line-height:1.45;text-align:center;padding:10px 14px">${msg}</div>`;
}

function page(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trey \u2014 Approve Reply</title></head><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#e4eefc;">${body}</body></html>`,
  };
}

function errorPage(title, message, statusCode) {
  return {
    statusCode: statusCode || 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
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

// ContentSid for the "✅ done" confirmation. Created — and submitted for
// WhatsApp approval — on first use, then cached in a config blob, so the line
// can be sent business-initiated. Override with TWILIO_CONFIRM_CONTENT_SID.
async function getConfirmContentSid() {
  if (process.env.TWILIO_CONFIRM_CONTENT_SID) return process.env.TWILIO_CONFIRM_CONTENT_SID;
  const cfg = blobsStore("config");
  const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN;
  const authHeader = "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64");
  const NAME = "trey_review_handled_confirmation";

  // Submit an existing template for WhatsApp approval; true only if accepted.
  const submitForApproval = async (contentSid) => {
    try {
      const r = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests/whatsapp`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: NAME, category: "UTILITY" }),
      });
      return r.ok;
    } catch (e) { return false; }
  };

  const cached = await cfg.get("confirmContentSid", { type: "json" });
  if (cached && cached.sid) {
    // Created before but the approval submit hadn't succeeded — retry it, so a
    // one-off 4xx doesn't leave the confirmation permanently undeliverable.
    if (!cached.approvalSubmitted) {
      const ok = await submitForApproval(cached.sid);
      if (ok) await cfg.setJSON("confirmContentSid", { ...cached, approvalSubmitted: true });
    }
    return cached.sid;
  }

  const createResp = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      friendly_name: NAME,
      language: "en",
      variables: { 1: "Reviewer", 2: "Business" },
      types: { "twilio/text": { body: "✅ Sorted — {{1}}'s review for {{2}} is handled. Nothing more to do on that one." } },
    }),
  });
  const cj = await createResp.json().catch(() => ({}));
  if (!createResp.ok || !cj.sid) throw new Error("confirm template create failed: " + JSON.stringify(cj).slice(0, 200));
  const approvalSubmitted = await submitForApproval(cj.sid);
  await cfg.setJSON("confirmContentSid", { sid: cj.sid, approvalSubmitted, createdAt: new Date().toISOString() });
  return cj.sid;
}

// Drop the "✅ done" line into the owner's WhatsApp. Best-effort: never blocks
// the approval, and only actually delivers once the template is WhatsApp-approved.
async function sendHandledConfirmation(pending) {
  try {
    const confirmSid = await getConfirmContentSid();
    if (!confirmSid) return;
    const client = await blobsStore("clients").get(pending.locationId, { type: "json" });
    const digits = client && client.phone ? String(client.phone).replace(/\D/g, "") : "";
    if (!digits) return;
    const tSid = process.env.TWILIO_ACCOUNT_SID, tAuth = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM, msgService = process.env.TWILIO_MESSAGING_SERVICE_SID;
    // Mirror review-webhook's sender selection (From and MessagingService are
    // mutually exclusive) so a Messaging-Service-only setup doesn't send From=undefined.
    const p = msgService
      ? { To: `whatsapp:+${digits}`, MessagingServiceSid: msgService }
      : { To: `whatsapp:+${digits}`, From: from };
    p.ContentSid = confirmSid;
    p.ContentVariables = JSON.stringify({ 1: pending.reviewerName || "the customer", 2: pending.businessName || "your business" });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${tSid}:${tAuth}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(p),
    });
    if (!r.ok) console.error("[approve] confirmation send returned", r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) {
    console.error("[approve] handled-confirmation send failed:", e.message);
  }
}

exports.handler = async (event) => {
  const params =
    event.httpMethod === "POST"
      ? Object.fromEntries(new URLSearchParams(event.body || ""))
      : event.queryStringParameters || {};

  const { reviewId, token, replyText } = params;

  if (!token || token !== process.env.TREY_TAPPY_SECRET_TOKEN) {
    return errorPage("Unauthorized", "Invalid security token. Please try again from WhatsApp.", 403);
  }
  if (!reviewId) {
    return errorPage("Missing review", "No review reference was provided.", 400);
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

      // Drop a "✅ done" line into the owner's WhatsApp so the thread stays a
      // clean, scannable list of what still needs a response. Best-effort.
      await sendHandledConfirmation(pending);

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
      return errorPage("Posting failed", error.message, 500);
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
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <label style="font-size:14px;font-weight:500;color:#334155;">Draft reply</label>
        <textarea name="replyText" rows="7" style="width:100%;box-sizing:border-box;margin-top:6px;border-radius:16px;border:1px solid #e2e8f0;padding:14px;font-size:14px;color:#334155;line-height:1.5;font-family:inherit;">${escapeHtml(pending.replyDraft)}</textarea>
        <button type="submit" style="width:100%;margin-top:20px;background:#4f46e5;color:white;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:700;">\u2713 Approve &amp; post reply</button>
      </form>
    </div>
  `);
};
