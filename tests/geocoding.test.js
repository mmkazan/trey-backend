// Geocoding provenance — the fix for the Google Maps terms breach.
//
// Google Maps Platform Service Specific Terms §10.2:
//   "Customer must not use Google Maps Content from the Places API in
//    conjunction with a non-Google map."
//
// The maps are Leaflet + OpenStreetMap. So coordinates must NOT come from the
// Places API, and live Places results must not be drawn on them. These tests
// exist so a future session cannot quietly undo either.

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

exports.run = function (t) {
  const nearby = fs.readFileSync(path.join(FN, "nearby.js"), "utf8");
  const leads = fs.readFileSync(path.join(FN, "leads.js"), "utf8");
  const go = read("go.html");

  // === the geocoder is no longer Google =====================================
  const locateStart = nearby.indexOf('body.action === "locate"');
  t.ok(locateStart > 0, "the locate action still exists");
  const locateEnd = nearby.indexOf('attribution:', locateStart);
  const locateBlock = nearby.slice(locateStart, locateEnd > 0 ? locateEnd : locateStart + 6000);

  t.ok(!/PLACES_BASE/.test(locateBlock),
    "REGRESSION: no Places API call anywhere on the geocoding path");
  t.ok(!/X-Goog-Api-Key/.test(locateBlock), "no Google API key is sent while geocoding");
  t.ok(/nominatim\.openstreetmap\.org/.test(locateBlock), "geocodes addresses via Nominatim");
  t.ok(/api\.postcodes\.io/.test(locateBlock), "falls back to postcodes.io for the postcode");

  // Nominatim's free service has conditions. Breaking them gets Trey blocked.
  t.ok(/User-Agent/.test(locateBlock), "sends an identifying User-Agent, as Nominatim requires");
  t.ok(/trey\.today/.test(locateBlock), "…and it identifies Trey specifically");
  const rate = locateBlock.match(/RATE_MS\s*=\s*(\d+)/);
  t.ok(!!rate, "a rate limit constant exists");
  t.ok(rate && Number(rate[1]) >= 1000,
    `the rate limit is ${rate ? rate[1] : "?"}ms — at or above Nominatim's 1 request/second`);
  t.ok(/await sleep\(RATE_MS\)/.test(locateBlock), "…and it is actually awaited between calls");
  t.ok(!/Promise\.all\(Array\.from\(\{ length: Math\.min\(CONCURRENCY/.test(locateBlock),
    "the worker pool is NOT used here — parallel calls would breach the usage policy");

  // Attribution is a licence condition for both sources.
  t.ok(/OpenStreetMap contributors/.test(nearby), "Nominatim attribution is present");
  t.ok(/Open Government Licence|postcodes\.io/.test(nearby), "postcodes.io attribution is present");

  // Provenance must be recorded, or the expiry rule below has nothing to key on.
  t.ok(/geoSource: "address"/.test(locateBlock), 'an address hit is labelled geoSource "address"');
  t.ok(/geoSource: "postcode"/.test(locateBlock), 'a centroid fallback is labelled "postcode"');

  // Nothing may vanish silently — the house defect.
  t.ok(/failed\.push\(\{ id: it\.id, reason:/.test(locateBlock),
    "an unresolvable lead is returned with a reason, not dropped");
  t.ok(/notAttempted/.test(locateBlock), "leads not reached before the deadline are reported");

  // === expiry now depends on provenance =====================================
  // Lift the real functions out of leads.js and run them. leads.js requires
  // @netlify/blobs, which isn't installed here, so it can't just be required.
  const srcOpen = leads.match(/const OPEN_GEO_SOURCES = \[[^\]]*\];/);
  const srcMax = leads.match(/const GEO_MAX_AGE_DAYS = \d+;/);
  const srcFn = leads.match(/function geoExpired\(lead, now\) \{[\s\S]*?\n\}/);
  t.ok(!!(srcOpen && srcMax && srcFn), "geoExpired and its constants can be lifted from leads.js");

  const geoExpired = eval(`(function(){ ${srcMax[0]} ${srcOpen[0]} ${srcFn[0]} return geoExpired; })()`);
  const NOW = Date.parse("2026-08-17T00:00:00Z");
  const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

  // Open data has no caching restriction. It must survive indefinitely — the
  // whole point of the change is not re-geocoding the list every month.
  for (const src of ["address", "postcode"]) {
    t.ok(geoExpired({ lat: 1, lng: 1, geoSource: src, geoAt: daysAgo(1) }, NOW) === false,
      `a 1-day-old "${src}" coordinate is kept`);
    t.ok(geoExpired({ lat: 1, lng: 1, geoSource: src, geoAt: daysAgo(400) }, NOW) === false,
      `a 400-day-old "${src}" coordinate is STILL kept — open data does not expire`);
    t.ok(geoExpired({ lat: 1, lng: 1, geoSource: src }, NOW) === false,
      `a "${src}" coordinate with no timestamp is kept`);
  }

  // Google-derived coordinates keep the 30-day rule exactly as before.
  t.ok(geoExpired({ lat: 1, lng: 1, geoSource: "places", geoAt: daysAgo(29) }, NOW) === false,
    "a 29-day-old Google coordinate is kept");
  t.ok(geoExpired({ lat: 1, lng: 1, geoSource: "places", geoAt: daysAgo(31) }, NOW) === true,
    "a 31-day-old Google coordinate expires");

  // Fail safe: unknown provenance is treated as Google's.
  t.ok(geoExpired({ lat: 1, lng: 1, geoAt: daysAgo(31) }, NOW) === true,
    "a legacy record with NO geoSource expires at 30 days — unknown provenance fails safe");
  t.ok(geoExpired({ lat: 1, lng: 1, geoSource: "somethingelse", geoAt: daysAgo(31) }, NOW) === true,
    "an unrecognised geoSource also fails safe");

  // A lead with no coordinates has nothing to expire.
  t.ok(geoExpired({ geoSource: "places" }, NOW) === false, "no coordinates means nothing to expire");
  t.ok(geoExpired(null, NOW) === false, "a null lead does not throw");

  // stripGeo must clear the label too, or a re-geocode inherits a stale one.
  t.ok(/delete out\.geoSource/.test(leads), "stripGeo clears geoSource along with the coordinates");

  // === live Places results get no Leaflet map ===============================
  t.ok(/POOL_IS_LIVE/.test(go), "go.html tracks whether the current list is live Google data");
  t.ok(/if\(POOL_IS_LIVE\)\{/.test(go), "…and drawMap branches on it");
  t.ok(/No map on live Google results/.test(go), "…showing a plain explanation instead of a blank space");
  // Matched loosely: the quote is wrapped across comment lines, so a single
  // literal wouldn't survive a reflow. What matters is that the clause and its
  // source are both cited near the code.
  t.ok(/must not use[\s\S]{0,40}Google Maps Content/.test(go) && /§10\.2/.test(go),
    "the terms clause and its section number are quoted in the source, so nobody 'fixes' the missing map");

  // The mirror paths must KEEP their map — they show Apify data, which is fine.
  t.ok(/POOL_IS_LIVE=false/.test(go), "the saved-lead paths mark themselves as not live");
  const falseCount = (go.match(/POOL_IS_LIVE=false;/g) || []).length;
  const trueCount = (go.match(/POOL_IS_LIVE=true;/g) || []).length;
  t.ok(falseCount >= 2, `both mirror paths clear the flag (${falseCount} found)`);
  t.ok(trueCount >= 2, `both live-search paths set it (${trueCount} found)`);

  // === the leads map still may not receive Places data ======================
  // leads.html draws saved leads only; there is no live Places call in it.
  const leadsHtml = read("leads.html");
  t.ok(!/places\.googleapis\.com/.test(leadsHtml), "leads.html never calls Places directly");
  t.ok(!/X-Goog-Api-Key/.test(leadsHtml), "…and holds no Google API key");
};
