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
const { linkKey, linkValid, secretConfigured } = require("./link-keys");

// This page's own purpose. Its key opens THIS page and nothing else — see
// link-keys.js for why. A key minted for another page will not validate here.
const LINK_PURPOSE = "profile";

// Kept as a thin wrapper so existing call sites read the same. All the real
// work (constant-time compare, fail-closed on an unset secret, byte-length
// check before timingSafeEqual) lives in link-keys.js.
function keyValid(locationId, provided) {
  return linkValid(LINK_PURPOSE, locationId, provided);
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function parseBody(event) {
  const out = {}; try { for (const [k, v] of new URLSearchParams(event.body || "").entries()) out[k] = v; } catch (e) {}
  return out;
}

// Build the shape scoreProfile() expects from a Google location + photo count.
//
// null means WE DID NOT CHECK THIS, and profile-audit.js takes anything null out
// of the denominator instead of scoring it zero. Three fields are null here and
// each one used to be a lie the customer was shown as a failing:
//
//   attributeCount / questionCount — hard-coded to 0 because there is no API
//     read for either. That capped every score at 88 and put two "quick wins"
//     on the page that no amount of work could ever clear.
//   hasLogo — derived from "photoCount > 0". A media COUNT cannot tell you
//     whether one of them is the logo or the cover photo, so that was an
//     invented answer that happened to be flattering.
//
// photoCount is passed through as null when the media read FAILED, so a Google
// hiccup reads as "we couldn't check" rather than "you have no photos".
function normalise(loc, photoCount) {
  loc = loc || {};
  const photos = (photoCount === null || photoCount === undefined) ? null : Number(photoCount) || 0;
  return {
    primaryCategory: loc.categories && loc.categories.primaryCategory ? true : false,
    secondaryCount: (loc.categories && loc.categories.additionalCategories && loc.categories.additionalCategories.length) || 0,
    description: (loc.profile && loc.profile.description) || "",
    serviceCount: (loc.serviceItems && loc.serviceItems.length) || 0,
    hoursSet: !!(loc.regularHours && loc.regularHours.periods && loc.regularHours.periods.length),
    phone: (loc.phoneNumbers && loc.phoneNumbers.primaryPhone) || "",
    website: loc.websiteUri || "",
    photoCount: photos,
    hasLogo: null,
    attributeCount: null,
    openingDate: (loc.openInfo && loc.openInfo.openingDate) ? true : false,
    questionCount: null,
  };
}

// A finite number, or null for "not recorded". Used instead of Number(x) so an
// unset googleRating arrives at the scorer as "unknown" rather than as NaN,
// which the old code silently turned into a hard zero on an 18-point component.
function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// --- What Trey can honestly measure from its OWN records ---------------------
//
// The live score used to read client.reviewsLast90, client.ownerResponseRate and
// client.postedRecently. NOTHING writes those three fields to a client record —
// they exist on LEAD records, filled in by the Apify scrape. So the Activity
// pillar was a permanent 0/15 for every customer, and it stayed 0 even after
// they published a Google Post through google-post.js. This is the fix: read
// what we actually hold, and return null for the rest.
async function measureFromTreyRecords(loc) {
  const out = { reviewsLast90: null, postedRecently: null, postedWithin3m: null };
  const nowMs = Date.now();
  const days = (iso) => (nowMs - Date.parse(iso || "")) / 86400000;

  // POSTING. google-post-send.mjs writes `pending:<loc>:<YYYY-MM>` into `posts`,
  // and google-post.js sets status "posted" + postedAt when it publishes through
  // the API. That is a fact: Trey put a post on their profile on that date.
  //
  // Only ever set to TRUE. A post the owner wrote themselves in Google is
  // invisible to us — nothing we have lists a location's posts — so "no post
  // found" means "we didn't see one", not "they haven't posted", and it stays
  // null. status "copied" is NOT counted either: that only records that they
  // tapped the button on the copy/paste page, not that anything went live.
  try {
    const postsStore = blobsStore("posts");
    const { blobs } = await postsStore.list({ prefix: `pending:${loc}:` });
    for (const b of blobs) {
      const p = await postsStore.get(b.key, { type: "json" }).catch(() => null);
      if (!p || p.status !== "posted") continue;
      const age = days(p.postedAt);
      if (!isFinite(age)) continue;
      if (age <= 30) { out.postedRecently = true; out.postedWithin3m = true; }
      else if (age <= 90 && out.postedRecently !== true) out.postedWithin3m = true;
    }
  } catch (e) {
    console.error("[profile-check] post history unreadable:", e.message);
  }

  // REVIEWS IN THE LAST 90 DAYS. Countable from our own review records — but
  // ONLY if we have been watching this location for the whole 90 days. Trey
  // records a review when fetch-reviews.mjs first sees it, so before the
  // baseline is 90 days old the count is a partial window, and reporting a
  // partial window as the real figure would mark a client down for reviews they
  // got before we arrived. No full window, no measurement.
  //
  // Known limitation, stated rather than hidden: a review that already carried
  // an owner reply the first time we polled is skipped by fetch-reviews and
  // never recorded, so this can undercount by any review answered within
  // fifteen minutes of appearing.
  try {
    const seenStore = blobsStore("reviewsseen");
    const baseline = await seenStore.get(`baseline:${loc}`, { type: "json" });
    const watchedDays = baseline ? days(baseline.at) : NaN;
    if (isFinite(watchedDays) && watchedDays >= 90) {
      const reviewsStore = blobsStore("reviews");
      const { blobs } = await reviewsStore.list({ prefix: `review:${loc}:` });
      let n = 0;
      for (const b of blobs) {
        const r = await reviewsStore.get(b.key, { type: "json" }).catch(() => null);
        const age = r ? days(r.createdAt) : NaN;
        if (isFinite(age) && age <= 90) n++;
      }
      out.reviewsLast90 = n;
    }
  } catch (e) {
    console.error("[profile-check] review history unreadable:", e.message);
  }

  return out;
}

// REPLY RATE IS DELIBERATELY NEVER MEASURED HERE, and this is the reasoning so
// nobody "fixes" it by wiring up the obvious number. We hold every reply
// approved through Trey, so replies/reviews looks computable — but a reply the
// owner posts directly in Google is never written back to our record, and that
// review sits in our store as "pending" forever. The number would therefore call
// the most diligent owners non-repliers. Until we can read reply state back off
// the profile, "unknown" is the only true answer.
const REPLY_RATE_NOT_MEASURABLE = null;

// Why a component could not be checked, in the customer's language. Keyed by the
// component keys profile-audit.js reports in `unmeasured`.
const UNMEASURED_REASONS = {
  reviewsLast90: "Reviews in the last 90 days — we'll score this once Trey has been watching your reviews for a full 90 days.",
  replyRate: "Your reply rate — we can see the replies you approve in Trey, but not ones you post in Google yourself, so we don't score it.",
  posted: "Google posts — we can see the posts Trey publishes for you, not ones you add yourself.",
  photos: "Your photos — we couldn't read your photo count from Google just now.",
  logo: "Logo and cover photo — Google's photo list doesn't tell us which photo is which.",
  attributes: "Attributes — not readable through the Google connection we have yet.",
  attributeCount: "Attributes — not readable through the Google connection we have yet.",
  questions: "Q&A — not readable through the Google connection we have yet.",
  rating: "Your star rating — we don't have it on file yet.",
  reviewCount: "Your review count — we don't have it on file yet.",
};
const unmeasuredReason = (key, label) => UNMEASURED_REASONS[key] || `${label} — we can't check this yet.`;

// The "not measurable yet" block. Shown whenever anything was left out of the
// score, because a denominator that quietly shrinks is its own kind of dishonest
// — the customer has to be able to see WHAT wasn't checked and why.
function unmeasuredHtml(items) {
  if (!items || !items.length) return "";
  // De-duplicated on the SENTENCE, not the key: the two scorers name the same
  // thing differently ("attributes" / "attributeCount"), and the customer would
  // just see the same line twice.
  const seen = new Set();
  const rows = items.map((u) => unmeasuredReason(u.key, u.label))
    .filter((line) => (seen.has(line) ? false : seen.add(line)))
    .map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return `<div class="sec">Not measurable yet</div><div class="card">
    <p class="hint" style="margin:0 0 6px">These are left OUT of your score rather than counted against you. We'd rather show you a smaller total than mark you down for something we never checked.</p>
    <ul class="list">${rows}</ul></div>`;
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
      // null, not 0 — a failed media read must not be scored as "no photos".
      let photoCount = null;
      try { photoCount = await googleApi.listPhotoCount(client.googleAccountId, loc); }
      catch (e) { console.error("[profile-check] photo count unreadable:", e.message); }
      // The gaps list comes from the completeness checker, but the NUMBER on the
      // ring must stay the same metric the client sees everywhere else — the
      // composite Trey Score. Showing scoreProfile()'s completeness-only figure
      // here made the score appear to lurch (different formula, different bands)
      // the moment the Google connection went live.
      const norm = normalise(location, photoCount);
      const prof = audit.scoreProfile(norm);
      const gaps = prof.gaps;
      const seen = await measureFromTreyRecords(loc);
      const live = audit.scoreBusiness({
        reputation: {
          // null where we have nothing on file. These used to be Number(...) and
          // Number(...) || 0, so an account we'd never filled in scored a hard 0
          // out of 30 on rating and volume we had simply never asked Google for.
          rating: numOrNull(client.googleRating),
          reviewCount: numOrNull(client.reviewCount),
          // Measured from Trey's own review records when the 90-day window is
          // complete, null otherwise. client.reviewsLast90 never existed.
          reviewsLast90: seen.reviewsLast90,
          replyRate: REPLY_RATE_NOT_MEASURABLE,
        },
        // A post Trey published for them IS reflected here — that was the point.
        activity: {
          postedRecently: seen.postedRecently,
          postedWithin3m: seen.postedWithin3m,
          photoCount,
        },
        completeness: norm,
      });
      // Both scorers report what they couldn't check; the page lists the union,
      // de-duplicated by key inside unmeasuredHtml().
      const unmeasured = [...live.unmeasured, ...prof.unmeasured];
      const colour = live.color;
      const gapsHtml = gaps.length
        ? gaps.map((g) => `<div class="gap"><span class="dot"></span><div><b>${escapeHtml(g.label)}${g.partial ? " (nearly)" : ""}</b><br><span>${escapeHtml(g.fix)}</span></div></div>`).join("")
        : `<p class="hint">Nice — everything we can check is in good shape. Keep the posts and photos coming.</p>`;
      // "out of ${live.outOf}", never out of 100. The components we couldn't
      // check are listed underneath instead of being scored as failures.
      scoreBlock = live.outOf
        ? `<div class="card"><div class="score"><div class="ring" style="background:${colour}">${live.total}</div>
        <div><div style="font-weight:800;font-size:16px">Your Trey Score &mdash; ${live.total} out of ${live.outOf}</div>
        <div class="sub" style="margin:2px 0 0">${escapeHtml(live.band)} &middot; ${gaps.length} quick ${gaps.length === 1 ? "win" : "wins"} below${live.outOf < 100 ? " &middot; scored on the " + live.outOf + " points we can currently check" : ""}.</div></div></div></div>
        <div class="sec">Your quick wins</div><div class="card">${gapsHtml}</div>${unmeasuredHtml(unmeasured)}`
        : `<div class="card"><p class="hint">We couldn't check anything scoreable on your profile just now, so there's no score to show — rather than a zero that would look like a verdict.</p></div>${unmeasuredHtml(unmeasured)}`;
    } catch (err) {
      console.error("[profile-check] read failed:", err.message);
      scoreBlock = `<div class="card"><p class="hint">We couldn't read your live profile just now — the tuned suggestions below still apply.</p></div>`;
    }
  } else {
    // No live Google connection yet, so the score is built from the handful of
    // things we genuinely hold: their rating and review count, whether we know
    // their trade, phone and website, and any Google Post Trey has published for
    // them. EVERYTHING ELSE IS LEFT OUT OF THE TOTAL rather than scored zero.
    //
    // This used to pass explicit zeros for recency, reply rate and activity and
    // call the result a "floor" — mathematically neat, but what the customer
    // read was a low number and a list of things they had apparently failed, on
    // a profile nobody had looked at. Same instrument, honest denominator.
    const rating = numOrNull(client.googleRating);
    let estBlock = "";
    if (rating !== null && rating > 0) {
      const seen = await measureFromTreyRecords(loc);
      const est = audit.scoreBusiness({
        reputation: {
          rating,
          reviewCount: numOrNull(client.reviewCount),
          reviewsLast90: seen.reviewsLast90,
          replyRate: REPLY_RATE_NOT_MEASURABLE,
        },
        activity: { postedRecently: seen.postedRecently, postedWithin3m: seen.postedWithin3m },
        // Only the three we can answer without reading the profile. The rest are
        // absent, which now means "not checked", not "missing".
        completeness: { primaryCategory: !!client.businessType, phone: !!client.phone, website: !!client.website },
      });
      const colour = est.color;
      estBlock = `<div class="card"><div class="score"><div class="ring" style="background:${colour}">${est.total}</div>
        <div><div style="font-weight:800;font-size:16px">Your Trey Score &mdash; ${est.total} out of ${est.outOf}</div>
        <div class="sub" style="margin:2px 0 0">${escapeHtml(est.band)} &middot; ${Math.max(0, est.outOf - est.total)} points to gain on what we can see</div></div></div>
        <p class="hint" style="margin:10px 0 0">Scored on the ${est.outOf} points we can check today &mdash; your rating, your reviews and the details we hold. The rest of your profile isn't counted either way until your Google connection is live, because we haven't looked at it.</p></div>${unmeasuredHtml(est.unmeasured)}`;
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
