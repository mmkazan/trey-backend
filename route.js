/* Trey — planning a walk.
 *
 * WHY THIS ISN'T JUST "SHORTEST ROUTE"
 * ------------------------------------
 * The obvious ask is a shortest path through every pin — the Travelling
 * Salesman Problem. But that is not the job. You are not going to knock on all
 * forty doors on a street; you have two hours between other things, and you
 * want the best two hours available. Solving TSP perfectly would hand you an
 * efficient route through a lot of doors that were never worth walking to.
 *
 * So this solves the ORIENTEERING problem instead: given a time budget, pick
 * the subset of doors worth visiting AND the order to visit them in. Score is
 * the prize, time is the constraint. A Tier 1 lead two streets away can beat
 * three Tier 3 leads next door, and the maths says so rather than you guessing.
 *
 * WHY NO API
 * ----------
 * Google's Directions API can optimise waypoints, but it costs per call, caps
 * at 25 waypoints, and needs signal. go.html is deliberately offline-first —
 * there is an offline cache and a write queue precisely because a walk happens
 * in places with no bars. A router that stops working on a dead street is worse
 * than a slightly rougher one that always works. Everything here is arithmetic
 * in the browser: no key, no network, no cost, runs in milliseconds.
 *
 * ACCURACY, HONESTLY
 * ------------------
 * Distances are crow-flies (haversine) multiplied by a detour factor, because
 * you cannot walk through buildings. That is good enough to ORDER stops — on a
 * high street the ordering from straight-line distance is almost always the
 * ordering you would pick by eye — but the time estimate is an estimate. It is
 * deliberately pessimistic rather than optimistic: a walk that overruns is
 * worse than one that finishes early.
 */
(function (root) {
  "use strict";

  // Straight-line metres between two {lat,lng}.
  function haversine(a, b) {
    if (!a || !b) return Infinity;
    var R = 6371000;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(b.lat - a.lat);
    var dLng = toRad(b.lng - a.lng);
    var la1 = toRad(a.lat), la2 = toRad(b.lat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  var DEFAULTS = {
    // Streets are not straight lines. 1.35 is a common urban rule of thumb for
    // walking distance against crow-flies; it errs long on purpose.
    detourFactor: 1.35,
    // 1.3 m/s ≈ 4.7 km/h. Average adult walking pace, not a brisk one, because
    // you are carrying stands and stopping to look at shopfronts.
    walkSpeedMps: 1.3,
    // Five minutes a door. A real conversation with an owner is longer, but
    // most doors are "he's not in, come back Tuesday". Tune from the walk log
    // once there IS a walk log — this is the number the whole runner model
    // eventually calibrates against.
    dwellSeconds: 300,
    // Beyond this, the walk is a drive. Used to refuse silly plans rather than
    // quietly producing one.
    maxLegMetres: 1500,
  };

  function walkSeconds(metres, opt) {
    return (metres * opt.detourFactor) / opt.walkSpeedMps;
  }

  // Total seconds for an ordered list of stops starting from `start`.
  function tourSeconds(start, stops, opt) {
    var t = 0, prev = start;
    for (var i = 0; i < stops.length; i++) {
      t += walkSeconds(haversine(prev, stops[i]), opt) + opt.dwellSeconds;
      prev = stops[i];
    }
    return t;
  }

  /* 2-opt: repeatedly reverse a segment of the tour if doing so shortens it.
   * Cheap, deterministic, and gets a nearest-neighbour tour most of the way to
   * optimal. Bounded iterations so a pathological input can't spin the phone.
   */
  function twoOpt(start, stops, opt, maxPasses) {
    if (stops.length < 4) return stops;
    var best = stops.slice();
    var bestT = tourSeconds(start, best, opt);
    var passes = 0;
    var improved = true;
    while (improved && passes < (maxPasses || 40)) {
      improved = false;
      passes++;
      for (var i = 0; i < best.length - 1; i++) {
        for (var j = i + 1; j < best.length; j++) {
          var cand = best.slice(0, i)
            .concat(best.slice(i, j + 1).reverse())
            .concat(best.slice(j + 1));
          var t = tourSeconds(start, cand, opt);
          if (t < bestT - 0.5) { best = cand; bestT = t; improved = true; }
        }
      }
    }
    return best;
  }

  /* Cheapest place to insert `lead` into `stops`, as {index, addedSeconds}. */
  function bestInsertion(start, stops, lead, opt) {
    var base = tourSeconds(start, stops, opt);
    var bestIdx = 0, bestAdd = Infinity;
    for (var i = 0; i <= stops.length; i++) {
      var cand = stops.slice(0, i).concat([lead], stops.slice(i));
      var add = tourSeconds(start, cand, opt) - base;
      if (add < bestAdd) { bestAdd = add; bestIdx = i; }
    }
    return { index: bestIdx, addedSeconds: bestAdd };
  }

  /**
   * Plan a walk.
   *
   * @param start   {lat,lng} — where you are standing (or the first door).
   * @param leads   [{lat,lng,score,...}] — candidates. Anything without usable
   *                coordinates is returned in `skipped`, never silently dropped.
   * @param minutes time budget, including talking time.
   * @param options overrides for DEFAULTS, plus:
   *                  outward  — restrict to one outward postcode ("DE1")
   *                  minScore — ignore leads below this prospect score
   *
   * @returns {stops, order, totalMinutes, walkMinutes, dwellMinutes,
   *           distanceMetres, totalScore, considered, skipped, dropped}
   */
  function planWalk(start, leads, minutes, options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = DEFAULTS[k];
    if (options) for (var k2 in options) if (options[k2] != null) opt[k2] = options[k2];

    var budget = Math.max(0, Number(minutes) || 0) * 60;
    var skipped = [];
    var candidates = [];

    for (var i = 0; i < (leads || []).length; i++) {
      var l = leads[i];
      var lat = Number(l && l.lat), lng = Number(l && l.lng);
      if (!isFinite(lat) || !isFinite(lng)) {
        // Coordinates expire after 30 days by design (Maps Platform terms), so
        // a lead with none is normal, not broken. Say so rather than vanishing.
        skipped.push({ lead: l, reason: "no coordinates" });
        continue;
      }
      if (opt.outward && String(l.outward || "").toUpperCase() !== String(opt.outward).toUpperCase()) {
        skipped.push({ lead: l, reason: "different postcode area" });
        continue;
      }
      if (opt.minScore != null && Number(l.score || 0) < opt.minScore) {
        skipped.push({ lead: l, reason: "below minimum score" });
        continue;
      }
      candidates.push({
        lat: lat, lng: lng,
        score: Number(l.score || 0),
        lead: l,
      });
    }

    /* GREEDY RATIO INSERTION.
     * Repeatedly add whichever remaining lead gives the most score per second
     * of time it costs to fit in. Score-per-second, not score — a slightly
     * worse door on the way beats a slightly better one down a side street,
     * which is exactly the judgement you would make on foot. */
    var stops = [];
    var used = {};
    var guard = 0;
    while (guard++ < 500) {
      var bestRatio = -1, bestPick = null;
      for (var c = 0; c < candidates.length; c++) {
        if (used[c]) continue;
        var ins = bestInsertion(start, stops, candidates[c], opt);
        if (tourSeconds(start, stops, opt) + ins.addedSeconds > budget) continue;
        // A leg longer than maxLegMetres isn't a walk any more.
        var prev = ins.index === 0 ? start : stops[ins.index - 1];
        if (haversine(prev, candidates[c]) > opt.maxLegMetres) continue;
        var ratio = candidates[c].score / Math.max(1, ins.addedSeconds);
        if (ratio > bestRatio) { bestRatio = ratio; bestPick = { c: c, ins: ins }; }
      }
      if (!bestPick) break;
      stops.splice(bestPick.ins.index, 0, candidates[bestPick.c]);
      used[bestPick.c] = true;
    }

    // Tidy the order now the set is settled. 2-opt can only shorten it, so it
    // can never push the plan over budget.
    stops = twoOpt(start, stops, opt);

    var walkSecs = 0, dist = 0, prevP = start, totalScore = 0;
    for (var s = 0; s < stops.length; s++) {
      var d = haversine(prevP, stops[s]);
      dist += d * opt.detourFactor;
      walkSecs += walkSeconds(d, opt);
      totalScore += stops[s].score;
      prevP = stops[s];
    }
    var dwellSecs = stops.length * opt.dwellSeconds;

    var dropped = [];
    for (var u = 0; u < candidates.length; u++) if (!used[u]) dropped.push(candidates[u].lead);

    return {
      stops: stops.map(function (s) { return s.lead; }),
      order: stops.map(function (s, idx) { return { n: idx + 1, lead: s.lead, lat: s.lat, lng: s.lng }; }),
      totalMinutes: Math.round((walkSecs + dwellSecs) / 60),
      walkMinutes: Math.round(walkSecs / 60),
      dwellMinutes: Math.round(dwellSecs / 60),
      distanceMetres: Math.round(dist),
      totalScore: Math.round(totalScore),
      considered: candidates.length,
      skipped: skipped,
      dropped: dropped,
      options: opt,
    };
  }

  var api = {
    haversine: haversine,
    planWalk: planWalk,
    tourSeconds: tourSeconds,
    twoOpt: twoOpt,
    DEFAULTS: DEFAULTS,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TreyRoute = api;
})(typeof self !== "undefined" ? self : this);
