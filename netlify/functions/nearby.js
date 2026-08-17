// FIELD PROSPECTING — "Trey on the go".
//
// Standing on a high street, answer three questions about every business around
// you: how are they doing, what's hurting, and who nearby is beating them.
//
//   POST { token, lat, lng, radius?, keyword? }        -> ranked list of nearby businesses
//   POST { token, action:"details", placeId }          -> reviews + local competitors
//
// WHY A SERVER FUNCTION AND NOT A DIRECT BROWSER CALL
// The Places key must never reach the phone. A key in client-side JS is
// extractable by anyone who opens the page, and Places is billed per request —
// a leaked key is somebody else's bill on your card. It stays here, and this
// endpoint is admin-gated like leads.js and client.js.
//
// THIS IS NOT SCRAPING. It's the official Places API, self-serve with billing.
// It is also SEPARATE from the Business Profile API application still pending as
// case 6-1359000041824 — nothing here waits on that.
//
// WHAT IT STORES, AND WHY SO LITTLE (corrected 16 Aug — the earlier note here
// was too blunt).
//
// Google's Maps Platform terms are more nuanced than "don't store anything":
//   - place_id            may be cached INDEFINITELY (Service Terms A.3)
//   - latitude/longitude  may be cached for up to 30 CONSECUTIVE CALENDAR DAYS,
//                         after which it must be deleted
//   - other Places content is covered by the general "no pre-fetching, caching or
//     storage" rule, with the 30-day allowance written specifically around
//     lat/lng rather than as a blanket permission
//
// So a 30-day window does exist, and Matthew was right to push back on the flat
// "no storing". But it does not stretch to review text.
//
// The binding constraint on reviews isn't Google's terms anyway — it's UK GDPR.
// Reviewer names and review text are THIRD-PARTY personal data, obtained from
// neither the reviewer nor the business, and holding them in a sales database to
// help sell something is exactly what the 15 Aug compliance audit called the most
// legally exposed thing in this repo. That reasoning is independent of whatever
// Google permits, so reviews stay fetched-live, shown once, never written down.
//
// Ratings and review COUNTS are different — business facts, not personal data —
// and are already stored from Apify. Those are fine to keep.
//
// COST: one searchNearby returns up to 20 businesses, so walking a whole town is
// a handful of calls, not one per shop. Field masks are set tight because Places
// bills by the fields you ask for.

const { getStore } = require("@netlify/blobs");

const PLACES_BASE = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 8000;

// Only what the scoring and the pitch actually need. Every extra field costs money.
const LIST_FIELDS = [
  "places.id", "places.displayName", "places.primaryTypeDisplayName", "places.primaryType",
  "places.rating", "places.userRatingCount", "places.formattedAddress",
  "places.nationalPhoneNumber", "places.websiteUri", "places.location",
  "places.googleMapsUri", "places.businessStatus",
].join(",");

const DETAIL_FIELDS = [
  "id", "displayName", "primaryTypeDisplayName", "primaryType", "rating", "userRatingCount",
  "formattedAddress", "nationalPhoneNumber", "websiteUri", "location", "googleMapsUri",
  "reviews", "businessStatus",
].join(",");

// Identity, not a yes/no — see admin-auth.js. One shared implementation so the
// four back-office endpoints can never drift apart on who may do what.
const { adminIdentity, can, unauthorized, forbidden } = require("./admin-auth.js");

/**
 * Businesses you already sell to, so a live search never offers you one of your
 * own customers as a hot prospect.
 *
 * Found the hard way: a DE21 search returned "Raven Holistics" as the top door to
 * knock on, scored 97. That's Matthew's wife's business and already a client.
 * Matching on place ID alone wasn't enough — a client that was never a scraped
 * lead has no place ID stored — so names and phone numbers are matched too.
 */
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normPhone = (s) => String(s || "").replace(/\D/g, "").slice(-9);

async function clientMatchers() {
  const empty = { placeIds: new Set(), names: new Set(), phones: new Set() };
  try {
    const store = getStore({ name: "clients", siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const { blobs } = await store.list();
    const m = { placeIds: new Set(), names: new Set(), phones: new Set() };
    for (const b of blobs) {
      const c = await store.get(b.key, { type: "json" });
      if (!c) continue;
      if (c.placeId) m.placeIds.add(c.placeId);
      if (c.businessName) m.names.add(normName(c.businessName));
      const p = normPhone(c.phone);
      if (p.length === 9) m.phones.add(p);
    }
    return m;
  } catch (e) {
    // Not fatal — worst case you're shown a business you already own and you
    // notice. Better than the whole search failing.
    console.warn("[nearby] couldn't read clients to exclude them:", e.message);
    return empty;
  }
}

const isExistingClient = (l, m) =>
  !!((l.placeId && m.placeIds.has(l.placeId)) ||
     (l.businessName && m.names.has(normName(l.businessName))) ||
     (normPhone(l.phone).length === 9 && m.phones.has(normPhone(l.phone))));

async function places(path, bodyObj, fieldMask) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw Object.assign(new Error("GOOGLE_PLACES_API_KEY is not set"), { config: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${PLACES_BASE}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error((data && data.error && data.error.message) || `Places ${resp.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// --- Scoring ------------------------------------------------------------------
// Mirrors opportunityScore() in leads.html so the field list ranks a business
// exactly as the desktop list does. Keep the two in step.
//
// IMPORTANT LIMITATION, and it changes what the score means here: the Places API
// has NO owner-response field (verified against Google's docs — the review object
// is author, rating, text, time, language, photo, and nothing else). So
// replyRate is unknown out here, where the desktop list gets it from Apify.
// opportunityScore already treats null as 0.5, i.e. "assume half the reviews are
// unanswered", which is the honest neutral. Scores in the field will therefore
// differ slightly from the same lead on the desktop — that is expected, not a bug.
const cl = (x, a, b) => Math.max(a, Math.min(b, x));

function opportunityScore(l) {
  const rating = Number(l.rating);
  const rc = Number(l.reviewCount) || 0;
  const replyRate = l.replyRate == null ? null : Number(l.replyRate);
  const r90 = Number(l.reviewsLast90);
  const recent = Number(l.recentUnanswered) || 0;
  const size = cl(rc / 150, 0, 1);
  const gap = replyRate == null ? 0.5 : 1 - replyRate;
  const replyGapPts = gap * size * 40;
  let actPts = rc >= 10 ? 16 : rc >= 3 ? 8 : 0;
  if (isFinite(r90) && r90 >= 1) actPts = Math.min(actPts + 4, 20);
  const painPts = Math.min(recent * 7, 20);
  const compPts = (l.website ? 0 : 8) + (l.category ? 0 : 8) + (l.phone ? 0 : 4);
  const raw = cl(replyGapPts + actPts + painPts + compPts, 0, 100);
  let win;
  if (!isFinite(rating) || rating <= 0) win = 0.7;
  else if (rating < 2.8) win = 0.25;
  else if (rating < 3.3) win = 0.6;
  else if (rating < 3.8) win = 0.85;
  else win = 1.0;
  if (!l.phone && !l.email) win *= 0.7;
  const total = Math.round(cl(raw * win, 0, 100));
  const band = total >= 60 ? "Hot" : total >= 33 ? "Warm" : "Cold";
  return { total, band };
}

/**
 * FIELD SCORE — who to actually walk into, right now.
 *
 * NOT opportunityScore(). That one is built for the scraped desktop list, where
 * Apify supplies an owner reply rate, and it is dominated by
 *     replyGapPts = gap * (reviewCount / 150) * 40
 * i.e. "lots of reviews, nobody replying" — the case reply-drafting fixes.
 *
 * Out here that term is worthless and actively misleading. The Places API has NO
 * owner-response field (checked against Google's docs), so `gap` is a flat 0.5
 * guess and the whole score collapses to "whoever has the most reviews wins".
 * Ranked that way, a 4.8-star café with 400 reviews sorts ABOVE a 4.6-star barber
 * with 8 — which is exactly backwards for someone standing on a high street.
 *
 * The business worth knocking on has FEW reviews and a GOOD rating: they do
 * decent work, and nobody is asking their customers. That is the tap-stand pitch
 * in one sentence, and it's what this scores.
 *
 * `peerMedian` is the median review count of nearby same-type businesses when we
 * have it — being 11 against a local median of 60 is far more compelling, and far
 * more true, than 11 in the abstract.
 */
function fieldScore(l, peerMedian) {
  const rating = Number(l.rating);
  const rc = Number(l.reviewCount) || 0;

  // 1) Deficit against the neighbours (0-45). This is the pitch: the gap Trey closes.
  let deficitPts;
  if (isFinite(peerMedian) && peerMedian > 0) {
    deficitPts = cl(1 - rc / peerMedian, 0, 1) * 45;
  } else {
    // No local comparison — fall back to absolute scarcity.
    deficitPts = rc >= 100 ? 0 : rc >= 50 ? 8 : rc >= 25 ? 20 : rc >= 10 ? 33 : rc >= 1 ? 42 : 30;
  }

  // 2) Do they deserve more reviews? (0-30) A well-run business that nobody is
  //    asking is the ideal customer. A 2-star is a different, harder conversation.
  let qualityPts;
  if (!isFinite(rating) || rating <= 0) qualityPts = 12;   // unrated: unknown, worth a look
  else if (rating >= 4.5) qualityPts = 30;
  else if (rating >= 4.0) qualityPts = 26;
  else if (rating >= 3.5) qualityPts = 16;
  else if (rating >= 3.0) qualityPts = 7;
  else qualityPts = 0;

  // 3) Can you follow up after the visit? (0-15)
  const reachPts = (l.phone ? 10 : 0) + (l.website ? 5 : 0);

  // 4) Is anyone home? (0-10) A business with zero reviews may also have zero
  //    customers; a handful proves the door swings.
  const alivePts = rc >= 3 ? 10 : rc >= 1 ? 6 : 0;

  const total = Math.round(cl(deficitPts + qualityPts + reachPts + alivePts, 0, 100));
  const band = total >= 65 ? "Knock now" : total >= 45 ? "Worth a look" : "Skip";
  return { total, band };
}

// Same anchored corporate-suffix test as leads.js, so the field tool tells you
// the same thing about who you may message. Errors fall towards "restricted".
const CORPORATE_RE = /(\bltd|\blimited|\bplc|\bllp|\bl\.t\.d|\bincorporated|\binc|\bcic|\bcio)[\s.,)\]]*$/i;
function inferLegalStatus(name) {
  return CORPORATE_RE.test(String(name || "")) ? "ltd" : "unknown";
}

function shape(p) {
  const name = (p.displayName && p.displayName.text) || "";
  const lead = {
    placeId: p.id || "",
    businessName: name,
    category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || p.primaryType || "",
    primaryType: p.primaryType || "",
    rating: typeof p.rating === "number" ? p.rating : null,
    reviewCount: typeof p.userRatingCount === "number" ? p.userRatingCount : 0,
    address: p.formattedAddress || "",
    phone: p.nationalPhoneNumber || "",
    website: p.websiteUri || "",
    mapsUri: p.googleMapsUri || "",
    lat: p.location && p.location.latitude,
    lng: p.location && p.location.longitude,
    closed: p.businessStatus && p.businessStatus !== "OPERATIONAL" ? p.businessStatus : "",
  };
  lead.opportunity = opportunityScore(lead);
  lead.legalStatus = inferLegalStatus(name);
  return lead;
}

// Metres between two lat/lngs — for "within 400m" competitor sets and for
// showing how far you'd have to walk.
function metres(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/**
 * Competitor context: where does this business rank among nearby businesses of
 * the SAME primary type?
 *
 * "You're 4th of 6 vape shops within 400m" is far harder to argue with than
 * naming one rival — which invites "well, they've been going twenty years" — and
 * it doesn't make you sound like you're running down a specific neighbour to
 * their face.
 *
 * Chains are excluded: a Tesco Express with 400 reviews is not a competitor to a
 * one-shop trader in any sense its owner cares about, and leaving it in poisons
 * the comparison.
 */
function competitorContext(target, pool) {
  if (!target.primaryType) return null;
  const CHAIN_REVIEW_CEILING = 12;   // × the target's own count
  const peers = pool.filter((p) =>
    p.placeId !== target.placeId &&
    p.primaryType === target.primaryType &&
    !p.closed &&
    typeof p.rating === "number" &&
    (target.reviewCount < 5 || p.reviewCount <= target.reviewCount * CHAIN_REVIEW_CEILING));
  if (!peers.length) return null;

  const all = [target, ...peers].sort((a, b) =>
    (b.reviewCount - a.reviewCount) || ((b.rating || 0) - (a.rating || 0)));
  const rank = all.findIndex((p) => p.placeId === target.placeId) + 1;
  const best = all[0];
  const median = (() => {
    const counts = all.map((p) => p.reviewCount).sort((x, y) => x - y);
    const m = Math.floor(counts.length / 2);
    return counts.length % 2 ? counts[m] : Math.round((counts[m - 1] + counts[m]) / 2);
  })();
  return {
    rank, of: all.length, medianReviews: median,
    best: best.placeId === target.placeId ? null : {
      name: best.businessName, rating: best.rating, reviewCount: best.reviewCount,
      multiple: target.reviewCount > 0 ? Math.round((best.reviewCount / target.reviewCount) * 10) / 10 : null,
    },
  };
}

/**
 * A little map of the walk.
 *
 * WHY GOOGLE'S OWN STATIC MAPS AND NOT LEAFLET/OpenStreetMap:
 * the Maps Platform terms restrict displaying Places content on a NON-Google
 * map. Dropping Places-derived pins on a free OSM tile layer would be neat and
 * would also breach that. Static Maps is Google's own, so it's in bounds.
 *
 * And because it's proxied here rather than embedded in the page, THE API KEY
 * NEVER REACHES THE PHONE — the image comes back as a data URL. A Maps key in
 * client-side HTML is extractable and billed per load.
 *
 * WHAT COMES BACK IS A BARE MAP — NO PINS. The first version burned the
 * coloured numbered pins into the image server-side, which was wrong: filter to
 * "Knock now" and the picture still showed the ones you'd just hidden, and sort
 * by distance and the numbers no longer matched the cards. A baked image can't
 * follow view state, and re-fetching one per tap costs a Static Maps call each
 * time. So the page draws its own dots over this picture (see pinPos() in
 * go.html) using the centre/zoom returned here — instant, free, and always in
 * step with the list. It also lifts the old 9-pin cap, because Static Maps
 * labels are one character and HTML isn't.
 */
const MAP_W = 640, MAP_H = 380, MAP_PAD = 46;

// Web Mercator, world pixels. Must match pinPos() in go.html exactly.
function projX(lng, world) { return ((lng + 180) / 360) * world; }
function projY(lat, world) {
  const s = Math.max(-0.9999, Math.min(0.9999, Math.sin((lat * Math.PI) / 180)));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
}

/**
 * Closest zoom that still fits every business in frame around you.
 * Centred on YOU rather than on the bounding box: standing in the street, the
 * question is always "which way do I walk from here".
 */
function fitZoom(centre, points) {
  for (let z = 19; z >= 1; z--) {
    const world = 256 * Math.pow(2, z);
    const cx = projX(centre.lng, world), cy = projY(centre.lat, world);
    const fits = points.every((p) => {
      if (p.lat == null || p.lng == null) return true;
      return Math.abs(projX(p.lng, world) - cx) * 2 <= MAP_W - MAP_PAD * 2 &&
             Math.abs(projY(p.lat, world) - cy) * 2 <= MAP_H - MAP_PAD * 2;
    });
    if (fits) return z;
  }
  return 1;
}

/**
 * WHY THIS VARIABLE EXISTS.
 *
 * A missing map used to be completely silent: staticMap returned null for four
 * quite different reasons — no key configured, Google refused the key, Google
 * refused the request, the network died — and every one of them showed the same
 * blank box with a guess printed under it ("is Maps Static API enabled?"). That
 * guess was wrong at least once and cost an evening. The reason Google gives is
 * plain text in the response body; there is no excuse for throwing it away.
 *
 * Set on every attempt, read immediately afterwards by the handler. Safe because
 * a Lambda invocation handles one request at a time.
 */
let LAST_MAP_ERROR = null;

/** Never let an API key travel back to the browser inside an error message. */
const scrubKey = (s) => String(s == null ? "" : s)
  .replace(/key=[^&\s"'<]+/gi, "key=***")
  .replace(/AIza[0-9A-Za-z_-]+/g, "***")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 300);

async function staticMap(centre, leads, forceZoom) {
  const key = process.env.GOOGLE_MAPS_STATIC_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    LAST_MAP_ERROR = "No Google API key in this deploy — neither GOOGLE_MAPS_STATIC_KEY " +
      "nor GOOGLE_PLACES_API_KEY is set. Env vars only take effect on a NEW deploy.";
    console.warn("[nearby] " + LAST_MAP_ERROR);
    return null;
  }
  // forceZoom is the manual zoom control; without it, fit everything in frame.
  const zoom = forceZoom != null ? forceZoom : fitZoom(centre, leads);
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${centre.lat},${centre.lng}` +
    `&zoom=${zoom}&size=${MAP_W}x${MAP_H}&scale=2&maptype=roadmap&key=${key}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      // Google puts the actual reason in the body as plain text — "The provided
      // API key is expired", "This API project is not authorized to use this
      // API", "You must enable Billing". Pass it through verbatim; guessing is
      // what wasted the time last time.
      const why = scrubKey(await resp.text().catch(() => ""));
      LAST_MAP_ERROR = `Google refused the map picture (HTTP ${resp.status})` + (why ? `: ${why}` : ".");
      console.warn("[nearby] " + LAST_MAP_ERROR);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    LAST_MAP_ERROR = null;
    // centre/zoom/size go with the picture so the page can place its own dots.
    return {
      img: `data:image/png;base64,${buf.toString("base64")}`,
      centre: { lat: centre.lat, lng: centre.lng },
      zoom, width: MAP_W, height: MAP_H,
    };
  } catch (e) {
    LAST_MAP_ERROR = e.name === "AbortError"
      ? `Google took longer than ${TIMEOUT_MS}ms to send the map picture.`
      : `Couldn't reach Google for the map picture: ${scrubKey(e.message)}`;
    console.warn("[nearby] " + LAST_MAP_ERROR);
    return null;
  }
}

/**
 * Turn "Ashbourne" or "DE21 6NX" into a point, so the tool works from the sofa
 * as well as the pavement.
 *
 * Uses Places Text Search rather than the Geocoding API — one less API to enable,
 * one less key to manage, and it handles both a place name and a postcode.
 */
async function locate(query) {
  const data = await places("places:searchText", {
    textQuery: String(query).slice(0, 120),
    maxResultCount: 1,
    // Keep it in the UK — "Springfield" should not land in Missouri.
    regionCode: "GB",
  }, "places.location,places.formattedAddress,places.displayName");
  const p = (data.places || [])[0];
  if (!p || !p.location) return null;
  return {
    lat: p.location.latitude,
    lng: p.location.longitude,
    label: p.formattedAddress || (p.displayName && p.displayName.text) || String(query),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { /* handled below */ }
  const who = adminIdentity(event, body);
  if (!who) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const fail = (err) => {
    console.error("[nearby]", err && err.message);
    if (err && err.config) {
      return { statusCode: 503, body: JSON.stringify({
        error: "GOOGLE_PLACES_API_KEY isn't set in Netlify — see the setup note in go.html.", config: true }) };
    }
    return { statusCode: 502, body: JSON.stringify({ error: (err && err.message) || "Places lookup failed" }) };
  };

  // --- Coordinates for leads that haven't got any ------------------------------
  //
  // Leads saved before the planning map existed, and everything imported from
  // Apify, have a place_id but no lat/lng — so they can't be drawn. This looks
  // them up in a batch.
  //
  // Deliberately a SEPARATE, EXPLICIT action rather than something automatic:
  // it costs one Places call per lead, so the page tells you how many it's about
  // to look up and waits to be asked. Google's terms let the coordinates be kept
  // for 30 days (see leads.js), so this is roughly a monthly cost per lead, not
  // a per-page-view one.
  if (body.action === "locate") {
    // GEOCODING WITHOUT GOOGLE (rewritten 17 Aug 2026).
    //
    // This used to resolve coordinates from a place_id via the Places API. That
    // made every coordinate GOOGLE MAPS CONTENT, and the Maps Platform Service
    // Specific Terms §10.2 say plainly:
    //
    //   "Customer must not use Google Maps Content from the Places API in
    //    conjunction with a non-Google map."
    //
    // The maps are Leaflet + OpenStreetMap now, so Places-derived coordinates
    // could not lawfully be drawn on them. Rather than give up the interactive
    // map, the coordinates changed source.
    //
    // The leads' ADDRESSES came from the Apify sweep, not from Google's APIs, so
    // they are ours to geocode however we like. Geocoding them with open data
    // produces coordinates that are not Google Maps Content at all — which fixes
    // the terms problem AND means the 30-day deletion rule stops applying (see
    // geoExpired in leads.js). It is also free, where Places charged per lead per
    // month.
    //
    //   1. Nominatim (OpenStreetMap) on the full address -> building-level.
    //   2. postcodes.io (ONS/OS open data) on the postcode -> centroid, ~100m.
    //
    // Provenance is recorded on every result as geoSource so the page can show
    // which pins are precise and which are a postcode blob. Drawing a centroid
    // as though it were a shopfront would be the same dishonesty as the map
    // error that cost an evening.
    const items = (Array.isArray(body.items) ? body.items : [])
      .map((x) => ({
        id: String((x && x.id) || "").trim(),
        address: String((x && x.address) || "").trim().slice(0, 300),
        postcode: String((x && x.postcode) || "").trim().slice(0, 12),
      }))
      .filter((x) => x.id && (x.address || x.postcode))
      .slice(0, 40);

    if (!items.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "No addresses given" }) };
    }

    const found = {};
    const failed = [];

    // NOMINATIM'S USAGE POLICY IS A HARD 1 REQUEST PER SECOND, and it asks for a
    // real identifying User-Agent. Both are conditions of the free service, not
    // suggestions — parallelising this would get Trey blocked, which is why the
    // worker-pool pattern used elsewhere in this file is deliberately NOT used
    // here. One at a time, a second apart.
    const UA = "Trey/1.0 (https://trey.today; info@trey.today)";
    const RATE_MS = 1100;
    const DEADLINE = Date.now() + 7000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function viaAddress(addr) {
      const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=gb&q=" +
        encodeURIComponent(addr);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      try {
        const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "en-GB" }, signal: ctrl.signal });
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        if (!Array.isArray(d) || !d.length) return null;
        const lat = Number(d[0].lat), lng = Number(d[0].lon);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        return { lat, lng, geoSource: "address" };
      } catch (e) { return null; } finally { clearTimeout(timer); }
    }

    // Pulls a UK postcode out of whatever it's given — a bare postcode, or a full
    // address with one on the end. Anchored to the END so "The Limited Edition,
    // 12 Sadler Gate, Derby DE1 3NQ" yields DE13NQ and not something from the
    // street name.
    function extractPostcode(text) {
      const m = String(text || "").toUpperCase()
        .match(/([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\s*$/);
      return m ? (m[1] + m[2]) : "";
    }

    async function viaPostcode(pc) {
      const clean = extractPostcode(pc);
      if (clean.length < 5) return null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(clean),
          { headers: { "User-Agent": UA }, signal: ctrl.signal });
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        const res = d && d.result;
        if (!res || !isFinite(Number(res.latitude)) || !isFinite(Number(res.longitude))) return null;
        return { lat: Number(res.latitude), lng: Number(res.longitude), geoSource: "postcode" };
      } catch (e) { return null; } finally { clearTimeout(timer); }
    }

    let attempted = 0;
    for (const it of items) {
      // Stop starting new work rather than getting killed mid-flight. Whatever
      // is done comes back; the rest is reported so the page can ask again.
      if (Date.now() > DEADLINE) break;
      attempted++;
      let hit = it.address ? await viaAddress(it.address) : null;
      if (!hit) hit = await viaPostcode(it.postcode || it.address);
      if (hit) found[it.id] = hit;
      else failed.push({ id: it.id, reason: "no match for the address or postcode" });
      await sleep(RATE_MS);
    }

    const notAttempted = items.length - attempted;
    return {
      statusCode: 200,
      body: JSON.stringify({
        found,
        failed,
        notAttempted,
        attribution: "Geocoding \u00a9 OpenStreetMap contributors (Nominatim) and postcodes.io (ONS/OS, Open Government Licence)",
      }),
    };
  }

  // --- A picture for a set of points already in hand ---------------------------
  // The leads map needs a base map around leads it already has coordinates for,
  // without running a Places search at all — no search, no cost beyond the one
  // Static Maps call.
  if (body.action === "basemap") {
    // An explicit zoom/centre overrides the auto-fit, so the page can zoom and
    // pan without re-running any Places search — one Static Maps call per step
    // and nothing else.
    const wantZoom = Number(body.zoom);
    // Number(null) is 0, not NaN — so a lead with null coordinates would become
    // a point in the Atlantic and drag the map's centre out to sea with it.
    // Reject empties explicitly before converting.
    const coord = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
    const pts = (Array.isArray(body.points) ? body.points : [])
      .map((p) => ({ lat: coord(p.lat), lng: coord(p.lng) }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lng));
    if (!pts.length) return { statusCode: 400, body: JSON.stringify({ error: "No points given" }) };
    const centre = {
      lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
      lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length,
    };
    const c = (isFinite(Number(body.centreLat)) && isFinite(Number(body.centreLng)))
      ? { lat: Number(body.centreLat), lng: Number(body.centreLng) } : centre;
    const zoom = isFinite(wantZoom) ? Math.max(1, Math.min(20, Math.round(wantZoom))) : null;
    const map = await staticMap(c, pts, zoom);
    return { statusCode: 200,
      body: JSON.stringify({ map, mapError: map ? null : LAST_MAP_ERROR, centre: c, count: pts.length }) };
  }

  // --- One business: live reviews + who's beating them -------------------------
  if (body.action === "details") {
    if (!body.placeId) return { statusCode: 400, body: JSON.stringify({ error: "placeId is required" }) };
    try {
      const p = await places(`places/${encodeURIComponent(body.placeId)}`, undefined, DETAIL_FIELDS)
        .catch(async () => {
          // Place Details is a GET in the New API; the helper posts. Fall back.
          const key = process.env.GOOGLE_PLACES_API_KEY;
          const r = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(body.placeId)}`, {
            headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAIL_FIELDS },
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((d && d.error && d.error.message) || `Places ${r.status}`);
          return d;
        });

      const lead = shape(p);
      // Up to 5, newest-looking first. NOT stored anywhere — see the header.
      const reviews = (p.reviews || []).map((r) => ({
        rating: r.rating,
        text: (r.originalText && r.originalText.text) || (r.text && r.text.text) || "",
        when: r.relativePublishTimeDescription || "",
        publishTime: r.publishTime || "",
        author: (r.authorAttribution && r.authorAttribution.displayName) || "",
      })).sort((a, b) => new Date(b.publishTime || 0) - new Date(a.publishTime || 0));

      // Competitors, if we were given the surrounding list to compare against.
      let competitors = null;
      if (Array.isArray(body.pool) && body.pool.length) {
        competitors = competitorContext(lead, body.pool);
      }
      return { statusCode: 200, body: JSON.stringify({ lead, reviews, competitors }) };
    } catch (err) { return fail(err); }
  }

  // --- What's around me --------------------------------------------------------
  let lat = Number(body.lat), lng = Number(body.lng), placeLabel = "";
  // Search by name/postcode when there's no GPS fix — indoors, on a laptop, or
  // planning tomorrow's round the night before.
  if ((!isFinite(lat) || !isFinite(lng)) && body.where) {
    try {
      const found = await locate(body.where);
      if (!found) {
        return { statusCode: 404, body: JSON.stringify({ error: `Couldn't find "${String(body.where).slice(0, 60)}". Try a postcode or a town name.` }) };
      }
      lat = found.lat; lng = found.lng; placeLabel = found.label;
    } catch (err) { return fail(err); }
  }
  if (!isFinite(lat) || !isFinite(lng)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Give me either your location or a place to search." }) };
  }
  const radius = Math.min(Math.max(Number(body.radius) || 250, 50), 2000);

  try {
    const req = {
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      rankPreference: "DISTANCE",
    };
    if (body.includedTypes && Array.isArray(body.includedTypes) && body.includedTypes.length) {
      req.includedTypes = body.includedTypes;
    }
    const data = await places("places:searchNearby", req, LIST_FIELDS);
    const all = (data.places || []).map(shape);
    const here = { lat, lng };
    const open = all.filter((l) => !l.closed);
    const leads = open
      .map((l) => {
        // Median review count among nearby businesses of the SAME type — the
        // number that makes "you're on 11" mean something.
        const peers = open.filter((p) => p.primaryType && p.primaryType === l.primaryType && p.placeId !== l.placeId);
        let peerMedian = null;
        if (peers.length) {
          const counts = peers.map((p) => p.reviewCount).sort((x, y) => x - y);
          const m = Math.floor(counts.length / 2);
          peerMedian = counts.length % 2 ? counts[m] : Math.round((counts[m - 1] + counts[m]) / 2);
        }
        return {
          ...l,
          metresAway: metres(here, { lat: l.lat, lng: l.lng }),
          peerMedian,
          peerCount: peers.length,
          field: fieldScore(l, peerMedian),
        };
      })
      // Best door first — the whole point of standing in the street with this.
      .sort((a, b) => b.field.total - a.field.total || (a.metresAway || 0) - (b.metresAway || 0));
    // Optional, because the base64 image roughly doubles the response size and
    // isn't wanted on every refresh.
    // Flag anyone you already sell to rather than offering them as a prospect.
    const mine = await clientMatchers();
    const flagged = leads.map((l) => (isExistingClient(l, mine) ? { ...l, isClient: true } : l));
    const clientCount = flagged.filter((l) => l.isClient).length;

    // Optional, because the base64 image roughly doubles the response size and
    // isn't wanted on every refresh.
    const wantMap = body.includeMap !== false;
    const map = wantMap ? await staticMap({ lat, lng }, leads) : null;
    return { statusCode: 200, body: JSON.stringify({
      count: flagged.length, radius, leads: flagged, placeLabel,
      centre: { lat, lng }, map, mapError: (wantMap && !map) ? LAST_MAP_ERROR : null, clientCount }) };
  } catch (err) { return fail(err); }
};

module.exports.opportunityScore = opportunityScore;   // kept for parity with leads.html
module.exports.fieldScore = fieldScore;
module.exports.competitorContext = competitorContext;
module.exports.inferLegalStatus = inferLegalStatus;
module.exports.metres = metres;
module.exports.fitZoom = fitZoom;
module.exports.projX = projX;
module.exports.projY = projY;
