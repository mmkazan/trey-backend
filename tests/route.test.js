// The walk planner. Real behaviour, not source-grepping — route.js is pure
// arithmetic with no dependencies, so it can just be required and run.

const path = require("path");
const R = require(path.join(__dirname, "..", "route.js"));

// A rough Derby city-centre grid. ~0.001 lat ≈ 111m, ~0.001 lng ≈ 70m at 52.9°N.
const DERBY = { lat: 52.9225, lng: -1.4746 };
function at(dLat, dLng, score, extra) {
  return Object.assign({ lat: DERBY.lat + dLat, lng: DERBY.lng + dLng, score: score }, extra || {});
}

exports.run = function (t) {
  // --- haversine sanity -----------------------------------------------------
  t.ok(R.haversine(DERBY, DERBY) === 0, "distance to self is zero");
  const km = R.haversine(DERBY, { lat: DERBY.lat + 0.009, lng: DERBY.lng });
  t.ok(km > 950 && km < 1050, "0.009° of latitude is about 1km");
  t.ok(R.haversine(null, DERBY) === Infinity, "missing point is infinitely far, not NaN");

  // --- the budget is a hard constraint --------------------------------------
  const many = [];
  for (let i = 0; i < 30; i++) many.push(at(0.0004 * i, 0.0004 * i, 50 + i));

  for (const mins of [10, 30, 60, 120]) {
    const p = R.planWalk(DERBY, many, mins);
    t.ok(p.totalMinutes <= mins,
      `a ${mins}-minute budget produces a plan of ${p.totalMinutes} minutes — never over`);
  }

  // More time must never mean fewer doors or less score.
  const short = R.planWalk(DERBY, many, 30);
  const long = R.planWalk(DERBY, many, 120);
  t.ok(long.stops.length >= short.stops.length, "a longer budget visits at least as many doors");
  t.ok(long.totalScore >= short.totalScore, "a longer budget collects at least as much score");

  // Zero budget is a real answer, not a crash.
  const none = R.planWalk(DERBY, many, 0);
  t.eq(none.stops.length, 0, "a zero budget plans no stops");
  t.eq(none.totalMinutes, 0, "…and takes no time");

  // --- score actually drives selection --------------------------------------
  // Two doors the same distance away, one worth far more. With room for only
  // one, it must pick the valuable one.
  const pair = [at(0.0009, 0, 10, { id: "cheap" }), at(-0.0009, 0, 95, { id: "rich" })];
  const one = R.planWalk(DERBY, pair, 7);
  t.eq(one.stops.length, 1, "a tight budget fits exactly one of two equidistant doors");
  t.eq(one.stops[0].id, "rich", "and it picks the higher-scoring one");

  // A high score down a long side street loses to a decent score on the way.
  const detour = [
    at(0.0002, 0.0002, 60, { id: "onTheWay" }),
    at(0.010, 0.010, 75, { id: "farAway" }),
  ];
  const p2 = R.planWalk(DERBY, detour, 12);
  t.ok(p2.stops.length >= 1 && p2.stops[0].id === "onTheWay",
    "score per minute wins: the near-enough door is taken before the distant better one");

  // --- ordering is sensible -------------------------------------------------
  // Four doors in a line, handed over shuffled. The plan should walk the line.
  const line = [
    at(0.0016, 0, 50, { id: "d" }), at(0.0004, 0, 50, { id: "a" }),
    at(0.0012, 0, 50, { id: "c" }), at(0.0008, 0, 50, { id: "b" }),
  ];
  const walked = R.planWalk(DERBY, line, 120).stops.map((s) => s.id);
  t.eq(walked, ["a", "b", "c", "d"], "four doors in a line are walked in order, not as given");

  // 2-opt must never make a tour worse.
  const pts = line.map((l) => ({ lat: l.lat, lng: l.lng, score: l.score }));
  const before = R.tourSeconds(DERBY, pts, R.DEFAULTS);
  const after = R.tourSeconds(DERBY, R.twoOpt(DERBY, pts, R.DEFAULTS), R.DEFAULTS);
  t.ok(after <= before + 0.001, "2-opt never lengthens a tour");

  // --- nothing disappears silently -----------------------------------------
  // The defect class this codebase keeps hitting. A lead that can't be planned
  // must be RETURNED with a reason, never quietly dropped.
  const mixed = [
    at(0.0004, 0, 50, { id: "ok" }),
    { id: "nogeo", score: 90 },
    { id: "badgeo", lat: "banana", lng: null, score: 90 },
  ];
  const p3 = R.planWalk(DERBY, mixed, 60);
  t.eq(p3.skipped.length, 2, "both un-plannable leads are reported");
  t.ok(p3.skipped.every((s) => s.reason === "no coordinates"), "…each with a reason");
  const accounted = p3.stops.length + p3.skipped.length + p3.dropped.length;
  t.eq(accounted, mixed.length, "every lead in equals a lead out — planned, skipped or dropped");

  // Same guarantee at scale, with a budget that forces drops.
  const p4 = R.planWalk(DERBY, many, 20);
  t.eq(p4.stops.length + p4.skipped.length + p4.dropped.length, many.length,
    "no lead is lost when the budget forces some to be dropped");

  // --- filters --------------------------------------------------------------
  const pc = [
    at(0.0004, 0, 50, { id: "in", outward: "DE1" }),
    at(0.0005, 0, 90, { id: "out", outward: "DE23" }),
  ];
  const p5 = R.planWalk(DERBY, pc, 60, { outward: "DE1" });
  t.eq(p5.stops.length, 1, "the postcode filter excludes other areas");
  t.eq(p5.stops[0].id, "in", "…keeping the right one even though it scores lower");
  t.eq(p5.skipped[0].reason, "different postcode area", "and says why the other went");

  const p6 = R.planWalk(DERBY, pc, 60, { minScore: 80 });
  t.eq(p6.stops.length, 1, "minScore excludes low scorers");
  t.eq(p6.stops[0].id, "out", "…keeping the high one");

  // A walk must stay a walk. A lead 5km away is a drive.
  const faraway = [at(0.045, 0.045, 99, { id: "another-town" })];
  const p7 = R.planWalk(DERBY, faraway, 600);
  t.eq(p7.stops.length, 0, "a door 5km away is refused however much time there is");
  t.eq(p7.dropped.length, 1, "…and reported as dropped, not skipped");

  // --- the time estimate is honest -----------------------------------------
  const p8 = R.planWalk(DERBY, line, 120);
  t.eq(p8.dwellMinutes, p8.stops.length * 5, "dwell time is 5 minutes per door");
  t.ok(p8.walkMinutes + p8.dwellMinutes === p8.totalMinutes ||
       Math.abs(p8.walkMinutes + p8.dwellMinutes - p8.totalMinutes) <= 1,
    "walking + talking adds up to the total (±1 for rounding)");
  // Distance must include the detour factor — crow-flies would understate it.
  const crow = R.haversine(DERBY, p8.stops[0]) ;
  t.ok(p8.distanceMetres > crow, "reported distance is longer than crow-flies (streets, not straight lines)");

  // --- determinism ----------------------------------------------------------
  const a1 = R.planWalk(DERBY, many, 45);
  const a2 = R.planWalk(DERBY, many, 45);
  t.eq(a1.stops.map((s) => s.score), a2.stops.map((s) => s.score),
    "the same inputs always give the same plan");

  // --- it has to be fast enough for a phone --------------------------------
  const big = [];
  for (let i = 0; i < 120; i++) big.push(at(0.0002 * (i % 12), 0.0002 * Math.floor(i / 12), 40 + (i % 60)));
  const t0 = Date.now();
  const p9 = R.planWalk(DERBY, big, 180);
  const ms = Date.now() - t0;
  t.ok(ms < 3000, `120 leads planned in ${ms}ms — fast enough to run on a phone`);
  t.ok(p9.totalMinutes <= 180, "…and still inside the budget at that size");

  // === recompute() — removing a stop by hand ==============================
  //
  // The planner solves an ORIENTEERING problem: maximise score inside the time
  // budget. Correct, and it has one visible side effect — with twenty spare
  // minutes it adds one more door a long way from the rest, because one door
  // scores more than none. On the map that reads as a random outlier, so the
  // desk lets you drop it.
  //
  // The property that matters is that the numbers still describe the route.
  // The first version of recompute() reported the RAW haversine while planWalk
  // multiplies by detourFactor, so a plan shrank 25% the instant you touched
  // it — the totals silently disagreeing with the planner that produced them.
  {
    const start = { lat: 52.9225, lng: -1.4746 };
    const cands = [
      { lat: 52.9226, lng: -1.4740, score: 80, lead: { businessName: "A" } },
      { lat: 52.9230, lng: -1.4750, score: 70, lead: { businessName: "B" } },
      { lat: 52.9231, lng: -1.4762, score: 65, lead: { businessName: "C" } },
    ];
    const plan = R.planWalk(start, cands, 240);
    t.ok(plan.order.length >= 2, "the fixture actually plans a multi-stop walk");

    const asStops = plan.order.map((o) => ({ lat: o.lat, lng: o.lng, lead: o.lead, score: o.lead.score }));
    const same = R.recompute(start, asStops, {});

    // IDENTITY: recompute over the untouched plan must reproduce it exactly.
    // This is the assertion that catches a units or factor drift between the
    // two functions, whichever of them changes.
    t.eq(same.distanceMetres, plan.distanceMetres, "recompute reproduces planWalk's distance exactly");
    t.eq(same.totalMinutes, plan.totalMinutes, "…its total minutes");
    t.eq(same.walkMinutes, plan.walkMinutes, "…its walking minutes");
    t.eq(same.dwellMinutes, plan.dwellMinutes, "…its talking minutes");
    t.eq(same.totalScore, plan.totalScore, "…and its total score");

    // Removing a stop shortens the walk and drops its score.
    const fewer = R.recompute(start, asStops.slice(0, -1), {});
    t.eq(fewer.order.length, asStops.length - 1, "one stop comes off");
    t.ok(fewer.distanceMetres < same.distanceMetres, "the route gets shorter");
    t.ok(fewer.totalScore < same.totalScore, "and the total score drops with it");
    // Written first as `same.dwellMinutes - (same.dwellMinutes - fewer.dwellMinutes)`,
    // which reduces to `fewer.dwellMinutes === fewer.dwellMinutes` and can never
    // fail. Third tautology-shaped guard caught today; state the expected number.
    t.eq(same.dwellMinutes - fewer.dwellMinutes, Math.round(R.DEFAULTS.dwellSeconds / 60),
      "talking time falls by exactly one door's worth");

    // Renumbered from 1 — a plan that still says "stop 4" after 3 has gone is
    // the kind of small lie that costs you a doorway.
    t.eq(fewer.order.map((o) => o.n), fewer.order.map((_, i) => i + 1),
      "the remaining stops renumber from 1 with no gap");

    // Order is PRESERVED, not re-planned. You removed a specific door; silently
    // reshuffling the rest is not what was asked for.
    const names = (r) => r.order.map((o) => o.lead.lead.businessName);
    t.eq(names(fewer), names(same).slice(0, -1), "the remaining stops keep their order");

    // Degenerate input must not throw or invent a walk.
    const empty = R.recompute(start, [], {});
    t.eq(empty.order.length, 0, "an empty plan has no stops");
    t.eq(empty.distanceMetres, 0, "…no distance");
    t.eq(empty.totalMinutes, 0, "…and no time");
    t.eq(R.recompute(start, null, {}).order.length, 0, "null stops is survivable");
    // A stop with unusable coordinates is dropped rather than poisoning the maths.
    const withJunk = R.recompute(start,
      asStops.concat([{ lat: null, lng: undefined, lead: { businessName: "X" }, score: 99 }]), {});
    t.eq(withJunk.order.length, asStops.length, "a stop with no coordinates is excluded");
    t.eq(withJunk.totalScore, same.totalScore, "…and does not inflate the score");
  }
};
