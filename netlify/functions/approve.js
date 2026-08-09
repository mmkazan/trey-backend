const { getStore } = require("@netlify/blobs");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trey \u2014 Approve Reply</title></head><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;">${body}</body></html>`,
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
  const cached = await cfg.get("confirmContentSid", { type: "json" });
  if (cached && cached.sid) return cached.sid;

  const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN;
  const authHeader = "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64");
  const createResp = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      friendly_name: "trey_review_handled_confirmation",
      language: "en",
      variables: { 1: "Reviewer", 2: "Business" },
      types: { "twilio/text": { body: "✅ Sorted — {{1}}'s review for {{2}} is handled. Nothing more to do on that one." } },
    }),
  });
  const cj = await createResp.json().catch(() => ({}));
  if (!createResp.ok || !cj.sid) throw new Error("confirm template create failed: " + JSON.stringify(cj).slice(0, 200));
  // Submit for WhatsApp approval (best-effort; utility category).
  try {
    await fetch(`https://content.twilio.com/v1/Content/${cj.sid}/ApprovalRequests/whatsapp`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "trey_review_handled_confirmation", category: "UTILITY" }),
    });
  } catch (e) { /* approval submit is best-effort */ }
  await cfg.setJSON("confirmContentSid", { sid: cj.sid, createdAt: new Date().toISOString() });
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
    const tSid = process.env.TWILIO_ACCOUNT_SID, tAuth = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_WHATSAPP_FROM;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${tSid}:${tAuth}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: `whatsapp:+${digits}`,
        From: from,
        ContentSid: confirmSid,
        ContentVariables: JSON.stringify({ 1: pending.reviewerName || "the customer", 2: pending.businessName || "your business" }),
      }),
    });
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
    const MOCK_MODE = true; // Set to false once Google Business Profile API access is approved.
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

      const monthKey = (pending.createdAt || new Date().toISOString()).slice(0, 7);
      const recordKey = `review:${pending.locationId}:${monthKey}:${reviewId}`;
      const existingRecord = await reviewsStore.get(recordKey, { type: "json" });
      if (existingRecord) {
        await reviewsStore.setJSON(recordKey, { ...existingRecord, finalReply, status: "approved" });
      }

      // Drop a "✅ done" line into the owner's WhatsApp so the thread stays a
      // clean, scannable list of what still needs a response. Best-effort.
      await sendHandledConfirmation(pending);

      return page(`
        <div style="max-width:420px;margin:0 auto;padding:24px;">
          <div style="background:white;border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.05);margin-top:60px;">
            <div style="background:#dcfce7;width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
              <span style="font-size:32px;">\u2705</span>
            </div>
            <h2 style="color:#0f172a;margin:0 0 8px;">Reply posted</h2>
            <p style="color:#64748b;font-size:14px;margin-bottom:20px;">Your reply is now live on ${escapeHtml(pending.businessName)}'s Google Business Profile.</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:left;font-size:13px;color:#334155;white-space:pre-line;">"${escapeHtml(finalReply)}"</div>
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
  const ratingNum = Number(pending.rating) || 0;
  const stars = "\u2b50".repeat(Math.max(0, Math.min(5, Math.round(ratingNum))));

  return page(`
    <div style="max-width:420px;margin:0 auto;padding:20px 20px 40px;">
      <div style="display:flex;align-items:center;gap:8px;padding:12px 0 20px;">
        <div style="width:28px;height:28px;border-radius:8px;background:#059669;display:flex;align-items:center;justify-content:center;color:white;font-size:14px;">\u2728</div>
        <span style="font-weight:600;color:#0f172a;">Trey</span>
      </div>
      <h1 style="font-size:18px;color:#0f172a;margin:0 0 4px;">New review \u2014 ${escapeHtml(pending.businessName)}</h1>
      <p style="font-size:14px;color:#64748b;margin:0 0 20px;">Review the reply below, then approve to post it to Google.</p>

      <div style="background:white;border:1px solid #f1f5f9;border-radius:16px;padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:500;color:#0f172a;font-size:14px;">${escapeHtml(pending.reviewerName)}</div>
            <div style="font-size:13px;">${stars}</div>
          </div>
          <span style="font-size:11px;font-weight:500;background:#ecfdf5;color:#047857;padding:4px 8px;border-radius:999px;white-space:nowrap;">${escapeHtml(pending.source || "")}</span>
        </div>
        <p style="font-size:14px;color:#475569;margin-top:12px;line-height:1.5;">"${escapeHtml(pending.comment)}"</p>
      </div>

      <form method="POST" action="">
        <input type="hidden" name="reviewId" value="${escapeHtml(reviewId)}" />
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <label style="font-size:14px;font-weight:500;color:#334155;">Draft reply</label>
        <textarea name="replyText" rows="7" style="width:100%;box-sizing:border-box;margin-top:6px;border-radius:16px;border:1px solid #e2e8f0;padding:14px;font-size:14px;color:#334155;line-height:1.5;font-family:inherit;">${escapeHtml(pending.replyDraft)}</textarea>
        <button type="submit" style="width:100%;margin-top:20px;background:#059669;color:white;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:600;">\u2713 Approve & post reply</button>
      </form>
    </div>
  `);
};
