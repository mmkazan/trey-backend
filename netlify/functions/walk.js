const { getStore } = require("@netlify/blobs");
const { adminIdentity, unauthorized } = require("./admin-auth.js");

/**
 * THE WALK LOG — what actually happened on the pavement.
 *
 *   POST { event:"door"|"signup", placeId, businessName, status }
 *   GET  ?days=14   -> per-day counts, and the number that matters
 *
 * WHY THIS EXISTS AT ALL, when the statuses are already on the leads:
 * a lead record only holds where a business ended up. It cannot tell you that
 * you knocked on 24 doors on Tuesday, because a lead you set to "Come back" and
 * later to "Converted" leaves no trace of Tuesday behind.
 *
 * And the ratio of doors to signups is the single number the whole runner
 * question turns on — `claude/trey-go-runner-model.md` argues that commission,
 * patch size and whether anyone else can do this are all unanswerable without
 * it, and that only Matthew walking a street can produce it. Nothing else in
 * the product can reconstruct it after the fact, so it gets recorded as it
 * happens or not at all.
 *
 * A "door" is a business you set ANY status on. That's an honest definition —
 * it needs no extra tapping and it can't be inflated by scrolling past a shop.
 */

const MAX_DAYS = 120;

function store() {
  return getStore({ name: "walks", siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// THE PLAN, as opposed to the LOG.
//
// The log records what happened. This holds what you INTEND to happen: the route
// route.js worked out at the desk, so the phone can follow it in the street
// rather than you re-planning it on a pavement with one bar of signal.
//
// One current plan per person, overwritten each time — a plan is a thing you
// make tonight and walk tomorrow, not an archive. Keyed by ownerId so the day
// there are runners, each carries their own.
function planStore() {
  return getStore({ name: "walkplans", siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

const dayKey = (who, d) => `${d}:${who}`;
const today = () => new Date().toISOString().slice(0, 10);
const clean = (v, max) => String(v == null ? "" : v)
  .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// A blank day, so every field exists whether or not anything happened.
const emptyDay = (date, who) => ({
  date, ownerId: who,
  doors: 0, signups: 0,
  // Businesses seen today, so a second status change on the same shop doesn't
  // count as a second door. Walking past a shop twice isn't two attempts.
  seen: [],
  byStatus: {},
});

exports.handler = async (event) => {
  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch (e) { /* ignore */ } }
  const params = (event && event.queryStringParameters) || {};
  // No `params` argument: the admin token must come from the Authorization
  // header or the POST body, NEVER the query string. A token in a URL lands in
  // Netlify's request logs, browser history and any Referer — and this endpoint
  // returns the walk log.
  const who = adminIdentity(event, body);
  if (!who) return unauthorized();

  const s = store();

  // --- the walk PLAN -------------------------------------------------------
  // GET  ?plan=1            -> the current plan, or null
  // POST { plan:{...} }     -> save/replace it
  // POST { clearPlan:true } -> bin it
  if (event.httpMethod === "GET" && params.plan) {
    const p = await planStore().get(who.id, { type: "json" }).catch(() => null);
    return { statusCode: 200, body: JSON.stringify({ plan: p || null }) };
  }

  if (event.httpMethod === "POST" && body.clearPlan) {
    await planStore().delete(who.id).catch(() => {});
    return { statusCode: 200, body: JSON.stringify({ success: true, plan: null }) };
  }

  if (event.httpMethod === "POST" && body.plan) {
    const inPlan = body.plan || {};
    // Store only what the phone needs to walk it. Deliberately NOT the whole
    // lead record: leads change between planning and walking, and go.html
    // already holds the live ones — it looks each stop up by id, so a status
    // changed this morning shows correctly tonight. Coordinates are kept so a
    // stop still draws if the lead has since been filtered out or purged.
    const stops = (Array.isArray(inPlan.stops) ? inPlan.stops : []).slice(0, 60).map((x, i) => ({
      n: i + 1,
      id: clean(x && x.id, 200),
      businessName: clean(x && x.businessName, 120),
      address: clean(x && x.address, 300),
      lat: Number(x && x.lat), lng: Number(x && x.lng),
    })).filter((x) => x.id && isFinite(x.lat) && isFinite(x.lng));

    if (!stops.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "A plan needs at least one stop" }) };
    }

    const record = {
      ownerId: who.id,
      savedAt: new Date().toISOString(),
      savedBy: who.name || who.id,
      minutes: Math.max(0, Math.min(600, Number(inPlan.minutes) || 0)),
      totalMinutes: Math.max(0, Math.min(600, Number(inPlan.totalMinutes) || 0)),
      distanceMetres: Math.max(0, Number(inPlan.distanceMetres) || 0),
      totalScore: Math.max(0, Number(inPlan.totalScore) || 0),
      note: clean(inPlan.note, 200),
      stops,
    };
    await planStore().setJSON(who.id, record);
    return { statusCode: 200, body: JSON.stringify({ success: true, plan: record }) };
  }

  if (event.httpMethod === "POST") {
    const kind = String(body.event || "").toLowerCase();
    if (!["door", "signup"].includes(kind)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'event must be "door" or "signup"' }) };
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : today();
    const key = dayKey(who.id, date);
    const day = (await s.get(key, { type: "json" })) || emptyDay(date, who.id);

    const id = clean(body.placeId, 200) || clean(body.businessName, 120);
    const status = clean(body.status, 40);

    if (kind === "door") {
      // One door per business per day, however many times you change its status.
      if (id && !day.seen.includes(id)) { day.seen.push(id); day.doors++; }
      if (status) day.byStatus[status] = (day.byStatus[status] || 0) + 1;
    } else {
      day.signups++;
      if (id && !day.seen.includes(id)) { day.seen.push(id); day.doors++; }
    }
    day.updatedAt = new Date().toISOString();
    await s.setJSON(key, day);
    return { statusCode: 200, body: JSON.stringify({ ok: true, day }) };
  }

  if (event.httpMethod === "GET") {
    // Garbage or a negative gets the DEFAULT, not a silently minimal window —
    // clamping "-3" to 1 day would quietly answer a different question.
    const asked = Number(params.days);
    const days = (isFinite(asked) && asked > 0) ? Math.min(MAX_DAYS, Math.round(asked)) : 14;
    const wanted = [];
    for (let i = 0; i < days; i++) {
      wanted.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    const found = await Promise.all(wanted.map((d) => s.get(dayKey(who.id, d), { type: "json" }).catch(() => null)));
    const list = wanted.map((d, i) => found[i] || emptyDay(d, who.id));

    const doors = list.reduce((a, d) => a + (d.doors || 0), 0);
    const signups = list.reduce((a, d) => a + (d.signups || 0), 0);
    const byStatus = {};
    list.forEach((d) => Object.entries(d.byStatus || {}).forEach(([k, v]) => { byStatus[k] = (byStatus[k] || 0) + v; }));
    const walked = list.filter((d) => d.doors > 0).length;

    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        days: list.map((d) => ({ date: d.date, doors: d.doors || 0, signups: d.signups || 0, byStatus: d.byStatus || {} })),
        totals: {
          doors, signups, byStatus,
          daysWalked: walked,
          doorsPerDay: walked ? Math.round((doors / walked) * 10) / 10 : 0,
          // THE NUMBER. Deliberately null rather than 0 until a door has been
          // knocked — "0%" from no data reads as failure when it means nothing yet.
          conversionPct: doors ? Math.round((signups / doors) * 1000) / 10 : null,
          // How many doors, at the current rate, per signup. Easier to feel than
          // a percentage when you're deciding whether to walk another street.
          doorsPerSignup: signups ? Math.round((doors / signups) * 10) / 10 : null,
        },
      }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
};

module.exports.emptyDay = emptyDay;
