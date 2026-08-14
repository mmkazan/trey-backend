// Google Business Profile completeness AUDIT — the brains behind "Trey Profile
// Check". Pure logic (no network), so it's fully testable.
//
// - scoreProfile(profile) takes a normalised profile object (built from the
//   Google Business Information API when live) and returns { score 0-100, gaps }.
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

// ---- Scoring -----------------------------------------------------------------
// `p` is a normalised profile: { primaryCategory, secondaryCount, description,
// serviceCount, hoursSet, phone, website, photoCount, hasLogo, attributeCount,
// openingDate, questionCount }. Missing fields are treated as absent.
function scoreProfile(p) {
  p = p || {};
  const checks = [
    { key: "primaryCategory", w: 10, ok: !!p.primaryCategory, label: "Primary category set", fix: "Set the most specific primary category that matches what you do." },
    { key: "secondaryCategories", w: 10, ok: (p.secondaryCount || 0) >= 2, label: "2+ secondary categories", fix: "Add relevant secondary categories — one of the biggest ranking levers." },
    { key: "description", w: 10, ok: !!p.description && String(p.description).length >= 120, label: "Full business description", fix: "Add a 120+ character description of what you do and who you help." },
    { key: "services", w: 12, ok: (p.serviceCount || 0) >= 3, label: "Services listed (3+)", fix: "List your services — Google ranks you for each one." },
    { key: "hours", w: 10, ok: !!p.hoursSet, label: "Opening hours set", fix: "Set your regular hours (and holiday hours) so you never show as closed wrongly." },
    { key: "phone", w: 6, ok: !!p.phone, label: "Phone number", fix: "Add a contact phone number." },
    { key: "website", w: 8, ok: !!p.website, label: "Website link", fix: "Add your website link." },
    { key: "photos", w: 14, ok: (p.photoCount || 0) >= 10, part: (p.photoCount || 0) >= 5, label: "10+ photos", fix: "Add more photos — profiles with 10+ get far more views and clicks." },
    { key: "logo", w: 5, ok: !!p.hasLogo, label: "Logo / cover photo", fix: "Add a logo and a cover photo." },
    { key: "attributes", w: 8, ok: (p.attributeCount || 0) >= 3, label: "Attributes (3+)", fix: "Tick relevant attributes (parking, accessibility, payment types, etc.)." },
    { key: "openingDate", w: 3, ok: !!p.openingDate, label: "Opening date", fix: "Add the date you opened." },
    { key: "questions", w: 4, ok: (p.questionCount || 0) >= 1, label: "Seeded a Q&A", fix: "Post and answer a common question yourself — almost nobody does this." },
  ];
  let score = 0;
  const gaps = [];
  for (const c of checks) {
    if (c.ok) score += c.w;
    else if (c.part) { score += Math.round(c.w / 2); gaps.push({ key: c.key, label: c.label, fix: c.fix, partial: true, weight: c.w }); }
    else gaps.push({ key: c.key, label: c.label, fix: c.fix, weight: c.w });
  }
  gaps.sort((a, b) => b.weight - a.weight); // biggest wins first
  return { score: Math.max(0, Math.min(100, Math.round(score))), gaps };
}

// ---- The composite "Trey Score" (0-100) -------------------------------------
// One number from three honest drivers: Reputation (50), Activity (20),
// Completeness (30). Weights are a first cut — easy to tune.
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function scoreBusiness(inp) {
  inp = inp || {};
  const rep = inp.reputation || {}, act = inp.activity || {}, comp = inp.completeness || {};

  // Reputation /50 — rating, volume, recency, reply rate.
  const rating = Number(rep.rating);
  const ratingPts = isFinite(rating) && rating > 0 ? Math.round(clamp((rating - 3.0) / 1.7, 0, 1) * 22) : 0;
  const rc = Number(rep.reviewCount) || 0;
  const rcPts = rc >= 100 ? 14 : rc >= 50 ? 11 : rc >= 25 ? 8 : rc >= 10 ? 5 : rc >= 1 ? 2 : 0;
  const r90 = Number(rep.reviewsLast90);
  const recPts = !isFinite(r90) ? 4 : r90 >= 6 ? 8 : r90 >= 3 ? 5 : r90 >= 1 ? 3 : 0; // unknown -> middling
  const rr = rep.replyRate;
  const rrPts = (rr == null || isNaN(rr)) ? 2 : Math.round(clamp(rr, 0, 1) * 6); // unknown -> half
  const repPts = ratingPts + rcPts + recPts + rrPts;

  // Activity /20 — is the profile alive? (a cold lead scores ~0 here.)
  const actPts = (act.postedRecently ? 10 : 0) + (act.photosFresh ? 10 : 0);

  // Completeness /30 — the relevance + contactability fill-in.
  const compPts =
    (comp.primaryCategory ? 6 : 0) +
    ((comp.secondaryCount || 0) >= 2 ? 5 : 0) +
    (comp.description && String(comp.description).length >= 120 ? 5 : 0) +
    ((comp.serviceCount || 0) >= 3 ? 5 : 0) +
    (comp.hoursSet ? 3 : 0) +
    (comp.website ? 3 : 0) +
    (comp.phone ? 2 : 0) +
    ((comp.attributeCount || 0) >= 1 ? 1 : 0);

  const total = clamp(Math.round(repPts + actPts + compPts), 0, 100);
  const band = total >= 90 ? { label: "Excellent", color: "#16a34a" }
    : total >= 75 ? { label: "Strong", color: "#16a34a" }
    : total >= 50 ? { label: "Getting there", color: "#f59e0b" }
    : { label: "Needs work", color: "#ef4444" };
  return {
    total, band: band.label, color: band.color,
    pillars: { reputation: { pts: repPts, max: 50 }, activity: { pts: actPts, max: 20 }, completeness: { pts: compPts, max: 30 } },
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
  });
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
