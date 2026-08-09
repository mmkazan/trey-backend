const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

// Enhanced Monthly Report — the "read more" page the monthly WhatsApp links to.
//
// Server-renders a full, self-contained, mobile-first HTML page showing one
// client's month with Trey: their Google rating climb, taps + new reviews this
// month, Trey's share of those reviews, the journey since they joined, and an
// optional glowing-review highlight. Personalised with the client's own logo.
// Same "one request in, finished HTML out" pattern as tap.js's pause page, so
// it loads instantly when tapped from WhatsApp.
//
//   GET /.netlify/functions/report?loc=<locationId>&m=<YYYY-MM>&k=<key>
//        -> the rendered report page
//        m is optional -> defaults to the last COMPLETE calendar month.
//
//   GET /.netlify/functions/report?loc=<locationId>&gen=1&token=<ADMIN_TOKEN>[&m=YYYY-MM]
//        -> JSON { loc, month, key, url } — generates the signed link to send.
//           Guarded by CLIENT_ADMIN_TOKEN (same token used across the backend),
//           so keys are minted with the real secret that lives on Netlify.
//
// The link must not be guessable (a competitor shouldn't be able to swap in
// another locationId and read its stats), so every link carries a per-client
// key k = HMAC-SHA256(locationId, TREY_REPORT_SECRET) truncated, verified here.
//
// Env: TREY_REPORT_SECRET (new), CLIENT_ADMIN_TOKEN, and the usual
//      NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN used by the other functions.

// Trey brand.
const GREEN = "#059669";
const SLATE = "#0f172a";

// The Trey WhatsApp avatar mark (docs/trey_whatsapp_avatar.png), downscaled to
// 64px and inlined as a data URI so it needs no external fetch. Used as the
// little badge on the "brought you … reviews" line.
const TREY_MARK = "data:image/png;base64,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";

// Truncated HMAC length (hex chars). 32 hex = 128 bits — non-guessable, still
// short enough to sit comfortably in a WhatsApp URL.
const KEY_LEN = 32;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Per-client link key. Deterministic, so the monthly send and this function
// derive the same value from the same secret.
function reportKey(locationId) {
  return crypto
    .createHmac("sha256", process.env.TREY_REPORT_SECRET || "")
    .update(String(locationId))
    .digest("hex")
    .slice(0, KEY_LEN);
}

// Constant-time compare so a bad key can't be brute-forced by timing.
function keyValid(locationId, provided) {
  const expected = reportKey(locationId);
  const got = String(provided || "");
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// YYYY-MM of the last COMPLETE calendar month (the default when m is omitted).
function lastCompleteMonth(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCDate(0); // -> last day of previous month
  return d.toISOString().slice(0, 7);
}

// "2026-07" -> "2026-06" (the calendar month before ym).
function prevMonthKey(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return ym;
  const d = new Date(Date.UTC(y, m - 1, 1)); // first day of ym
  d.setUTCDate(0); // step back to the last day of the previous month
  return d.toISOString().slice(0, 7);
}

// "2026-07" -> "July 2026".
function monthLabel(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return String(ym);
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${names[m - 1]} ${y}`;
}

// Ratings render as 4, 4.3 etc — never "4.30" or "4.0".
function fmtRating(r) {
  if (r === null || r === undefined || r === "") return null;
  const n = Number(r); // onboarding may store ratings as strings ("4.5")
  if (!isFinite(n)) return null;
  return (Math.round(n * 10) / 10).toString();
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// The Trey logo at the top of every page. If TREY_LOGO_URL is set we render
// that image; otherwise we inline the official "trey" logo (from
// docs/trey_logo_2.svg) as a single-colour vector that recolours per theme —
// white on the green background, slate on the light theme. Inline (not an
// external image) so the page stays fully self-contained and loads instantly.
function treyMarkHtml() {
  const logo = process.env.TREY_LOGO_URL;
  if (logo) {
    return `<img class="treylogo" src="${escapeHtml(logo)}" alt="Trey">`;
  }
  return `<svg class="treylogo-svg" viewBox="54 88 228 192" role="img" aria-label="Trey" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <g id="ripArcs">
        <path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.32"/>
        <path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity="0.6"/>
        <path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
      </g>
      <g id="mark">
        <use href="#ripArcs" transform="rotate(-20 50 50)"/>
        <rect x="37" y="39" width="26" height="8" rx="2" fill="currentColor"/>
        <rect x="46" y="39" width="8" height="25" rx="2" fill="currentColor"/>
      </g>
    </defs>
    <g transform="translate(165,181) scale(1.18) translate(-165,-181)">
      <use href="#mark" transform="translate(74,105) scale(1.4)"/>
      <text x="206" y="244" font-size="48" font-weight="800" letter-spacing="-1.7" fill="currentColor" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">trey</text>
    </g>
  </svg>`;
}

// A small helper page for the not-authorised / not-found / no-data cases, in
// the same green visual language as the real report.
function noticePage(statusCode, title, message) {
  const body = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box}
  html{background:#059669}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#059669;background-image:linear-gradient(165deg,#0b8a5e 0%,#059669 42%,#047857 100%);background-repeat:no-repeat;color:${SLATE};display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .wrap{max-width:420px;width:100%;text-align:center}
  .treylockup{display:inline-flex;align-items:center;gap:9px;margin-bottom:20px}
  .treytile{width:34px;height:34px;border-radius:10px;background:#fff;color:${GREEN};display:inline-flex;align-items:center;justify-content:center;font-size:17px}
  .treyword{font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px}
  .treylogo{max-height:44px;max-width:150px;object-fit:contain;margin-bottom:20px}
  .treylogo-svg{height:58px;width:auto;color:#fff;margin-bottom:20px}
  .card{width:100%;background:#fff;border-radius:16px;padding:36px 26px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.12)}
  h1{font-size:20px;margin:0 0 10px;color:${SLATE}}
  p{font-size:15px;color:#64748b;line-height:1.55;margin:0}
  .foot{margin-top:22px;font-size:12px;color:rgba(255,255,255,0.85)}
</style></head>
<body><div class="wrap">
  ${treyMarkHtml()}
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  <div class="foot">Powered by Trey</div>
</div></body></html>`;
  return { statusCode, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
}

// Pull everything the page needs for one client + month.
async function loadReportData(locationId, month) {
  const clientsStore = blobsStore("clients");
  const client = await clientsStore.get(locationId, { type: "json" });
  if (!client) return { client: null };

  const taptally = blobsStore("taptally");
  const reviewtally = blobsStore("reviewtally");
  const statsStore = blobsStore("stats");
  const reviewsStore = blobsStore("reviews");

  const tapMonth = (await taptally.get(`${locationId}:${month}`, { type: "json" })) || { taps: 0 };
  const revMonth = (await reviewtally.get(`${locationId}:${month}`, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };
  const stats = (await statsStore.get(locationId, { type: "json" })) || { tapReviews: 0, organicReviews: 0 };

  // Monthly Google-rating snapshots power the hero's true month-over-month
  // change. Snapshots are written by monthly-google-sync (see
  // refresh-google-stats.js); here we read this month's and last month's, and
  // backfill this month from the live rating if a snapshot isn't there yet so
  // history starts accumulating from the first report.
  const ratingHistory = blobsStore("ratinghistory");
  const num = (v) => (v && typeof v.rating === "number" ? v.rating : null);
  let monthRating = num(await ratingHistory.get(`${locationId}:${month}`, { type: "json" }));
  const liveRating = Number(client.googleRating);
  if (monthRating === null && isFinite(liveRating)) {
    monthRating = liveRating;
    // Only persist a backfilled snapshot for the current or just-ended month.
    // Never write today's live rating into an OLD month that a saved link
    // requested — that would fabricate history and skew later month-over-month
    // deltas.
    const bnow = new Date();
    const currentMonth = bnow.toISOString().slice(0, 7);
    if (month === currentMonth || month === lastCompleteMonth(bnow)) {
      try {
        await ratingHistory.setJSON(`${locationId}:${month}`, {
          rating: monthRating, source: "report-backfill", capturedAt: new Date().toISOString(),
        });
      } catch (e) { console.error("[report] rating snapshot backfill failed:", e.message); }
    }
  }
  const prevMonthRating = num(await ratingHistory.get(`${locationId}:${prevMonthKey(month)}`, { type: "json" }));

  // Optional highlight: the most recent glowing (5★, then 4★) review from this
  // month that left a comment.
  let highlight = null;
  try {
    const { blobs } = await reviewsStore.list({ prefix: `review:${locationId}:${month}:` });
    const monthly = (await Promise.all(
      blobs.map((b) => reviewsStore.get(b.key, { type: "json" }))
    )).filter((r) => r && r.comment && String(r.comment).trim());
    const byNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    const hasReply = (r) => r.finalReply && String(r.finalReply).trim();
    // Prefer a glowing review that already has Trey's approved reply (so we can
    // show the reply too), then fall back to any glowing review.
    const tiers = [
      monthly.filter((r) => Number(r.rating) >= 5 && hasReply(r)),
      monthly.filter((r) => Number(r.rating) >= 4 && hasReply(r)),
      monthly.filter((r) => Number(r.rating) >= 5),
      monthly.filter((r) => Number(r.rating) >= 4),
    ];
    for (const tier of tiers) {
      const pick = tier.sort(byNewest)[0];
      if (pick) { highlight = pick; break; }
    }
  } catch (e) {
    console.error("[report] highlight lookup failed:", e.message);
  }

  return { client, tapMonth, revMonth, stats, highlight, monthRating, prevMonthRating };
}

function renderReport(locationId, month, data, theme) {
  const { client, tapMonth, revMonth, stats, highlight, monthRating, prevMonthRating } = data;

  const businessName = escapeHtml(client.businessName || "Your business");
  const logoUrl = client.logoUrl ? escapeHtml(client.logoUrl) : "";

  // --- Trey mark (logo image if TREY_LOGO_URL set, else the ✨ lockup) ---
  const treyLockup = treyMarkHtml();

  // --- Client's own logo, sat in a clean chip under their name ---
  const clientLogo = logoUrl
    ? `<div class="clogo"><img src="${logoUrl}" alt="${businessName}"></div>`
    : "";

  // --- "Since you joined" figures (lifetime): sign-up rating -> current ---
  const initR = fmtRating(client.initialGoogleRating);
  const nowR = fmtRating(client.googleRating);

  // --- Hero: this month's rating movement (this month vs last month) ---
  const curR = fmtRating(monthRating);       // this month's snapshot (fallback: live rating)
  const prevR = fmtRating(prevMonthRating);   // last month's snapshot
  let hero;
  if (curR !== null && prevR !== null) {
    const mDelta = Math.round((monthRating - prevMonthRating) * 10) / 10;
    if (mDelta > 0) {
      hero = `
      <div class="ratingrow">
        <span class="rfrom">${prevR}<span class="star">★</span></span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="rto">${curR}<span class="star">★</span></span>
      </div>
      <div class="badge">▲ +${fmtRating(mDelta)} this month</div>
      <div class="herosub">compared with last month</div>`;
    } else if (mDelta === 0) {
      hero = `
      <div class="ratingrow"><span class="rto">${curR}<span class="star">★</span></span></div>
      <div class="badge flat">Holding steady this month</div>`;
    } else {
      hero = `
      <div class="ratingrow">
        <span class="rfrom">${prevR}<span class="star">★</span></span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="rto">${curR}<span class="star">★</span></span>
      </div>
      <div class="badge flat">Now at ${curR}★</div>
      <div class="herosub">compared with last month</div>`;
    }
  } else if (curR !== null) {
    hero = `
      <div class="ratingrow"><span class="rto">${curR}<span class="star">★</span></span></div>
      <div class="herosub">Your month&#8209;on&#8209;month change appears from next month</div>`;
  } else {
    hero = `<div class="ratingrow"><span class="rto muted">Rating syncing…</span></div>`;
  }

  // --- Stat tiles ---
  const taps = Number(tapMonth.taps || 0);
  const newReviews = Number(revMonth.tapReviews || 0) + Number(revMonth.organicReviews || 0);
  const tiles = `
    <div class="tile"><div class="tnum">${taps}</div><div class="tlabel">${taps === 1 ? "Tap" : "Taps"} this month</div></div>
    <div class="tile"><div class="tnum">${newReviews}</div><div class="tlabel">New Google ${newReviews === 1 ? "review" : "reviews"} this month</div></div>`;

  // --- Trey's contribution (the money line) ---
  const treyReviews = Number(revMonth.tapReviews || 0);
  let contribution = "";
  if (newReviews > 0) {
    contribution = `
    <div class="card contribution">
      <p class="big">Trey brought in <strong>${treyReviews}</strong> of your <strong>${newReviews}</strong> new ${newReviews === 1 ? "review" : "reviews"} this month.</p>
      <div class="splitbar">
        <div class="via" style="flex:${treyReviews || 0.0001}"></div>
        <div class="direct" style="flex:${(newReviews - treyReviews) || 0.0001}"></div>
      </div>
      <div class="splitkey">
        <span><i class="dot via"></i>${plural(treyReviews, "via Trey", "via Trey")}</span>
        <span><i class="dot direct"></i>${plural(newReviews - treyReviews, "direct", "direct")}</span>
      </div>
    </div>`;
  }

  // --- Since you joined ---
  const joined = client.createdAt ? new Date(client.createdAt) : null;
  const joinedLabel = joined ? monthLabel(joined.toISOString().slice(0, 7)) : null;
  const initCount = Number(client.initialReviewCount);
  const nowCount = Number(client.reviewCount);
  let reviewsGained = null;
  if (isFinite(initCount) && isFinite(nowCount) && nowCount >= initCount) {
    reviewsGained = nowCount - initCount;
  } else {
    const cum = Number(stats.tapReviews || 0) + Number(stats.organicReviews || 0);
    reviewsGained = cum > 0 ? cum : null;
  }
  const jstar = `<span class="jstar">★</span>`;
  const journeyRatingLine =
    initR !== null && nowR !== null && initR !== nowR
      ? `Rating <span class="jfrom">${initR}</span>${jstar} → ${nowR}${jstar}`
      : nowR !== null
      ? `Rating holding at ${nowR}${jstar}`
      : null;
  const journeyLines = [];
  if (reviewsGained !== null) {
    journeyLines.push(`<div class="jline"><span class="jnum">${reviewsGained}</span> more ${reviewsGained === 1 ? "review" : "reviews"}</div>`);
  }
  if (journeyRatingLine) journeyLines.push(`<div class="jline jrating">${journeyRatingLine}</div>`);
  const totalTrey = Number(stats.tapReviews || 0);
  const sinceJoined = journeyLines.length
    ? `<div class="card journey">
        <div class="section-label">Since you joined${joinedLabel ? ` in ${escapeHtml(joinedLabel)}` : ""}</div>
        ${journeyLines.join("")}
        ${totalTrey > 0 ? `<div class="treytotal"><img class="tt-mark" src="${TREY_MARK}" alt="Trey"> Trey's brought you <span class="tt-num">${totalTrey}</span> ${totalTrey === 1 ? "review" : "reviews"} in total</div>` : ""}
      </div>`
    : "";

  // --- Customer highlight (optional) ---
  let highlightBlock = "";
  if (highlight) {
    const stars = "★".repeat(Math.max(1, Math.min(5, Number(highlight.rating) || 5)));
    const who = highlight.reviewerName ? escapeHtml(highlight.reviewerName) : "A happy customer";
    const reply = highlight.finalReply && String(highlight.finalReply).trim();
    const replyBlock = reply
      ? `<div class="treyreply">
          <div class="tr-head"><img class="tr-mark" src="${TREY_MARK}" alt="Trey"> Trey's reply</div>
          <p class="tr-body">${escapeHtml(String(highlight.finalReply).trim())}</p>
        </div>`
      : "";
    highlightBlock = `
    <div class="card highlight">
      <div class="section-label">A recent highlight</div>
      <div class="qstars">${stars}</div>
      <blockquote>“${escapeHtml(String(highlight.comment).trim())}”</blockquote>
      <div class="qwho">— ${who}</div>
      ${replyBlock}
    </div>`;
  }

  // --- Footer: optional link to their Google profile ---
  const profileUrl = client.placeId
    ? `https://search.google.com/local/reviews?placeid=${encodeURIComponent(client.placeId)}`
    : "";
  const footerLink = profileUrl
    ? `<a class="glink" href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener">View your Google reviews →</a>`
    : "";

  const title = `${businessName} — Your month with Trey`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  *{box-sizing:border-box}
  :root{--green:${GREEN};--slate:${SLATE}}
  html{min-height:100%}
  body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f1f5f9;color:var(--slate);-webkit-font-smoothing:antialiased}
  .wrap{max-width:460px;margin:0 auto;padding:20px 16px 40px}
  .card{background:#fff;border-radius:18px;padding:22px 20px;margin:14px 0;box-shadow:0 6px 20px rgba(15,23,42,0.06)}
  .head{text-align:center;padding:14px 0 6px}
  .treylockup{display:inline-flex;align-items:center;gap:9px;margin-bottom:16px}
  .treytile{width:34px;height:34px;border-radius:10px;background:var(--green);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:17px}
  .treyword{font-size:24px;font-weight:800;color:var(--slate);letter-spacing:-0.5px}
  .treylogo{max-height:56px;max-width:180px;object-fit:contain;display:block;margin:0 auto 16px}
  .treylogo-svg{height:64px;width:auto;display:block;margin:0 auto 14px;color:var(--slate)}
  .bname{font-size:22px;font-weight:800;letter-spacing:-0.4px;margin:0}
  .clogo{display:inline-block;background:#fff;border-radius:14px;padding:10px 16px;margin:14px auto 0;box-shadow:0 4px 14px rgba(15,23,42,0.08)}
  .clogo img{max-height:52px;max-width:170px;object-fit:contain;display:block}
  .subtitle{font-size:14px;color:#64748b;margin:12px 0 0}
  .hero{text-align:center;padding:26px 20px}
  .hero .section-label{margin-bottom:14px}
  .ratingrow{display:flex;align-items:center;justify-content:center;gap:14px;font-weight:800;letter-spacing:-1px}
  .rfrom{font-size:34px;color:#94a3b8}
  .rto{font-size:52px;color:var(--slate)}
  .rto.muted{font-size:24px;color:#94a3b8;font-weight:600}
  .arrow{font-size:30px;color:#cbd5e1}
  .star{font-size:0.55em;color:#f59e0b;margin-left:2px}
  .badge{display:inline-block;margin-top:16px;background:#d1fae5;color:#047857;font-weight:700;font-size:15px;padding:8px 16px;border-radius:999px}
  .badge.flat{background:#f1f5f9;color:#475569}
  .herosub{font-size:13px;color:#64748b;margin-top:12px}
  .tiles{display:flex;gap:14px}
  .tiles .tile{flex:1;background:#fff;border-radius:18px;padding:22px 14px;text-align:center;box-shadow:0 6px 20px rgba(15,23,42,0.06)}
  .tnum{font-size:40px;font-weight:800;color:var(--slate);line-height:1;letter-spacing:-1px}
  .tlabel{font-size:13px;color:#64748b;margin-top:8px;line-height:1.35}
  .section-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--green)}
  .big{font-size:19px;line-height:1.45;margin:10px 0 0;color:var(--slate)}
  .big strong{color:var(--green)}
  .sub{font-size:14px;color:#64748b;margin:10px 0 0}
  .contribution .big{margin-top:0}
  .splitbar{display:flex;height:12px;border-radius:999px;overflow:hidden;margin:18px 0 10px;background:#e2e8f0}
  .splitbar .via{background:var(--green)}
  .splitbar .direct{background:#cbd5e1}
  .splitkey{display:flex;gap:18px;font-size:13px;color:#64748b}
  .splitkey .dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
  .dot.via{background:var(--green)}
  .dot.direct{background:#cbd5e1}
  .journey .big{margin-top:8px}
  .journey .jline{font-size:19px;line-height:1.4;margin:8px 0 0;color:var(--slate);font-weight:600}
  .journey .jnum{color:var(--green);font-weight:800}
  .journey .jrating{font-weight:600;white-space:nowrap}
  .jstar{color:#f59e0b}
  .journey .jfrom{color:#94a3b8}
  .treytotal{margin-top:16px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:12px 14px;font-size:15px;color:#065f46;font-weight:600;line-height:1.4;display:flex;align-items:center;flex-wrap:wrap;gap:2px}
  .treytotal .tt-mark{width:22px;height:22px;border-radius:6px;margin-right:7px;object-fit:cover;flex:0 0 auto}
  .treytotal .tt-num{color:var(--green);font-weight:800;font-size:18px;margin:0 3px}
  .highlight .qstars{color:#f59e0b;font-size:18px;margin:10px 0 6px;letter-spacing:2px}
  blockquote{margin:0;font-size:18px;line-height:1.5;color:var(--slate);font-weight:500}
  .qwho{font-size:14px;color:#64748b;margin-top:12px}
  .treyreply{margin-top:16px;padding:14px 16px;background:#f0fdf4;border-radius:12px;border-left:3px solid var(--green)}
  .treyreply .tr-head{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--green)}
  .treyreply .tr-mark{width:20px;height:20px;border-radius:5px;object-fit:cover}
  .treyreply .tr-body{margin:8px 0 0;font-size:15px;line-height:1.5;color:#475569}
  .foot{text-align:center;padding:26px 12px 0;color:#94a3b8;font-size:13px}
  .foot .powered{font-weight:700;color:#64748b}
  .glink{display:inline-block;margin-top:10px;color:var(--green);text-decoration:none;font-weight:600;font-size:14px}
  /* green background theme — solid fallback + gradient that covers the full
     document height (no background-attachment:fixed, which breaks on mobile
     browsers and leaves everything below the first screen white) */
  html:has(body.theme-green){background:#059669}
  body.theme-green{background-color:#059669;background-image:linear-gradient(165deg,#0b8a5e 0%,#059669 42%,#047857 100%);background-repeat:no-repeat}
  body.theme-green .treylogo-svg{color:#fff}
  body.theme-green .treytile{background:#fff;color:var(--green)}
  body.theme-green .treyword{color:#fff}
  body.theme-green .bname{color:#fff}
  body.theme-green .subtitle{color:rgba(255,255,255,0.85)}
  body.theme-green .foot .powered{color:#fff}
  body.theme-green .foot .glink{color:#fff;text-decoration:underline}
</style></head>
<body class="${theme === "green" ? "theme-green" : ""}">
  <div class="wrap">
    <div class="head">
      ${treyLockup}
      <h1 class="bname">${businessName}</h1>
      ${clientLogo}
      <p class="subtitle">Your month with Trey — ${escapeHtml(monthLabel(month))}</p>
    </div>

    <div class="card hero">
      <div class="section-label">Your Google rating this month</div>
      ${hero}
    </div>

    <div class="tiles">${tiles}</div>

    ${contribution}
    ${sinceJoined}
    ${highlightBlock}

    <div class="foot">
      <div class="powered">Powered by Trey</div>
      ${footerLink}
    </div>
  </div>
</body></html>`;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const locationId = params.loc;
  const now = new Date();
  const month = params.m || lastCompleteMonth(now);

  if (!locationId) {
    return noticePage(400, "Report unavailable", "This report link is missing a location. Please use the link from your monthly Trey message.");
  }

  // --- Key generator (admin-only): mint the signed link to send. ---
  if (params.gen) {
    const gh = event.headers || {};
    const provided = (gh.authorization || gh.Authorization || "").replace(/^Bearer\s+/i, "").trim() || params.token || "";
    const expected = process.env.CLIENT_ADMIN_TOKEN || "";
    const authOk = !!expected && provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!authOk) {
      return { statusCode: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    if (!process.env.TREY_REPORT_SECRET) {
      return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "TREY_REPORT_SECRET is not set on Netlify" }) };
    }
    const key = reportKey(locationId);
    const base = process.env.URL || "https://treyv1.netlify.app";
    const url = `${base}/.netlify/functions/report?loc=${encodeURIComponent(locationId)}&m=${encodeURIComponent(month)}&k=${key}`;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loc: locationId, month, key, url }),
    };
  }

  // --- Access gate: non-guessable per-client key required. ---
  if (!process.env.TREY_REPORT_SECRET) {
    console.error("[report] TREY_REPORT_SECRET is not set");
    return noticePage(500, "Report unavailable", "This report isn't set up yet. Please try again later.");
  }
  if (!keyValid(locationId, params.k)) {
    return noticePage(403, "Report unavailable", "This link isn't valid or has expired. Please use the most recent link from your monthly Trey message.");
  }

  let data;
  try {
    data = await loadReportData(locationId, month);
  } catch (err) {
    console.error("[report] data load failed:", err.message);
    return noticePage(500, "Report unavailable", "We couldn't load your report just now. Please try again in a moment.");
  }

  if (!data.client) {
    return noticePage(404, "Report unavailable", "We couldn't find this account. Please check the link from your monthly Trey message.");
  }

  // Green is the default theme; &bg=light is an escape hatch for comparison.
  const theme = params.bg === "light" ? "light" : "green";
  const html = renderReport(locationId, month, data, theme);
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: html,
  };
};
