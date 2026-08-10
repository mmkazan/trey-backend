// TEST HELPER (admin-gated) — seeds a complete demo client so the Inbox and
// report have real content to show. Creates: a trial client (Mik's Cars),
// tap/review tallies, a month-over-month rating climb, and 4 reviews (2 waiting,
// 2 replied). Returns the signed Inbox + report links. Delete when done.
//
//   GET /.netlify/functions/seed-demo?token=ADMIN_TOKEN[&loc=trey-demo]

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}
function reportKey(loc) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "").update(String(loc)).digest("hex").slice(0, 32);
}
function adminOk(event, params) {
  const h = event.headers || {};
  const provided = (h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim() || (params && params.token) || "";
  const expected = process.env.CLIENT_ADMIN_TOKEN || "";
  if (!provided || !expected || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
function lastCompleteMonth(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCDate(0);
  return d.toISOString().slice(0, 7);
}
function prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCDate(0);
  return d.toISOString().slice(0, 7);
}
function weekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  if (!adminOk(event, params)) return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  if (!process.env.TREY_REPORT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: "TREY_REPORT_SECRET not set (redeploy after setting it)" }) };

  const loc = params.loc || "trey-demo";
  const now = new Date();
  const month = lastCompleteMonth(now);
  const prev = prevMonth(month);
  const dayMs = 86400000;

  // Trial client, created 5 days ago → ~9 days left (so the banner shows).
  await blobsStore("clients").setJSON(loc, {
    locationId: loc, businessName: "Mik's Cars", businessType: "MOT & servicing",
    phone: "+447900000000", email: "demo@treyapp.co", subscriptionStatus: "trial",
    createdAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
    voicePerspective: "Individual", publicSignOffName: "Mik", placeId: "ChIJdemo123",
    contactFirstName: "Michael", contactSurname: "Kazan",
    companyAddress: "12 High Street, Cobham, Surrey, KT11 1AA",
    brandVoice: "We're a family-run MOT garage in Cobham — friendly, straight-talking, and genuinely grateful for every customer.",
    initialGoogleRating: 4.5, initialReviewCount: 80, googleRating: 4.7, reviewCount: 118, demo: true,
  });

  // Rating climb for the report hero.
  await blobsStore("ratinghistory").setJSON(`${loc}:${month}`, { rating: 4.7, source: "demo" });
  await blobsStore("ratinghistory").setJSON(`${loc}:${prev}`, { rating: 4.5, source: "demo" });

  // Tap + review tallies / stats.
  await blobsStore("taptally").setJSON(`${loc}:${month}`, { taps: 18 });
  await blobsStore("taptally").setJSON(`${loc}:total`, { taps: 52 });
  await blobsStore("taptally").setJSON(`${loc}:week:${weekKey(now)}`, { taps: 6 });
  await blobsStore("reviewtally").setJSON(`${loc}:${month}`, { tapReviews: 5, organicReviews: 2 });
  await blobsStore("stats").setJSON(loc, { tapReviews: 22, organicReviews: 9 });

  // Reviews: 3 waiting (incl. a low-star, no-comment "urgent" one) + 2 replied
  // (one a direct Google review) — so the demo shows every card state: the red
  // Urgent pill, the "Rating only — no comment left" state, amber Needs-reply,
  // green Replied, and both source badges (Trey squircle + Google "G").
  const TREY = "Trey Tappy Stand 🎴";
  const GOOGLE = "Organic Review"; // triggers the Google "G" source badge
  const reviewsStore = blobsStore("reviews");
  const reviews = [
    { id: "demo-0", name: "Dave R", rating: 2, comment: "", status: "pending", source: TREY, reply: "Hi Dave, I'm sorry we fell short — that's not the standard we hold ourselves to. I'd really like to put it right; please give us a call so we can help. — Mik" },
    { id: "demo-1", name: "Sarah J", rating: 5, comment: "Brilliant service, car was ready early!", status: "pending", source: TREY, reply: "Hi Sarah, thanks so much — really glad we got you sorted quickly. See you next time! — Mik" },
    { id: "demo-2", name: "Tom H", rating: 4, comment: "Great value and a quick turnaround.", status: "pending", source: TREY, reply: "Thanks Tom — appreciate you taking the time, and glad it was a quick one. — Mik" },
    { id: "demo-3", name: "Priya K", rating: 5, comment: "Lovely team, really helpful and honest.", status: "approved", source: TREY, reply: "Thank you Priya! Being honest with folks matters to us — see you again soon. — Mik" },
    { id: "demo-4", name: "James O", rating: 5, comment: "Fair price and did exactly what they said.", status: "approved", source: GOOGLE, reply: "Cheers James — that's exactly how we like to work. Thanks for the review! — Mik" },
  ];
  let i = 0;
  for (const r of reviews) {
    const rec = {
      reviewId: r.id, locationId: loc, businessName: "Mik's Cars", reviewerName: r.name,
      rating: r.rating, comment: r.comment, source: r.source || TREY, status: r.status,
      replyDraft: r.reply, recordKey: `review:${loc}:${month}:${r.id}`,
      createdAt: new Date(now.getTime() - (i + 1) * dayMs).toISOString(), demo: true,
    };
    if (r.status === "approved") rec.finalReply = r.reply;
    await reviewsStore.setJSON(rec.recordKey, rec);
    if (r.status === "pending") await reviewsStore.setJSON(`pending:${r.id}`, rec);
    i++;
  }

  const base = process.env.URL || "https://treyv1.netlify.app";
  const k = reportKey(loc);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seeded: loc,
      inboxUrl: `${base}/.netlify/functions/inbox?loc=${encodeURIComponent(loc)}&k=${k}`,
      reportUrl: `${base}/.netlify/functions/report?loc=${encodeURIComponent(loc)}&m=${month}&k=${k}`,
    }),
  };
};
