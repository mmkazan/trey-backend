// Client-facing "Trey Profile Check" — a login-free page that shows how complete
// their Google Business Profile is and the highest-impact fixes, with drafted
// content ready to paste.
//
//   GET  /profile-check?loc=<locationId>&k=<key>   -> the audit
//   POST /profile-check   (loc, k, action=applyDescription, text)  -> apply (Phase 2)
//
// Phase 1 (no Google API): shows suggested categories, a drafted services list,
// a drafted description and a checklist — all copy/paste.
// Phase 2 (API live): also reads the real profile, scores it, and lets them apply
// the description in one tap. (Category/service auto-apply is a later enhancement
// — those need gcid resolution + serviceItem structuring.)

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const googleApi = require("./google-api.js");
const audit = require("./profile-audit.js");

// --- Which plan is this client on? -------------------------------------------
//   "standard" -> £35/mo (the default for everyone else)
//   "founding" -> £25/mo for life (the first 20; index.html advertises it)
//   "annual"   -> £350/yr (two months free)
//   "free"     -> complimentary. Family, friends and test accounts. Never
//                 billed, never nagged to subscribe, never paused.
//
// Centralised because these decisions appear on FIVE separate pages — the inbox,
// the monthly report, the approve page, the profile-check paywall and the paused
// stand. A founding member quoted £25 in one place and £35 in another doesn't
// read that as a bug, they read it as a bait-and-switch; and a comped friend
// being asked to pay is worse.
const PLANS = ["standard", "founding", "annual", "free"];
function planOf(client) {
  const p = String((client && client.plan) || "").toLowerCase();
  if (PLANS.includes(p)) return p;
  // Back-compat with the short-lived boolean this replaced.
  if (client && client.foundingMember === true) return "founding";
  return "standard";
}

// A comped account. Treated as permanently subscribed: no payment link, no
// upgrade banner, no paywall, and the stand never pauses.
function isComped(client) {
  return planOf(client) === "free";
}

// An unrecognised plan falls back to STANDARD, never to free — a typo must not
// silently give the product away. A missing env var falls back to the standard
// link rather than rendering an unpayable page, but says so loudly: quietly
// charging someone £35 for a plan you promised at £25 is the kind of failure
// nobody spots until they complain.
function payLinkFor(client) {
  const plan = planOf(client);
  if (plan === "free") return "";   // nothing to sell them
  const standard = process.env.STRIPE_PAYMENT_LINK || "";
  if (plan === "founding" || plan === "annual") {
    const envName = plan === "founding" ? "STRIPE_FOUNDING_PAYMENT_LINK" : "STRIPE_ANNUAL_PAYMENT_LINK";
    const link = process.env[envName];
    if (link) return link;
    console.warn(`[pricing] ${envName} is not set — a "${plan}" client is being shown the STANDARD price. Set it in Netlify and redeploy.`);
    return standard;
  }
  return standard;
}


const KEY_LEN = 32;
const INDIGO = "#4338ca", ACCENT = "#4f46e5", SLATE = "#0f172a";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}
function reportKey(locationId) {
  return crypto.createHmac("sha256", process.env.TREY_REPORT_SECRET || "").update(String(locationId)).digest("hex").slice(0, KEY_LEN);
}
function keyValid(locationId, provided) {
  if (!locationId || !process.env.TREY_REPORT_SECRET) return false;
  const expected = reportKey(locationId);
  const got = String(provided || "");
  if (got.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch (e) { return false; }
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function parseBody(event) {
  const out = {}; try { for (const [k, v] of new URLSearchParams(event.body || "").entries()) out[k] = v; } catch (e) {}
  return out;
}

// Build the shape scoreProfile() expects from a Google location + photo count.
function normalise(loc, photoCount) {
  loc = loc || {};
  return {
    primaryCategory: loc.categories && loc.categories.primaryCategory ? true : false,
    secondaryCount: (loc.categories && loc.categories.additionalCategories && loc.categories.additionalCategories.length) || 0,
    description: (loc.profile && loc.profile.description) || "",
    serviceCount: (loc.serviceItems && loc.serviceItems.length) || 0,
    hoursSet: !!(loc.regularHours && loc.regularHours.periods && loc.regularHours.periods.length),
    phone: (loc.phoneNumbers && loc.phoneNumbers.primaryPhone) || "",
    website: loc.websiteUri || "",
    photoCount: photoCount || 0,
    hasLogo: (photoCount || 0) > 0,
    attributeCount: 0,
    openingDate: (loc.openInfo && loc.openInfo.openingDate) ? true : false,
    questionCount: 0,
  };
}

const MARK = `<svg viewBox="0 0 100 100" width="30" height="30" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Trey"><rect width="100" height="100" rx="24" fill="#4338ca"/><g transform="rotate(-20 50 50)"><path d="M21.7,83.7 A44,44 0 1 1 78.3,83.7" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.32"/><path d="M28.8,75.3 A33,33 0 1 1 71.2,75.3" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.6"/><path d="M35.85,66.85 A22,22 0 1 1 64.15,66.85" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g><rect x="37" y="39" width="26" height="8" rx="2" fill="#fff"/><rect x="46" y="39" width="8" height="25" rx="2" fill="#fff"/></svg>`;

function shell(inner, code = 200) {
  return {
    statusCode: code,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Trey — Profile Check</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#e4eefc;color:${SLATE}}
  .wrap{max-width:460px;margin:0 auto;padding:20px 16px 48px}
  .brand{display:flex;align-items:center;gap:9px;padding:8px 0 14px;font-weight:800;font-size:17px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{font-size:14px;color:#64748b;margin:0 0 16px}
  .card{background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:16px 16px;margin-bottom:14px;box-shadow:0 8px 24px rgba(15,23,42,.05)}
  .score{display:flex;align-items:center;gap:16px}
  .ring{width:76px;height:76px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;color:#fff;flex:0 0 auto}
  .sec{font-size:12px;letter-spacing:.06em;color:#64748b;font-weight:800;margin:18px 4px 8px}
  .gap{display:flex;gap:10px;padding:10px 0;border-top:1px solid #f1f5f9;font-size:14px}
  .gap:first-child{border-top:0}
  .gap .dot{width:8px;height:8px;border-radius:50%;background:${ACCENT};margin-top:6px;flex:0 0 auto}
  .gap b{color:${SLATE}} .gap span{color:#64748b}
  label{font-size:13px;font-weight:700;color:#334155}
  textarea{width:100%;margin-top:6px;border:1px solid #e2e8f0;border-radius:12px;padding:12px;font-size:14px;color:#334155;line-height:1.5;font-family:inherit;min-height:120px}
  .list{margin:8px 0 0;padding:0;list-style:none}
  .list li{font-size:14px;color:#334155;padding:6px 0;border-top:1px solid #f1f5f9}
  .list li:first-child{border-top:0}
  .list li b{color:${SLATE}}
  .btn{display:block;width:100%;text-align:center;border:0;border-radius:11px;padding:12px;font-size:14.5px;font-weight:800;cursor:pointer;font-family:inherit;text-decoration:none;margin-top:10px}
  .primary{background:${INDIGO};color:#fff}
  .ghost{background:#eef2ff;color:${INDIGO};border:1px solid #d7defe}
  .ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:12px;padding:13px;font-size:14px;font-weight:600;text-align:center}
  .pill{display:inline-block;background:#eef2ff;color:${INDIGO};font-weight:700;font-size:13px;padding:5px 10px;border-radius:8px;margin:4px 6px 0 0}
  .foot{text-align:center;color:#94a3b8;font-size:12px;margin-top:22px}
  .hint{font-size:12.5px;color:#64748b;line-height:1.55;margin-top:8px}
</style></head><body><div class="wrap"><div class="brand">${MARK}trey</div>${inner}<div class="foot">Powered by Trey</div></div></body></html>`,
  };
}
function notice(t, m, code = 200) { return shell(`<div class="card" style="text-align:center"><h1>${escapeHtml(t)}</h1><p class="sub" style="margin-top:8px">${escapeHtml(m)}</p></div>`, code); }

const copyJs = (id) => `onclick="(function(b){var t=document.getElementById('${id}');var v=t.value!==undefined?t.value:t.textContent;navigator.clipboard&&navigator.clipboard.writeText(v);b.textContent='Copied ✓';})(this)"`;

exports.handler = async (event) => {
  const params = event.httpMethod === "POST" ? parseBody(event) : (event.queryStringParameters || {});
  const loc = params.loc, k = params.k;
  if (!loc || !keyValid(loc, k)) return notice("Link not valid", "This link isn't valid or has expired. Please use the most recent link from Trey.", 403);

  const client = await blobsStore("clients").get(loc, { type: "json" });
  if (!client) return notice("Not found", "We couldn't find this account.", 404);

  const bn = escapeHtml(client.businessName || "your business");
  const cats = audit.suggestCategories(client.businessType);
  const services = audit.draftServices(client.businessType);
  const description = audit.draftDescriptionFallback(client);
  const canApi = googleApi.isEnabled();

  // --- Trial gating -----------------------------------------------------------
  // Decided 2026-08-14. The free trial covers the REVIEW engine plus the Trey
  // Score as a read-only diagnosis — a business can see exactly where they stand
  // and what's holding them back. The drafted profile work (categories, services,
  // description) is the labour they're paying for, so it unlocks on subscribing.
  //
  // Without this, the one-and-done profile fix could be taken during a free trial
  // and banked, with nothing left to renew. Diagnosis free, treatment paid.
  //
  // "Grandfathered" clients with no recorded status are treated as subscribers so
  // this can never lock out an existing paying customer.
  const status = String(client.subscriptionStatus || "").toLowerCase();
  // Comped accounts (family, friends, test) get everything a subscriber gets.
  const isSubscriber = status === "active" || status === "" || isComped(client);

  // POST — apply the description (the one clean auto-apply). Phase 2 only.
  if (event.httpMethod === "POST") {
    if (!isSubscriber) return notice("Part of your subscription", "Applying profile changes is included once you subscribe. Your free trial covers the review side — see your Trey Score on the previous page.", 200);
    if (!canApi) return notice("Not available yet", "Applying changes automatically switches on once your Google connection is live. For now, copy and paste.", 200);
    try {
      const text = String(params.text || description).trim();
      await googleApi.updateLocation(loc, { profile: { description: text } }, "profile.description");
      return shell(`<div class="card"><div class="ok">✅ Your description is now live on your Google profile.</div><p class="hint">${escapeHtml(text)}</p></div>`);
    } catch (err) {
      console.error("[profile-check] apply failed:", err.message);
      return notice("Couldn't apply", "Something went wrong updating Google. Please try again, or copy it in manually.", 500);
    }
  }

  // GET — build the audit view.
  let scoreBlock = "";
  if (canApi) {
    try {
      const location = await googleApi.getLocation(loc);
      let photoCount = 0;
      try { photoCount = await googleApi.listPhotoCount(client.googleAccountId, loc); } catch (e) {}
      // The gaps list comes from the completeness checker, but the NUMBER on the
      // ring must stay the same metric the client sees everywhere else — the
      // composite Trey Score. Showing scoreProfile()'s completeness-only figure
      // here made the score appear to lurch (different formula, different bands)
      // the moment the Google connection went live.
      const norm = normalise(location, photoCount);
      const { gaps } = audit.scoreProfile(norm);
      const live = audit.scoreBusiness({
        reputation: {
          rating: Number(client.googleRating),
          reviewCount: Number(client.reviewCount) || 0,
          reviewsLast90: client.reviewsLast90,
          replyRate: audit.parsePct(client.ownerResponseRate),
        },
        activity: { postedRecently: !!client.postedRecently, photosFresh: (photoCount || 0) > 0 },
        completeness: norm,
      });
      const score = live.total;
      const colour = score >= 75 ? "#16a34a" : score >= 50 ? "#f59e0b" : "#ef4444";
      const gapsHtml = gaps.length
        ? gaps.map((g) => `<div class="gap"><span class="dot"></span><div><b>${escapeHtml(g.label)}${g.partial ? " (nearly)" : ""}</b><br><span>${escapeHtml(g.fix)}</span></div></div>`).join("")
        : `<p class="hint">Nice — your profile is in great shape. Keep the posts and photos coming.</p>`;
      scoreBlock = `<div class="card"><div class="score"><div class="ring" style="background:${colour}">${score}</div>
        <div><div style="font-weight:800;font-size:16px">Your Trey Score</div><div class="sub" style="margin:2px 0 0">${gaps.length} quick ${gaps.length === 1 ? "win" : "wins"} below to climb higher.</div></div></div></div>
        <div class="sec">Your quick wins</div><div class="card">${gapsHtml}</div>`;
    } catch (err) {
      console.error("[profile-check] read failed:", err.message);
      scoreBlock = `<div class="card"><p class="hint">We couldn't read your live profile just now — the tuned suggestions below still apply.</p></div>`;
    }
  } else {
    // No live Google connection yet, so we estimate the Trey Score from what we
    // already hold on the client (their rating and review count, plus the basics
    // we know are set). Reputation is real; Activity and the finer Completeness
    // points can't be seen without the API, so the estimate is a FLOOR and is
    // labelled as such — never dress an estimate up as a measurement.
    const rating = Number(client.googleRating);
    const reviewCount = Number(client.reviewCount) || 0;
    let estBlock = "";
    if (isFinite(rating) && rating > 0) {
      // Every unknown is scored as ZERO, not "middling". scoreBusiness() gives
      // unknown recency 4/8 and unknown reply-rate 2/6 by default, which is right
      // for ranking cold leads but wrong here: it would make the number FALL when
      // the real data arrives. Passing explicit zeros makes this a true floor —
      // once the Google connection is live the score can only go up.
      const est = audit.scoreBusiness({
        reputation: { rating, reviewCount, reviewsLast90: 0, replyRate: 0 },
        activity: { postedRecently: false, photosFresh: false },
        completeness: { primaryCategory: !!client.businessType, phone: !!client.phone, website: !!client.website },
      });
      const colour = est.total >= 75 ? "#16a34a" : est.total >= 50 ? "#f59e0b" : "#ef4444";
      estBlock = `<div class="card"><div class="score"><div class="ring" style="background:${colour}">${est.total}</div>
        <div><div style="font-weight:800;font-size:16px">Your Trey Score &mdash; at least ${est.total}</div>
        <div class="sub" style="margin:2px 0 0">${escapeHtml(est.band)} &middot; at least ${Math.max(0, 100 - est.total)} points to gain</div></div></div>
        <p class="hint" style="margin:10px 0 0">A cautious estimate from your rating and review count &mdash; anything we can't see yet counts as zero, so your real score can only be higher. Once your Google connection is live we read your profile itself, and the number gets sharper.</p></div>`;
    }
    scoreBlock = `<div class="card"><h1 style="margin:0 0 4px">Tune your Google profile — ${bn}</h1><p class="sub" style="margin:0">${isSubscriber
      ? "A few high-impact tweaks Google rewards. Here's everything drafted and ready to paste."
      : "A few high-impact tweaks Google rewards. Here's where you stand — we'll write and apply the fixes when you subscribe."}</p></div>${estBlock}`;
  }

  const catsHtml = cats.primary
    ? `<div class="sec">Categories (biggest ranking lever)</div><div class="card">
        <div><b>Primary:</b> <span class="pill">${escapeHtml(cats.primary)}</span></div>
        <div style="margin-top:8px"><b>Add these secondary categories:</b><br>${cats.secondaries.map((c) => `<span class="pill">${escapeHtml(c)}</span>`).join("")}</div>
        <p class="hint">In your Google profile: Edit profile → Business category → set the primary and add the secondaries (pick the closest matching names Google offers).</p></div>` : "";

  const svcText = services.map((s) => `${s.name} — ${s.description}`).join("\n");
  const svcHtml = `<div class="sec">Services to list</div><div class="card">
      <ul class="list">${services.map((s) => `<li><b>${escapeHtml(s.name)}</b> — ${escapeHtml(s.description)}</li>`).join("")}</ul>
      <textarea id="svc" style="display:none">${escapeHtml(svcText)}</textarea>
      <button type="button" class="btn ghost" ${copyJs("svc")}>Copy the list</button>
      <p class="hint">Add these under Edit profile → Services. Google can rank you for each one.</p></div>`;

  const applyBtn = canApi
    ? `<button type="submit" class="btn primary">✓ Apply this to Google</button>`
    : `<button type="button" class="btn ghost" ${copyJs("desc")}>Copy the description</button>`;
  const descHtml = `<div class="sec">Business description</div>
    <form method="POST" action="/.netlify/functions/profile-check"><div class="card">
      <input type="hidden" name="loc" value="${escapeHtml(loc)}"><input type="hidden" name="k" value="${escapeHtml(k)}">
      <label for="desc">Ready-to-use description</label>
      <textarea id="desc" name="text">${escapeHtml(description)}</textarea>
      ${applyBtn}
    </div></form>`;


  // What a trial user sees in place of the drafted work. Deliberately not a
  // teaser wall: they've already seen their score and every specific gap above,
  // so this states plainly what's included rather than dangling it.
  const payBase = payLinkFor(client);
  const payUrl = payBase ? payBase + (payBase.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(loc) : "";
  const lockedBlock = `<div class="sec">Fixing it</div><div class="card">
      <p style="margin:0 0 8px"><b>Your subscription includes the profile work.</b></p>
      <p class="hint" style="margin:0 0 12px">We write your categories, services and description, apply them to Google for you, then keep the profile active with a monthly post and a photo prompt each quarter. Your free trial covers the review side — the taps, the AI replies and your Trey Score.</p>
      ${payUrl ? `<a class="btn primary" href="${escapeHtml(payUrl)}">Subscribe and switch it on</a>` : `<p class="hint" style="margin:0">Talk to us at info@trey.today to switch it on.</p>`}
    </div>`;
  const openGoogle = `<a class="btn ghost" href="https://business.google.com/edit" target="_blank" rel="noopener noreferrer">Open Google Business Profile &rarr;</a>`;

  // Subscribers get the drafted work; trial users get their score, their gaps and
  // a plain statement of what subscribing switches on.
  const body = isSubscriber
    ? `${scoreBlock}${catsHtml}${svcHtml}${descHtml}<div class="card">${openGoogle}<p class="hint">Also worth two minutes: set your <b>holiday hours</b>, tick your <b>attributes</b> (parking, accessibility, payments), and add a <b>logo + cover photo</b>.</p></div>`
    : `${scoreBlock}${lockedBlock}`;
  return shell(body);
};
