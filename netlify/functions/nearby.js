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

async function staticMap(centre, leads) {
  const key = process.env.GOOGLE_MAPS_STATIC_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  const zoom = fitZoom(centre, leads);
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${centre.lat},${centre.lng}` +
    `&zoom=${zoom}&size=${MAP_W}x${MAP_H}&scale=2&maptype=roadmap&key=${key}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      // Most likely the key doesn't have Maps Static API enabled. Not fatal —
      // the list works perfectly well without a picture.
      console.warn(`[nearby] static map unavailable (${resp.status}) — enable "Maps Static API" on the key.`);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    // centre/zoom/size go with the picture so the page can place its own dots.
    return {
      img: `data:image/png;base64,${buf.toString("base64")}`,
      centre: { lat: centre.lat, lng: centre.lng },
      zoom, width: MAP_W, height: MAP_H,
    };
  } catch (e) {
    console.warn("[nearby] static map failed:", e.message);
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
    const ids = (Array.isArray(body.placeIds) ? body.placeIds : [])
      .map((x) => String(x || "").trim()).filter(Boolean).slice(0, 60);
    if (!ids.length) return { statusCode: 400, body: JSON.stringify({ error: "No placeIds given" }) };
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) return { statusCode: 200, body: JSON.stringify({ error: "GOOGLE_PLACES_API_KEY is not set", config: true }) };

    const found = {};
    const failed = [];
    // Sequential on purpose. A burst of parallel Places calls is a good way to
    // hit a rate limit and get a confusing half-empty map.
    for (const id of ids) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const r = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(id)}`, {
          headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,location" },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const d = await r.json().catch(() => ({}));
        if (r.ok && d && d.location) found[id] = { lat: d.location.latitude, lng: d.location.longitude };
        else failed.push(id);
      } catch (e) { failed.push(id); }
    }
    // Say what couldn't be found rather than quietly returning fewer pins than
    // the caller asked for.
    return { statusCode: 200, body: JSON.stringify({
      found, foundCount: Object.keys(found).length, failed,
      requested: ids.length, capped: (body.placeIds || []).length > 60,
    }) };
  }

  // --- A picture for a set of points already in hand ---------------------------
  // The leads map needs a base map around leads it already has coordinates for,
  // without running a Places search at all — no search, no cost beyond the one
  // Static Maps call.
  if (body.action === "basemap") {
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
    const map = await staticMap(centre, pts);
    return { statusCode: 200, body: JSON.stringify({ map, centre, count: pts.length }) };
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
    const map = body.includeMap === false ? null : await staticMap({ lat, lng }, leads);
    return { statusCode: 200, body: JSON.stringify({ count: leads.length, radius, leads, placeLabel, centre: { lat, lng }, map }) };
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
