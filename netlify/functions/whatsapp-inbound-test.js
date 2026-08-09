// Inbound WhatsApp handler — TEST VERSION (kept separate from the live
// whatsapp-inbound.js so it can be trialled without touching production).
//
// To trial: point the Trey WhatsApp sender's "A message comes in" webhook at
//   /.netlify/functions/whatsapp-inbound-test
// while testing. It's a superset of the live handler — ordinary messages still
// get the normal support reply — so nothing breaks while the webhook points
// here. Switch it back (or fold this into whatsapp-inbound.js) once happy.
//
// Twilio calls this whenever someone messages the Trey number. It handles two
// things:
//   1. Approval button taps (Approve / Edit / Skip) from a review-alert message
//      — the owner responds INSIDE WhatsApp, no web page.
//   2. Any other message — a short "this number isn't monitored" support reply.
//
// Replies are normal freeform messages, allowed because the person's inbound
// message opens a 24-hour session window (no template/approval needed).

const { getStore } = require("@netlify/blobs");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

const SUPPORT =
  "Thanks for messaging Trey. This number sends your review-approval alerts. " +
  "For any help, call or message +44 7941 052034 or email mmkazan@gmail.com and we'll get straight back to you.";

function twiml(message) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + message + "</Message></Response>",
  };
}

exports.handler = async (event) => {
  const params = new URLSearchParams(event && event.body ? event.body : "");
  const from = params.get("From") || "";                    // e.g. "whatsapp:+4479..."
  const phone = from.replace(/^whatsapp:/i, "").trim();
  const buttonText = (params.get("ButtonText") || "").trim();
  const body = (params.get("Body") || "").trim();
  const signal = (buttonText || body).toLowerCase();        // button tap OR typed text

  const pendingStore = blobsStore("approvalpending");       // phone -> { reviewId, awaitingEdit }
  const reviewsStore = blobsStore("reviews");
  const pending = phone ? await pendingStore.get(phone, { type: "json" }) : null;

  // If we asked the owner to type an edited reply, treat this message as it.
  if (pending && pending.awaitingEdit && body && !buttonText) {
    await saveApproval(reviewsStore, pending.reviewId, body);
    await pendingStore.setJSON(phone, { ...pending, awaitingEdit: false, status: "approved" });
    return twiml("✅ Thanks — I'll post that wording. You can change it any time.");
  }

  const isApprove = /approve/.test(signal);
  const isEdit = /\bedit\b/.test(signal);
  const isSkip = /skip/.test(signal);

  if (isApprove || isEdit || isSkip) {
    if (!pending) {
      // No live review to act on (e.g. a test tap) — acknowledge so the
      // round-trip is visible on the phone.
      return twiml(
        isApprove ? "✅ Approve received (nothing pending right now)."
          : isSkip ? "⏭️ Skip received."
            : "✏️ Edit received."
      );
    }
    if (isApprove) {
      await saveApproval(reviewsStore, pending.reviewId, null); // use the draft as-is
      await pendingStore.setJSON(phone, { ...pending, status: "approved" });
      return twiml("✅ Approved — your reply is being posted. Nice one.");
    }
    if (isSkip) {
      await pendingStore.setJSON(phone, { ...pending, status: "skipped" });
      return twiml("⏭️ Skipped — no reply will be posted for that review.");
    }
    // Edit
    await pendingStore.setJSON(phone, { ...pending, awaitingEdit: true });
    return twiml("✏️ Sure — reply to this message with the wording you'd like and I'll post that instead.");
  }

  return twiml(SUPPORT);
};

// Mark the pending review approved with a final reply (draft or edited version).
// Actual posting to Google is handled by the existing approve flow (MOCK_MODE for
// now); here we record the decision made in WhatsApp.
async function saveApproval(reviewsStore, reviewId, editedReply) {
  if (!reviewId) return;
  try {
    const rec = await reviewsStore.get(`pending:${reviewId}`, { type: "json" });
    if (!rec) return;
    const finalReply = editedReply || rec.replyDraft;
    await reviewsStore.setJSON(`pending:${reviewId}`, {
      ...rec, status: "approved", finalReply, approvedAt: new Date().toISOString(), approvedVia: "whatsapp",
    });
    if (rec.recordKey) {
      const perm = await reviewsStore.get(rec.recordKey, { type: "json" });
      if (perm) await reviewsStore.setJSON(rec.recordKey, { ...perm, status: "approved", finalReply });
    }
  } catch (e) {
    console.error("[whatsapp-inbound] saveApproval failed:", e.message);
  }
}
