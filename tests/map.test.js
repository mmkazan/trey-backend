// The maps: Leaflet + OpenStreetMap, replacing the Google Static Maps picture.
//
// These are source assertions rather than browser tests, because there is no
// browser and no build step here — but the things they check are the things
// that actually broke, or would break silently:
//
//   - a wrong or missing SRI hash means the browser refuses the file and the
//     map is simply blank, with nothing in the console that says why;
//   - a floating version ("latest") means a CDN update breaks that hash;
//   - the OSM attribution is a LICENCE CONDITION, so losing it is a legal
//     problem, not a cosmetic one;
//   - the two maps sharing one colour vocabulary was a deliberate earlier fix
//     that a later edit to only one file would quietly undo;
//   - and a file loaded but unused is the exact dead-code class this repo has
//     been clearing out.

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Pull a function out of an HTML file by brace matching, so it can be run for
// real rather than pattern-matched. Same technique as xss-and-storage.test.js.
function grabFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return "";
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return "";
}

// Lift a top-level declaration verbatim ("const TIER_COLOURS = {...};").
function grabDecl(src, name) {
  const m = src.match(new RegExp("(?:const|let|var)\\s+" + name + "\\s*=\\s*[^;]+;"));
  return m ? m[0] : "";
}

// Build a callable from lifted declarations + a lifted function.
function build(decls, fnSrc, name) {
  return eval("(function(){ " + decls.join("\n") + "\n" + fnSrc + "\n return " + name + "; })()");
}

exports.run = function (t) {
  const leads = read("leads.html");
  const go = read("go.html");
  const pages = { "leads.html": leads, "go.html": go };

  // === Leaflet is loaded, pinned, and integrity-checked =====================
  const LEAFLET_VERSION = "1.9.4";

  for (const [name, src] of Object.entries(pages)) {
    const css = src.match(/<link[^>]+leaflet[^>]*\.css[^>]*>/i);
    const js = src.match(/<script[^>]+libs\/leaflet\/[^>]*\.js[^>]*>/i);
    t.ok(!!css, `${name} loads the Leaflet stylesheet`);
    t.ok(!!js, `${name} loads the Leaflet script`);

    for (const [tag, label] of [[css && css[0], "CSS"], [js && js[0], "JS"]]) {
      const s = tag || "";
      t.ok(/cdnjs\.cloudflare\.com/.test(s), `${name} Leaflet ${label} comes from cdnjs`);
      t.ok(new RegExp("libs/leaflet/" + LEAFLET_VERSION.replace(/\./g, "\\.") + "/").test(s),
        `${name} Leaflet ${label} pins version ${LEAFLET_VERSION}`);
      t.ok(!/\/(latest|master|main)\//.test(s),
        `${name} Leaflet ${label} does not float on a moving version`);
      // A base64 SHA of the right length. A truncated or mistyped hash is the
      // failure mode here and it is completely silent in the browser.
      const integrity = s.match(/integrity="(sha(?:256|384|512))-([A-Za-z0-9+/=]+)"/);
      t.ok(!!integrity, `${name} Leaflet ${label} carries an integrity hash`);
      if (integrity) {
        const bytes = Buffer.from(integrity[2], "base64").length;
        const want = { sha256: 32, sha384: 48, sha512: 64 }[integrity[1]];
        t.eq(bytes, want, `${name} Leaflet ${label} integrity is a full ${integrity[1]} digest`);
      }
      t.ok(/crossorigin="anonymous"/.test(s),
        `${name} Leaflet ${label} sets crossorigin="anonymous" (SRI is ignored without it)`);
    }
  }

  // Both pages must be on the SAME Leaflet, or one of them is running code the
  // other was never tested against.
  const ver = (s) => (s.match(/libs\/leaflet\/([0-9.]+)\//) || [])[1];
  t.eq(ver(leads), ver(go), "both pages load the same pinned Leaflet version");

  // The integrity value for a given file must be the same in both pages too —
  // two different hashes for one URL means at least one of them is wrong.
  const hashFor = (s, ext) => (s.match(new RegExp('leaflet/[0-9.]+/leaflet\\.' + ext + '"[^>]*integrity="([^"]+)"')) || [])[1];
  t.eq(hashFor(leads, "css"), hashFor(go, "css"), "the Leaflet CSS hash agrees across both pages");
  t.eq(hashFor(leads, "js"), hashFor(go, "js"), "the Leaflet JS hash agrees across both pages");

  // === OSM attribution — a licence condition, not a nicety =================
  const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  for (const [name, src] of Object.entries(pages)) {
    t.ok(src.includes(ATTRIB), `${name} carries the exact OpenStreetMap attribution string`);
    t.ok(/L\.tileLayer\(/.test(src), `${name} builds a real tile layer`);
    t.ok(/attribution\s*:\s*OSM_ATTRIB/.test(src),
      `${name} passes that attribution to the tile layer, not just to a comment`);
    t.ok(/tile\.openstreetmap\.org/.test(src), `${name} uses OpenStreetMap tiles`);
    // So nobody has to rediscover the upgrade path when usage grows.
    t.ok(/MapTiler|Protomaps/.test(src),
      `${name} records the paid-tile-host upgrade path for when volume grows`);
  }

  // === The static map is no longer requested ===============================
  // The server capability stays — we just stop asking for it.
  for (const [name, src] of Object.entries(pages)) {
    t.ok(!/action\s*:\s*["']basemap["']/.test(src),
      `${name} no longer calls the basemap action`);
    t.ok(/includeMap\s*:\s*false/.test(src),
      `${name} tells nearby.js not to build a Static Maps picture`);
    t.ok(!/\bd\.map\b/.test(src), `${name} no longer reads the static map out of the response`);
    t.ok(!/TreyMap\b/.test(src), `${name} no longer uses the old projection helper`);
  }
  // Every POST to nearby.js that runs a search must carry the flag — one that
  // forgets it silently spends a Static Maps call per search.
  for (const [name, src] of Object.entries(pages)) {
    const searches = src.match(/api\(\{[^}]*\}\)|JSON\.stringify\(\{\s*where:[^}]*\}/g) || [];
    for (const s of searches) {
      if (!/radius/.test(s)) continue;
      t.ok(/includeMap\s*:\s*false/.test(s),
        `${name}: every nearby.js search opts out of the static map`);
    }
  }
  // ...but the server can still build one. Leaving the capability intact and
  // unrequested is deliberate; deleting it is a separate decision.
  const nearby = fs.readFileSync(path.join(ROOT, "netlify", "functions", "nearby.js"), "utf8");
  t.ok(/async function staticMap\(/.test(nearby),
    "nearby.js still has staticMap() — the server capability was left intact");

  // === One colour vocabulary across both maps ==============================
  // Green = best door, amber = worth a look, grey = skip. This was a deliberate
  // fix: two maps using one palette for two different things was misread once
  // already, so the mapping is asserted identical rather than trusted.
  const tiersLeads = eval("(" + (leads.match(/TIER_COLOURS\s*=\s*(\{[^}]*\})/) || [])[1] + ")");
  const tiersGo = eval("(" + (go.match(/TIER_COLOURS\s*=\s*(\{[^}]*\})/) || [])[1] + ")");
  t.eq(tiersLeads, tiersGo, "the tier colours are byte-identical in leads.html and go.html");
  t.eq(tiersLeads, { "1": "#047857", "2": "#b45309", "3": "#64748b" },
    "tier 1 is green, tier 2 amber, tier 3 grey");

  const statusLeads = eval("(" + (leads.match(/STATUS_COLOURS\s*=\s*(\{[^}]*\})/) || [])[1] + ")");
  const statusGo = eval("(" + (go.match(/STATUS_COLOURS\s*=\s*(\{[^}]*\})/) || [])[1] + ")");
  t.eq(statusLeads, statusGo, "the status colours are byte-identical in leads.html and go.html");

  // Behavioural, not textual: run each page's own colour function.
  const pinColour = build(
    ["let COLOUR_BY = \"tier\";",
     grabDecl(leads, "TIER_COLOURS"), grabDecl(leads, "STATUS_COLOURS"),
     grabDecl(leads, "MINE_COLOUR"), grabDecl(leads, "LOST_COLOUR")],
    grabFn(leads, "pinColour"), "pinColour");
  t.eq(pinColour({ tier: 1 }), tiersLeads["1"], "leads.html paints a Tier 1 lead green");
  t.eq(pinColour({ tier: 2 }), tiersLeads["2"], "leads.html paints a Tier 2 lead amber");
  t.eq(pinColour({ tier: 3 }), tiersLeads["3"], "leads.html paints a Tier 3 lead grey");
  t.eq(pinColour({}), tiersLeads["3"], "a lead with no tier falls back to grey, not to green");
  t.ok(pinColour({ tier: 1, isClient: true }) !== tiersLeads["1"],
    "an existing customer is not shown as a door to knock on");

  const bandColourGo = build([grabDecl(go, "TIER_COLOURS")], grabFn(go, "bandColour"), "bandColour");
  t.eq(bandColourGo("Knock now"), tiersGo["1"], "go.html paints 'Knock now' the Tier 1 green");
  t.eq(bandColourGo("Worth a look"), tiersGo["2"], "go.html paints 'Worth a look' the Tier 2 amber");
  t.eq(bandColourGo("Skip"), tiersGo["3"], "go.html paints 'Skip' the Tier 3 grey");
  // The point of the whole exercise: one colour, one meaning, on both screens.
  t.eq(bandColourGo("Knock now"), pinColour({ tier: 1 }),
    "green means the same thing on the desk map and the field map");
  t.eq(bandColourGo("Skip"), pinColour({ tier: 3 }),
    "grey means the same thing on the desk map and the field map");

  // === Every colour that carries text is readable ==========================
  // Tier 3 was #94a3b8 and the number sitting on it scored 2.56:1 — below the
  // 4.5:1 floor and, on a phone in daylight, simply not there. Recomputed here
  // rather than asserted as a hex, so the next person to reach for a nicer
  // grey is stopped by the actual rule and not by a magic number.
  function contrast(hex, other) {
    const lum = (h) => {
      h = h.replace("#", "");
      const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * lin(parseInt(h.slice(0, 2), 16))
           + 0.7152 * lin(parseInt(h.slice(2, 4), 16))
           + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
    };
    const a = lum(hex), b = lum(other);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  // Sanity-check the maths itself against two known pairs before trusting it.
  t.ok(Math.abs(contrast("#ffffff", "#000000") - 21) < 0.01, "contrast() gives 21:1 for black on white");
  t.ok(Math.abs(contrast("#ffffff", "#ffffff") - 1) < 0.01, "contrast() gives 1:1 for white on white");

  const WHITE = "#ffffff";
  for (const [k, v] of Object.entries(tiersLeads)) {
    t.ok(contrast(v, WHITE) >= 4.5,
      `tier ${k} (${v}) carries white text at AA — got ${contrast(v, WHITE).toFixed(2)}:1`);
  }
  for (const [k, v] of Object.entries(statusLeads)) {
    t.ok(contrast(v, WHITE) >= 4.5,
      `status "${k}" (${v}) carries white text at AA — got ${contrast(v, WHITE).toFixed(2)}:1`);
  }
  const mine = grabDecl(leads, "MINE_COLOUR").match(/#[0-9a-f]{6}/i)[0];
  t.ok(contrast(mine, WHITE) >= 4.5, `MINE_COLOUR (${mine}) carries white text at AA`);

  // The Opportunity pill and the Trey Score badge are white text on a computed
  // background, so their band colours are held to the same floor.
  for (const [fn, label] of [["prospectScore", "Opportunity pill"],
                             ["treyScore", "Trey Score badge"],
                             ["opportunityScore", "Opportunity fallback"]]) {
    // Comments get stripped first. These functions carry a note about the
    // colours they REPLACED, and a check that reads prose finds the old value
    // and fails on a file that is actually correct.
    const body = grabFn(leads, fn)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const hexes = (body.match(/#[0-9a-f]{6}/gi) || []);
    t.ok(hexes.length > 0, `${label}: found band colours to check`);
    for (const h of hexes) {
      t.ok(contrast(h, WHITE) >= 4.5,
        `${label} colour ${h} carries white text at AA — got ${contrast(h, WHITE).toFixed(2)}:1`);
    }
  }

  // === textOn() — no disc can render an unreadable number ==================
  // The numbered stop discs take the LEAD's colour now, and one of those is
  // LOST_COLOUR, a faded grey that renders white text at 1.35:1. Rather than
  // hand-pick a text colour per palette entry, the disc works it out.
  for (const [name, src] of Object.entries(pages)) {
    const textOn = build([], grabFn(src, "textOn"), "textOn");
    t.ok(!!textOn, `${name} has textOn()`);
    t.eq(textOn("#0f172a"), "#fff", `${name}: textOn picks white on near-black`);
    t.eq(textOn("#ffffff"), "#0f172a", `${name}: textOn picks dark on white`);
    t.eq(textOn("#cbd5e1"), "#0f172a", `${name}: textOn picks dark on the faded Lost grey`);
    t.eq(textOn("#047857"), "#fff", `${name}: textOn picks white on the tier-1 green`);
    t.eq(textOn(undefined), "#fff", `${name}: textOn falls back to white on junk input`);
    t.eq(textOn("nonsense"), "#fff", `${name}: textOn falls back to white on a non-hex string`);
    // The property that matters: whatever it picks must actually be readable.
    for (const c of [].concat(Object.values(tiersLeads), Object.values(statusLeads),
                              [mine, "#cbd5e1", "#0f172a", "#ffffff"])) {
      t.ok(contrast(c, textOn(c) === "#fff" ? "#ffffff" : "#0f172a") >= 4.5,
        `${name}: textOn(${c}) is readable on it`);
    }
    // …and it is actually wired into the marker, not just defined.
    t.ok(/textOn\(colour\)/.test(src), `${name}: discIcon applies textOn to the disc`);
  }

  // === The desk and the phone draw a planned walk the same way =============
  // The desk used to paint every route stop MINE_COLOUR — the legend's "already
  // yours" — so a planned walk looked like a list of existing customers, and
  // the two screens disagreed about the same walk.
  t.ok(!/discIcon\(MINE_COLOUR,\s*s\.n/.test(leads),
    "leads.html no longer paints route stops in the 'already yours' colour");
  t.ok(/discIcon\(pinColour\(s\.lead\.lead\),\s*s\.n/.test(leads),
    "leads.html colours a route stop by the lead's own tier/status, like go.html");
  t.ok(/class="walkn"[^>]*background:'\s*\+\s*esc\(c\)/.test(leads),
    "the stop-number disc beside each card takes the same colour as its pin");
  t.ok(!/\.walkn\{[^}]*background:var\(--accent\)[^}]*\}\s*$/m.test(leads) || /pinColour\(l\)/.test(leads),
    "the stop-number disc is no longer hardcoded indigo");

  // === The stop cards are not inside the summary panel =====================
  // The .walkstops list used to be nested inside .walkbox. .walkbox sets
  // color:#3730a3 for its own summary text and `.walkbox b{color:#312e81}` for
  // its own numbers, and both inherited into the lead cards rendered inside it:
  // every business name went indigo, and because `.walkbox b` and `.opp b` have
  // EQUAL specificity — so source order decides, and .walkbox b is declared
  // later — the Opportunity score rendered dark navy on the green pill while
  // the band label beside it stayed white. It read as a badge bug for two
  // sessions. It was a containment bug. Assert the structure, because the
  // symptom is three inheritance hops away from the cause.
  //
  // Reconstruct the markup this code EMITS — every single-quoted literal in the
  // walkOut assignment, in order, comments stripped — then walk the tags and
  // ask how deep .walkstops sits relative to .walkbox. An earlier version of
  // this check looked for the next "'</div>' +" after the summary text and
  // "passed" on the broken file too: it had found the .mapnote's closing tag,
  // not the walkbox's. A guard that cannot fail is not a guard.
  {
    const fnStart = leads.indexOf('walkOut").innerHTML');
    const fnEnd = leads.indexOf("\n  }", fnStart);
    const src = leads.slice(fnStart, fnEnd)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    // Single-quoted literals only; \' escapes are not used for tags here.
    const emitted = (src.match(/'(?:[^'\\]|\\.)*'/g) || [])
      .map((s) => s.slice(1, -1)).join("");
    const tags = emitted.match(/<\/?div\b[^>]*>/g) || [];
    let depth = 0, boxDepth = null, stopsDepth = null;
    for (const tag of tags) {
      if (tag.startsWith("</")) { depth--; continue; }
      if (/class="walkbox"/.test(tag) && boxDepth === null) boxDepth = depth;
      if (/class="walkstops"/.test(tag) && stopsDepth === null) stopsDepth = depth;
      depth++;
    }
    t.ok(boxDepth !== null, "the walk output still renders a .walkbox summary panel");
    t.ok(stopsDepth !== null, "the walk output still renders a .walkstops list");
    t.ok(stopsDepth !== null && boxDepth !== null && stopsDepth <= boxDepth,
      `.walkstops is a SIBLING of .walkbox, not nested inside it ` +
      `(walkbox depth ${boxDepth}, walkstops depth ${stopsDepth}) — nested, .walkbox's ` +
      `colour and its 'b' rule inherit into every lead card`);
    t.eq(depth, 0, "the walk output's div tags balance");
  }
  // Belt and braces: whatever the markup does, .walkbox must not be styling
  // bold text that lead cards also use.
  t.ok(/\.walkbox b\{/.test(leads), "the .walkbox b rule still exists (it styles the summary)");
  t.ok(/\.opp b\{/.test(leads), "…and .opp b still exists, which is the rule it used to beat");

  // === The planning map stays on screen while you read the stops ===========
  // Planning a walk used to insert the stop cards ABOVE the map and push it out
  // of view: you could read the plan or see the route, never both.
  t.ok(/\.mapstick\{[^}]*position:sticky/.test(leads),
    "leads.html has a sticky container for the planning map");
  t.ok(leads.indexOf('class="mapstick"') < leads.indexOf('id="walkOut"'),
    "the map is rendered before the walk stops, so sticky has somewhere to stick");
  t.ok(/\.mapstick \.leafmap\{height:min\(/.test(leads),
    "the sticky map is capped in vh as well as px, leaving room for a stop card");
  // A container whose height depends on the viewport must tell Leaflet when the
  // viewport changes, or you get a grey band that looks like a tile failure.
  t.ok(/addEventListener\("resize"[\s\S]{0,220}invalidateSize\(\)/.test(leads),
    "leads.html re-measures the map on window resize");

  // === go.html stays usable with no signal =================================
  t.ok(go.includes("No map — you're offline. Your leads and the list still work."),
    "go.html has an honest inline message for when tiles can't load");
  t.ok(/tileerror/.test(go), "go.html notices a failed tile fetch");
  t.ok(/tileload/.test(go), "go.html clears the offline message once a tile loads again");
  // Consistency with the file's existing failure channel.
  t.ok(/MAPERR\s*=\s*OFFLINE_MAP_MSG/.test(go),
    "the tile failure is surfaced through the same MAPERR channel as every other map failure");
  t.ok(/function showMapErr\(/.test(go) && /onclick="retryTiles\(\)"/.test(go),
    "…and offers a Try again, matching the pattern the page already used");
  // A failed map must never take the list with it.
  t.ok(!/mapErr[\s\S]{0,200}#out/.test(go), "the map error does not live inside the list container");
  t.ok(/id="mapBox"/.test(go) && /id="out"/.test(go),
    "the map and the list are separate boxes, so one cannot blank the other");
  t.ok(/treyLeadCache/.test(go), "REGRESSION: the offline lead cache is still there");
  t.ok(/treyQueue/.test(go), "REGRESSION: the offline write queue is still there");

  // === The walk planner is wired into the desk map =========================
  t.ok(/<script src="\/route\.js"><\/script>/.test(leads),
    "leads.html loads route.js the same way map-pins.js used to be loaded");
  t.ok(fs.existsSync(path.join(ROOT, "route.js")), "route.js exists to be loaded");
  t.ok(/TreyRoute\.planWalk\(/.test(leads), "leads.html calls the planner");
  t.ok(/id="walkMins"/.test(leads), "there is a time-budget input");
  t.ok(/value="120"/.test(leads), "…defaulting to 120 minutes");
  t.ok(/onclick="planWalk\(\)"/.test(leads), "there is a Plan walk button");
  t.ok(/onclick="clearWalk\(\)"/.test(leads), "…and a way back to the plain map");
  t.ok(/L\.polyline\(/.test(leads), "the route is drawn as a polyline");
  t.ok(/plan\.order\.forEach/.test(leads), "…with a marker per stop, in visit order");
  // The summary the planner returns, all of it.
  for (const field of ["totalMinutes", "walkMinutes", "distanceMetres", "totalScore"]) {
    t.ok(new RegExp("plan\\." + field).test(leads), `the summary reports ${field}`);
  }
  // Silently dropping leads is the failure mode this codebase keeps hitting.
  t.ok(/plan\.dropped\.length/.test(leads), "what didn't fit the budget is reported, not hidden");
  t.ok(/plan\.skipped\.length/.test(leads), "what couldn't be planned at all is reported too");
  t.ok(/s\.reason/.test(leads), "…with the planner's own reasons, not a guess");

  // === map-pins.js: gone and unreferenced, or present and used =============
  // Never one without the other — a file loaded but unused is dead weight, and
  // a file referenced but missing is a 404 and a broken page.
  const pinsPath = path.join(ROOT, "map-pins.js");
  const exists = fs.existsSync(pinsPath);
  const referenced = Object.values(pages).some(
    (s) => /<script src="\/map-pins\.js"><\/script>/.test(s) || /TreyMap\b/.test(s));
  t.eq(exists, referenced,
    exists ? "map-pins.js is still present, so something must still use it"
           : "map-pins.js is deleted, and nothing references it");
  t.ok(!exists, "map-pins.js is gone — Leaflet does the projection now");

  // === The maps are real, interactive maps =================================
  for (const [name, src] of Object.entries(pages)) {
    t.ok(/L\.map\(/.test(src), `${name} creates a Leaflet map`);
    t.ok(/scrollWheelZoom\s*:\s*true/.test(src), `${name} allows scroll-wheel zoom`);
    t.ok(/fitBounds\(/.test(src), `${name} frames the current set of pins`);
    t.ok(/invalidateSize\(\)/.test(src),
      `${name} tells Leaflet its size after being un-hidden (or it paints one tile in a corner)`);
    // The whole map lives in a stacking context of its own, or its panes paint
    // over the page's own fixed overlays.
    t.ok(/\.leafmap\{[^}]*z-index:0/.test(src),
      `${name} keeps Leaflet's z-index 400-1000 panes inside their own stacking context`);
    t.ok(!/\.pin\{[^}]*position:absolute/.test(src),
      `${name} no longer positions pins itself — that is Leaflet's job now`);
  }

  // Markers must stay in step with the filter and the sort.
  t.ok(/drawMap\(view,\s*list\)/.test(go), "go.html redraws markers from the filtered view");
  t.ok(/clearLayers\(\)/.test(go) && /clearLayers\(\)/.test(leads),
    "both pages clear the old markers before drawing the new set");
  t.ok(/drawMap\(\);/.test(leads), "leads.html redraws the map from render(), so filtering moves the pins");

  // Popups are built from lead data, which comes from an imported CSV. Every
  // value in them goes through esc() — see the C3 stored-XSS finding.
  for (const [name, src] of Object.entries(pages)) {
    const popup = grabFn(src, name === "go.html" ? "pinPopup" : "leadPopup");
    t.ok(popup.length > 0, `${name} has a popup builder`);
    const rendered = popup.match(/\+\s*(l|p|s)\.[A-Za-z.]+/g) || [];
    t.eq(rendered.filter((r) => !/^\+\s*[a-z]\.(lat|lng)$/.test(r)), [],
      `${name} interpolates no raw lead field into popup HTML — everything goes through esc()`);
  }
};
