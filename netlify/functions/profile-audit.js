// Google Business Profile completeness AUDIT — the brains behind "Trey Profile
// Check". Pure logic (no network), so it's fully testable.
//
// - scoreProfile(profile) takes a normalised profile object (built from the
//   Google Business Information API when live) and returns
//   { score, outOf, pct, gaps, unmeasured } — see NOT_MEASURED below for why
//   the denominator is `outOf` and not a flat 100.
// - suggestCategories / draftServices give ready-to-use, trade-tailored content
//   that works even before the API is live (the owner pastes it in).
//
// Google ranks on relevance + prominence; categories and a full services list
// are the biggest under-used relevance levers, so they carry the most weight.

// ---- Trade buckets (shared shape with the photo shot-list) -------------------
function tradeOf(businessType) {
  const t = String(businessType || "").toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  if (has("garage", "mechanic", "mot", "auto", "car", "tyre", "tire")) return "auto";
  if (has("cafe", "café", "coffee", "bakery", "tea room")) return "cafe";
  if (has("barber")) return "barber";
  if (has("restaurant", "takeaway", "pub", "bar", "bistro", "diner", "kitchen", "food")) return "restaurant";
  if (has("salon", "hair", "beauty", "nail", "spa", "lash", "brow", "wax")) return "salon";
  if (has("gym", "fitness", "yoga", "pilates", "crossfit", "personal train")) return "gym";
  if (has("plumb")) return "plumber";
  if (has("electric")) return "electrician";
  if (has("build", "roof", "joiner", "carpenter", "plaster", "brick", "landscap", "garden", "paint", "decorat", "trade")) return "trades";
  if (has("dentist", "dental")) return "dentist";
  if (has("clinic", "physio", "doctor", "vet", "therap", "health", "chiro", "osteo")) return "clinic";
  if (has("shop", "store", "retail", "boutique", "florist")) return "retail";
  return "generic";
}

// Suggested Google categories by trade. NOTE: pick the closest MATCHING name in
// Google's own category picker — these are guidance, not exact API strings.
const CATEGORIES = {
  auto:       { primary: "Auto repair shop", secondaries: ["MOT testing service", "Tyre shop", "Brake shop", "Car battery store", "Auto electrical service"] },
  cafe:       { primary: "Cafe", secondaries: ["Coffee shop", "Breakfast restaurant", "Bakery", "Sandwich shop", "Takeout restaurant"] },
  restaurant: { primary: "Restaurant", secondaries: ["Takeout restaurant", "Family restaurant", "Bar", "Caterer"] },
  barber:     { primary: "Barber shop", secondaries: ["Hairdresser", "Men's hairdresser"] },
  salon:      { primary: "Hair salon", secondaries: ["Beauty salon", "Nail salon", "Waxing hair removal service", "Eyelash salon", "Hairdresser"] },
  gym:        { primary: "Gym", secondaries: ["Fitness center", "Personal trainer", "Physical fitness program"] },
  plumber:    { primary: "Plumber", secondaries: ["Heating contractor", "Boiler supplier", "Bathroom remodeler", "Drainage service"] },
  electrician:{ primary: "Electrician", secondaries: ["Electrical installation service", "Lighting contractor", "EV charging station contractor"] },
  trades:     { primary: "General contractor", secondaries: ["Building firm", "Handyman", "Carpenter", "Painter", "Landscaper"] },
  dentist:    { primary: "Dentist", secondaries: ["Dental clinic", "Cosmetic dentist", "Emergency dental service"] },
  clinic:     { primary: "Medical clinic", secondaries: ["Physiotherapist", "Health consultant", "Wellness center"] },
  retail:     { primary: "Shop", secondaries: ["Gift shop", "Boutique"] },
  generic:    { primary: "", secondaries: [] },
};

// A ready-to-paste services list by trade (name — short description).
const SERVICES = {
  auto: [["MOT testing", "Class 4 MOTs, often while you wait."], ["Full & interim servicing", "Manufacturer-schedule servicing for all makes."], ["Brakes & clutches", "Pads, discs and clutch replacement."], ["Diagnostics", "Engine-management fault finding."], ["Tyres & wheel alignment", "Supply, fit and balance."], ["Air-con recharge", "Re-gas and leak checks."]],
  cafe: [["Speciality coffee", "Barista-made espresso, flat whites and more."], ["Fresh breakfast & brunch", "Cooked and lighter options daily."], ["Homemade cakes & pastries", "Baked in-house."], ["Takeaway", "Grab-and-go drinks and food."], ["Private hire", "Book the space for events."]],
  restaurant: [["Dine-in", "Full table service."], ["Takeaway & collection", "Order ahead to collect."], ["Set menus", "Lunch and evening set menus."], ["Private dining & functions", "Group bookings and events."], ["Catering", "Off-site catering available."]],
  barber: [["Haircuts", "Skin fades, scissor cuts and restyles."], ["Beard trims & hot towel shaves", "Shape-ups and traditional shaves."], ["Kids' cuts", "Friendly cuts for children."], ["Grey blending", "Subtle colour for a natural finish."]],
  salon: [["Cut & blow-dry", "Restyles, trims and finishes."], ["Colour", "Full head, highlights and balayage."], ["Treatments", "Conditioning and keratin treatments."], ["Nails", "Manicures, gels and extensions."], ["Waxing & brows", "Shaping and tinting."]],
  gym: [["Gym membership", "Full access to equipment and floor."], ["Classes", "Group sessions across the week."], ["Personal training", "1-to-1 coaching and plans."], ["Inductions", "Free starter session for new members."]],
  plumber: [["Emergency call-outs", "Fast response for leaks and breakdowns."], ["Boiler service & repair", "Annual servicing and fault fixing."], ["Bathroom installation", "Full and partial fits."], ["Leak detection & repair", "Trace and fix."], ["Radiators & heating", "Installs and power-flushes."]],
  electrician: [["Fault finding & repair", "Diagnose and fix electrical faults."], ["Fuse board upgrades", "Consumer-unit replacement."], ["EV charger installation", "Home and business chargers."], ["Lighting", "Indoor and outdoor installs."], ["EICR & certificates", "Safety inspections and reports."]],
  trades: [["Free quotes", "No-obligation estimates."], ["Repairs & maintenance", "Small jobs to full projects."], ["Installations", "Supply and fit."], ["Renovations", "Full project management."]],
  dentist: [["Check-ups & hygiene", "Routine exams and cleaning."], ["Cosmetic dentistry", "Whitening and veneers."], ["Emergency appointments", "Same-day where possible."], ["Implants & crowns", "Restorative treatments."]],
  clinic: [["Consultations", "Assessment and diagnosis."], ["Treatment plans", "Tailored programmes."], ["Follow-up care", "Ongoing support."]],
  retail: [["In-store shopping", "Browse the full range."], ["Click & collect", "Reserve and pick up."], ["Gift wrapping", "Free on request."], ["Local delivery", "To your door."]],
  generic: [["Free consultation", "Tell us what you need."], ["Our core service", "Delivered by our team."], ["Aftercare & support", "We're here after the job."]],
};

function suggestCategories(businessType) { return CATEGORIES[tradeOf(businessType)] || CATEGORIES.generic; }
function draftServices(businessType) { return (SERVICES[tradeOf(businessType)] || SERVICES.generic).map(([name, description]) => ({ name, description })); }

// A safe templated description (used as the fallback / no-AI path).
function draftDescriptionFallback(client) {
  const name = client.businessName || "We";
  const type = client.businessType || "local business";
  return `${name} is a trusted ${type} looking after customers with friendly, reliable service. Whether it's your first visit or your tenth, we take the time to do things properly and keep you informed. Pop in or get in touch — we'd be glad to help.`;
}

// ---- MEASURED, versus NOT MEASURED ------------------------------------------
//
// ADDED 17 Aug 2026, and it is the rule both scorers below now follow.
//
// A field that is null or undefined has NOT BEEN MEASURED. It scores nothing AND
// it is taken out of the denominator, and the caller is handed the list so the
// page can say "not measurable yet" in as many words. A field with an explicit
// value — including an explicit false, "" or 0 — is a measurement, and is scored
// like one.
//
// WHY. Everything absent used to be worth zero out of its full weight, and the
// result was always presented out of 100. So the score told a customer they had
// failed things Trey has never once looked at:
//
//   • profile-check's normalise() hard-coded attributeCount and questionCount to
//     0 because there is no API read for either. Nobody could ever clear those
//     two "quick wins", and the ceiling was 88, not 100.
//   • the live score read client.reviewsLast90, client.ownerResponseRate and
//     client.postedRecently — and NOTHING in this codebase has ever written
//     those three fields to a client record. They exist on LEAD records only.
//     So every paying customer scored a permanent 0/15 on Activity, and the
//     recency and reply components silently fell to their "unknown" defaults.
//
// Scoring an unchecked thing as zero is not caution, it is a false statement
// about a customer's business. Excluding it is the honest version, and it is
// also the one that can't quietly go wrong: a component that vanishes from the
// denominator is visible in the UI, where a component scored zero looks exactly
// like a real failure.
const NOT_MEASURED = null;
const isMeasured = (v) => v !== null && v !== undefined;

// ---- Scoring -----------------------------------------------------------------
// `p` is a normalised profile: { primaryCategory, secondaryCount, description,
// serviceCount, hoursSet, phone, website, photoCount, hasLogo, attributeCount,
// openingDate, questionCount }. A field that is null/undefined is NOT MEASURED
// (see above): it is excluded from the score's denominator and reported in
// `unmeasured` instead of being listed as a gap the owner could fix.
//
// Returns { score, outOf, pct, gaps, unmeasured }. `score` is points earned;
// `outOf` is the total available FROM THE THINGS WE COULD CHECK, which is 100
// only when everything was measurable.
function scoreProfile(p) {
  p = p || {};
  const checks = [
    { key: "primaryCategory", w: 10, known: isMeasured(p.primaryCategory), ok: !!p.primaryCategory, label: "Primary category set", fix: "Set the most specific primary category that matches what you do." },
    { key: "secondaryCategories", w: 10, known: isMeasured(p.secondaryCount), ok: (p.secondaryCount || 0) >= 2, label: "2+ secondary categories", fix: "Add relevant secondary categories — one of the biggest ranking levers." },
    { key: "description", w: 10, known: isMeasured(p.description), ok: !!p.description && String(p.description).length >= 120, label: "Full business description", fix: "Add a 120+ character description of what you do and who you help." },
    { key: "services", w: 12, known: isMeasured(p.serviceCount), ok: (p.serviceCount || 0) >= 3, label: "Services listed (3+)", fix: "List your services — Google ranks you for each one." },
    { key: "hours", w: 10, known: isMeasured(p.hoursSet), ok: !!p.hoursSet, label: "Opening hours set", fix: "Set your regular hours (and holiday hours) so you never show as closed wrongly." },
    { key: "phone", w: 6, known: isMeasured(p.phone), ok: !!p.phone, label: "Phone number", fix: "Add a contact phone number." },
    { key: "website", w: 8, known: isMeasured(p.website), ok: !!p.website, label: "Website link", fix: "Add your website link." },
    { key: "photos", w: 14, known: isMeasured(p.photoCount), ok: (p.photoCount || 0) >= 10, part: (p.photoCount || 0) >= 5, label: "10+ photos", fix: "Add more photos — profiles with 10+ get far more views and clicks." },
    // A media COUNT does not tell us whether one of them is the logo or the
    // cover. Deriving hasLogo from "they have at least one photo" was inventing
    // the answer, so the caller now passes null and this drops out.
    { key: "logo", w: 5, known: isMeasured(p.hasLogo), ok: !!p.hasLogo, label: "Logo / cover photo", fix: "Add a logo and a cover photo." },
    { key: "attributes", w: 8, known: isMeasured(p.attributeCount), ok: (p.attributeCount || 0) >= 3, label: "Attributes (3+)", fix: "Tick relevant attributes (parking, accessibility, payment types, etc.)." },
    { key: "openingDate", w: 3, known: isMeasured(p.openingDate), ok: !!p.openingDate, label: "Opening date", fix: "Add the date you opened." },
    { key: "questions", w: 4, known: isMeasured(p.questionCount), ok: (p.questionCount || 0) >= 1, label: "Seeded a Q&A", fix: "Post and answer a common question yourself — almost nobody does this." },
  ];
  let score = 0, outOf = 0;
  const gaps = [];
  const unmeasured = [];
  for (const c of checks) {
    // Not measured: out of the denominator, and NOT listed as a gap. A gap is
    // something the owner can go and fix; "we can't read your attributes" is
    // not, and listing it as one produced two permanent quick wins that could
    // never be cleared however much work the customer did.
    if (!c.known) { unmeasured.push({ key: c.key, label: c.label, max: c.w }); continue; }
    outOf += c.w;
    if (c.ok) score += c.w;
    else if (c.part) { score += Math.round(c.w / 2); gaps.push({ key: c.key, label: c.label, fix: c.fix, partial: true, weight: c.w }); }
    else gaps.push({ key: c.key, label: c.label, fix: c.fix, weight: c.w });
  }
  gaps.sort((a, b) => b.weight - a.weight); // biggest wins first
  const total = Math.max(0, Math.min(outOf, Math.round(score)));
  return {
    score: total,
    outOf,
    // Percentage OF WHAT WAS CHECKED. Null when nothing was — better than a
    // confident 0 that reads as "your profile is empty".
    pct: outOf ? Math.round((total / outOf) * 100) : null,
    gaps,
    unmeasured,
  };
}

// ---- The composite "Trey Score" (0-100) -------------------------------------
// One number from three honest drivers: Reputation (55), Activity (15),
// Completeness (30).
//
// WEIGHTING RATIONALE (revised 2026-08-15, after modelling the old weights).
// The first cut paid 10 points each for "posted recently" and "photos fresh" —
// 20 points for two box-ticks — while replying to every review was worth 6 and
// tripling the review flow worth 5. The score therefore said a quarterly photo
// upload mattered more than the stand and the replies combined, which is both
// wrong about Google and wrong about what Trey sells. Weight has moved onto the
// two things Trey actually drives:
//
//   reviewsLast90 (the stand working)   8  -> 15, and now graduated
//   replyRate     (the replies working) 6  -> 10, and now linear
//   rating        (slow, mostly not ours) 22 -> 18
//   reviewCount   (slow, historic)      14 -> 12
//   posted/photos (binary box-ticks)    20 -> 15, with a partial-credit step
//
// Activity was also a pair of 10-point cliffs; postedWithin3m / photosSome give
// partial credit so the number moves gradually rather than lurching.
//
// NOT tuned to flatter the trial. A 14-day trial moves this by roughly +18, which
// still usually leaves a weak profile inside "Needs work" — because that is the
// truth. The fix for the trial story is showing the PROJECTED score alongside the
// current one, not bending the instrument until it says something nicer.
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

/**
 * @param inp  { reputation, activity, completeness } — see NOT_MEASURED above:
 *             null/undefined on any component means "we didn't check this".
 * @param opts { unknown: "exclude" | "middling" }
 *
 *   "exclude"  (default) — an unmeasured component leaves the denominator.
 *              This is what a customer must be shown. The default is the honest
 *              one deliberately: a caller who forgets the option gets the
 *              version that can't accuse someone of failing an unchecked test.
 *   "middling" — restores the historic unknown-defaults for recency and reply
 *              rate (7/15 and 3/10). Right for RANKING COLD LEADS, where every
 *              lead must be scored out of the same 100 or the ordering means
 *              nothing, and where nobody is being told the number is about them.
 *
 * Returns { total, outOf, pct, band, color, pillars, unmeasured }.
 *   total  — points earned.
 *   outOf  — points available FROM WHAT WE COULD CHECK. 100 only when
 *            everything was measurable, so never print "total/100".
 *   pct    — total as a percentage of outOf; null when nothing was measurable.
 *   band   — derived from pct, not from total, so a partially-measurable score
 *            isn't dragged into "Needs work" by the things we never looked at.
 */
function scoreBusiness(inp, opts) {
  inp = inp || {};
  const middling = (opts && opts.unknown) === "middling";
  const rep = inp.reputation || {}, act = inp.activity || {}, comp = inp.completeness || {};

  // Each entry is [pillar, key, label, max, pts] where pts === NOT_MEASURED
  // means the component leaves the denominator.
  const parts = [];
  const add = (pillar, key, label, max, pts) => parts.push({ pillar, key, label, max, pts });

  // --- Reputation /55 — rating, volume, recency, reply rate -------------------
  const rating = Number(rep.rating);
  const ratingKnown = isMeasured(rep.rating) && isFinite(rating) && rating > 0;
  add("reputation", "rating", "Star rating", 18,
    ratingKnown ? Math.round(clamp((rating - 3.0) / 1.7, 0, 1) * 18) : NOT_MEASURED);

  const rc = Number(rep.reviewCount);
  const rcKnown = isMeasured(rep.reviewCount) && isFinite(rc);
  add("reputation", "reviewCount", "Number of reviews", 12,
    rcKnown ? (rc >= 100 ? 12 : rc >= 50 ? 10 : rc >= 25 ? 7 : rc >= 10 ? 4 : rc >= 1 ? 2 : 0) : NOT_MEASURED);

  // Recency is the stand's signature: it is the one number that moves when the
  // team actually asks. Graduated so every extra review a quarter shows up.
  const r90 = Number(rep.reviewsLast90);
  const r90Known = isMeasured(rep.reviewsLast90) && isFinite(r90);
  add("reputation", "reviewsLast90", "Reviews in the last 90 days", 15,
    r90Known ? (r90 >= 12 ? 15 : r90 >= 8 ? 13 : r90 >= 6 ? 11 : r90 >= 4 ? 8 : r90 >= 2 ? 5 : r90 >= 1 ? 3 : 0) : NOT_MEASURED);

  const rr = Number(rep.replyRate);
  const rrKnown = isMeasured(rep.replyRate) && isFinite(rr);
  add("reputation", "replyRate", "Replies to reviews", 10,
    rrKnown ? Math.round(clamp(rr, 0, 1) * 10) : NOT_MEASURED);

  // --- Activity /15 — is the profile alive? -----------------------------------
  // POSTING IS ONLY EVER KNOWABLE AS "YES". We can see a post Trey published for
  // them; we cannot see one they wrote themselves in Google, because nothing we
  // have lists a location's posts. So "no post" is not a measurement, and it is
  // reported as unmeasured rather than as a zero — otherwise every customer who
  // posts without us is marked down for it. Pass an explicit false only when you
  // genuinely know (a cold lead, which posts nothing by definition).
  add("activity", "posted", "Posting", 8,
    act.postedRecently === true ? 8
      : act.postedWithin3m === true ? 4
      : (act.postedRecently === false || act.postedWithin3m === false) ? 0
      : NOT_MEASURED);

  // Photos: a media count from Google is a real measurement of how many photos
  // are on the profile. How FRESH they are is not — the media list gives no
  // dates — so photosFresh must come from the caller knowing, not from "they
  // have some photos, call it fresh".
  const pc = Number(act.photoCount);
  add("activity", "photos", "Photos", 7,
    act.photosFresh === true ? 7
      : act.photosSome === true ? 3
      : (isMeasured(act.photoCount) && isFinite(pc)) ? (pc >= 10 ? 7 : pc >= 1 ? 3 : 0)
      : (act.photosFresh === false || act.photosSome === false) ? 0
      : NOT_MEASURED);

  // --- Completeness /30 — the relevance + contactability fill-in --------------
  const compChecks = [
    ["primaryCategory", "Primary category", 6, () => (comp.primaryCategory ? 6 : 0)],
    ["secondaryCount", "Secondary categories", 5, () => ((comp.secondaryCount || 0) >= 2 ? 5 : 0)],
    ["description", "Business description", 5, () => (comp.description && String(comp.description).length >= 120 ? 5 : 0)],
    ["serviceCount", "Services listed", 5, () => ((comp.serviceCount || 0) >= 3 ? 5 : 0)],
    ["hoursSet", "Opening hours", 3, () => (comp.hoursSet ? 3 : 0)],
    ["website", "Website link", 3, () => (comp.website ? 3 : 0)],
    ["phone", "Phone number", 2, () => (comp.phone ? 2 : 0)],
    ["attributeCount", "Attributes", 1, () => ((comp.attributeCount || 0) >= 1 ? 1 : 0)],
  ];
  for (const [key, label, max, fn] of compChecks) {
    add("completeness", key, label, max, isMeasured(comp[key]) ? fn() : NOT_MEASURED);
  }

  // Lead ranking mode: nothing is excluded, unknowns take the historic defaults
  // and every lead is scored out of the same 100. Applied here in one place so
  // the component rules above stay readable and there is exactly one list of
  // what an "unknown" used to be worth.
  if (middling) {
    const MIDDLING = { reviewsLast90: 7, replyRate: 3 };
    for (const p of parts) if (!isMeasured(p.pts)) p.pts = MIDDLING[p.key] || 0;
  }

  const measured = parts.filter((p) => isMeasured(p.pts));
  const unmeasured = parts.filter((p) => !isMeasured(p.pts))
    .map(({ pillar, key, label, max }) => ({ pillar, key, label, max }));

  const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
  const total = clamp(Math.round(sum(measured, (p) => p.pts)), 0, 100);
  const outOf = sum(measured, (p) => p.max);
  const pct = outOf ? Math.round((total / outOf) * 100) : null;

  // Banded on the percentage of what was CHECKED. With everything measurable
  // pct === total and the bands are exactly as they were.
  const b = pct == null ? { label: "Not enough to score", color: "#64748b" }
    : pct >= 90 ? { label: "Excellent", color: "#16a34a" }
    : pct >= 75 ? { label: "Strong", color: "#16a34a" }
    : pct >= 50 ? { label: "Getting there", color: "#f59e0b" }
    : { label: "Needs work", color: "#ef4444" };

  const pillar = (name, max) => {
    const mine = parts.filter((p) => p.pillar === name);
    const got = mine.filter((p) => isMeasured(p.pts));
    return {
      pts: sum(got, (p) => p.pts),
      max,                                     // the designed weight
      outOf: sum(got, (p) => p.max),           // what we could actually check
      unmeasured: mine.filter((p) => !isMeasured(p.pts)).map((p) => p.key),
    };
  };

  return {
    total, outOf, pct, band: b.label, color: b.color,
    // A business can be excellent AND score mid-band, because this measures the
    // Google presence, not the business. Callers use this to say "your reputation
    // is excellent — it's the profile holding you back" instead of just "56".
    pillars: {
      reputation: pillar("reputation", 55),
      activity: pillar("activity", 15),
      completeness: pillar("completeness", 30),
    },
    // What we could not check, so the page can say so instead of implying a fail.
    unmeasured,
  };
}

// "30%" -> 0.3, "n/a"/blank -> null.
function parsePct(v) {
  if (v == null) return null;
  const m = String(v).match(/(\d+(\.\d+)?)/);
  return m ? clamp(parseFloat(m[1]) / 100, 0, 1) : null;
}

// Estimate a Trey Score from a scraped/stored LEAD (no live profile). Reputation
// comes straight from the scrape; Activity is assumed ~0 (a lead isn't posting);
// Completeness uses what the scrape reveals (category, website, phone, + any
// secondary categories / hours if present).
//
// RANKING MODE, deliberately. Leads are sorted against each other, so they must
// all be scored out of the same 100 — a per-lead denominator would put a
// thinly-scraped lead above a rich one for no better reason than that we know
// less about it. Nobody is shown this number as a statement about their own
// business, which is the case the exclusion rule exists for. leads.html mirrors
// these same defaults in the browser — keep the two in step.
function estimateFromLead(lead) {
  lead = lead || {};
  return scoreBusiness({
    reputation: {
      rating: Number(lead.rating),
      reviewCount: Number(lead.reviewCount) || 0,
      reviewsLast90: lead.reviewsLast90, // set at import if review dates are available
      replyRate: parsePct(lead.ownerResponseRate),
    },
    activity: { postedRecently: false, photosFresh: false },
    completeness: {
      primaryCategory: !!lead.category,
      secondaryCount: lead.secondaryCount || 0,
      description: lead.description,
      serviceCount: lead.serviceCount || 0,
      hoursSet: !!lead.hoursSet,
      website: !!lead.website,
      phone: !!lead.phone,
      attributeCount: lead.attributeCount || 0,
    },
  }, { unknown: "middling" });
}

// Opportunity score (0-100) — who to work first. Trey Score says how healthy a
// profile is; Opportunity says how much *Trey* can move the needle × how winnable
// the business is, so good leads float up and we don't chase the un-helpable or
// un-reachable. Mirrors opportunityScore() in leads.html — keep in sync.
function opportunityScore(lead) {
  lead = lead || {};
  const rating = Number(lead.rating);                 // NaN = unknown
  const rc = Number(lead.reviewCount) || 0;
  const replyRate = parsePct(lead.ownerResponseRate); // 0..1 or null
  const r90 = Number(lead.reviewsLast90);             // may be NaN
  const recent = Number(lead.recentUnanswered) || 0;
  const size = clamp(rc / 150, 0, 1);
  const gap = (replyRate == null) ? 0.5 : (1 - replyRate);
  const replyGapPts = gap * size * 40;                // 0-40
  let actPts = rc >= 10 ? 16 : rc >= 3 ? 8 : 0;       // 0-20
  if (isFinite(r90) && r90 >= 1) actPts = Math.min(actPts + 4, 20);
  const painPts = Math.min(recent * 7, 20);           // 0-20
  const compPts = (lead.website ? 0 : 8) + (lead.category ? 0 : 8) + (lead.phone ? 0 : 4); // 0-20
  const raw = clamp(replyGapPts + actPts + painPts + compPts, 0, 100);
  let win;
  if (!isFinite(rating) || rating <= 0) win = 0.7;
  else if (rating < 2.8) win = 0.25;
  else if (rating < 3.3) win = 0.6;
  else if (rating < 3.8) win = 0.85;
  else win = 1.0;
  if (!lead.phone && !lead.email) win *= 0.7;
  const total = Math.round(clamp(raw * win, 0, 100));
  const band = total >= 60 ? "Hot" : total >= 33 ? "Warm" : "Cold";
  return { total, band };
}

// Same dead-end bar as the LOW RATING / THIN flags: sub-3.0★ or under 10 reviews.
function isDeadEnd(lead) {
  lead = lead || {};
  const rating = Number(lead.rating);
  const rc = Number(lead.reviewCount);
  // Only judge a lead we actually have data for. A quick-added lead with no
  // scrape yet is unknown, not a dead end — flagging it would hide it behind the
  // "hide dead ends" filter before anyone has looked at it.
  if (!isFinite(rating) && !isFinite(rc)) return false;
  if (isFinite(rating) && rating > 0 && rating < 3.0) return true;
  return isFinite(rc) && rc < 10;
}

module.exports = { tradeOf, suggestCategories, draftServices, draftDescriptionFallback, scoreProfile, scoreBusiness, estimateFromLead, parsePct, opportunityScore, isDeadEnd };
