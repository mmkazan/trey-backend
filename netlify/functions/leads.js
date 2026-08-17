const { getStore } = require("@netlify/blobs");

// Leads CRM store. Protected by the same CLIENT_ADMIN_TOKEN as the rest.
//
// GET  /.netlify/functions/leads?token=...              -> all leads (+ isClient flag)
// POST /.netlify/functions/leads  {token, lead:{...}}   -> add/update one
// POST /.netlify/functions/leads  {token, leads:[...]}  -> bulk add/update (CSV import)
// POST /.netlify/functions/leads  {token, delete:"id"}  -> delete one
//
// Each lead is matched against the clients store so the UI can flag anyone
// already onboarded ("Client ✓") and you don't chase existing customers.

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Admin auth: token from the Authorization: Bearer header (preferred) or the
// JSON body — never the query string (URLs leak via logs/history/referrers).
// Constant-time comparison.
// Identity, not a yes/no — see admin-auth.js. One shared implementation so the
// four back-office endpoints can never drift apart on who may do what.
const { adminIdentity, can, unauthorized, forbidden } = require("./admin-auth.js");

// Strip control characters (a stray newline in a consent record would break the
// audit log) and cap the length, so nothing typed at a door distorts evidence.
const clean = (v, max) => String(v == null ? "" : v)
  .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// --- DOORSTEP CONSENT ---------------------------------------------------------
//
// Consent is given in a shop doorway and, until now, could only be recorded back
// at a desk from memory. That is the wrong way round: PECR consent must be
// specific, informed and EVIDENCED, and a note typed up that evening evidences
// nothing.
//
// The exact words are held HERE, not in the page, and are stamped into the record
// server-side from the version number the runner's screen was showing. That way
// the record says what was actually read out, and changing the script later can't
// rewrite what someone agreed to last month. Add a new version, never edit an old
// one.
const CONSENT_CHANNELS = ["email", "whatsapp", "sms", "phone"];
const CURRENT_SCRIPT = "v1";
const CONSENT_SCRIPTS = {
  v1: {
    version: "v1",
    text:
      "I'm from Trey. Trey is a tap-to-review stand that helps you get more Google " +
      "reviews, and drafts your replies for you. Is it alright if I follow up about " +
      "Trey by the ways you've ticked? We won't pass your details to anyone else, " +
      "every message will say it's from Trey, and you can stop them any time by " +
      "replying STOP or clicking unsubscribe.",
  },
};

// --- COORDINATES AND THE 30-DAY RULE -----------------------------------------
//
// A lead needs lat/lng to appear on the planning map. Google's Maps Platform
// Service Terms allow a place_id to be cached INDEFINITELY, but latitude and
// longitude for a maximum of **30 CONSECUTIVE CALENDAR DAYS**, after which they
// must be deleted. (Matthew pushed back on an earlier flat "don't store
// anything" and was right — the allowance is real, it's just narrow.)
//
// So coordinates are stored WITH THE DATE THEY WERE FETCHED, and purged the
// moment they go stale. The place_id stays, so they can always be fetched again.
//
// The purge happens lazily on read — expired coordinates are actually DELETED
// from the record, not merely hidden from the response — AND on a daily sweep.
//
// WHY THE SWEEP (17 Aug 2026). This used to say the read path alone was enough
// because "the leads list is looked at often enough for that to be reliable".
// That is an assumption about human behaviour, not a control: a lead nobody
// opens is never read, so its coordinates are never purged, and a rule we can
// only claim to follow on the days someone opens the page is not a rule we
// follow. geo-purge.mjs walks the whole store every night and imports the two
// functions below, so the read path and the sweep can never disagree about what
// "expired" means.
const GEO_MAX_AGE_DAYS = 30;

// PROVENANCE DECIDES EXPIRY (changed 17 Aug 2026).
//
// The 30-day rule is a term of GOOGLE'S contract — it governs coordinates
// obtained through the Places API. It is not a law of nature and it does not
// apply to coordinates from anywhere else.
//
// Coordinates now come from Nominatim (OpenStreetMap) or postcodes.io (ONS/OS
// open data), geocoded from the lead's own Apify-sourced address. That data is
// openly licensed, carries no caching restriction, and must NOT be thrown away
// every 30 days — doing so would mean re-geocoding the whole list monthly for
// no reason at all.
//
// So expiry keys off `geoSource`:
//   "address"  — Nominatim, from the stored address. Never expires.
//   "postcode" — postcodes.io centroid fallback.        Never expires.
//   "places"   — legacy, from Google.                   Expires at 30 days.
//   missing    — legacy record predating this field.    Expires at 30 days.
//
// Unknown provenance is treated as Google-derived on purpose: the safe mistake
// is deleting a coordinate we could have kept, not keeping one we had to delete.
const OPEN_GEO_SOURCES = ["address", "postcode"];

function geoExpired(lead, now) {
  if (!lead || lead.lat == null || lead.lng == null) return false;
  if (OPEN_GEO_SOURCES.includes(lead.geoSource)) return false;
  const at = Date.parse(lead.geoAt || "");
  // No timestamp means we can't prove it's fresh, so treat it as expired.
  if (isNaN(at)) return true;
  return (now - at) / 86400000 >= GEO_MAX_AGE_DAYS;
}

function stripGeo(lead) {
  const out = { ...lead };
  delete out.lat; delete out.lng; delete out.geoAt;
  // Clear provenance too. A record that keeps geoSource:"places" after its
  // coordinates are gone would mislabel whatever replaces them.
  delete out.geoSource;
  return out;
}

// Decide what lat/lng/geoAt a saved record ends up with. Incoming coordinates
// win (they're fresher); otherwise keep existing ones unless they've expired.
// A coordinate is NEVER stored without its timestamp.
function geoFields(incoming, existing, nowIso) {
  const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
  const inLat = num(incoming.lat), inLng = num(incoming.lng);
  const none = { lat: undefined, lng: undefined, geoAt: undefined, geoSource: undefined };
  if (inLat !== null && inLng !== null) {
    const at = Date.parse(incoming.geoAt || "");
    const stamp = isNaN(at) ? nowIso : new Date(at).toISOString();
    // Being handed coordinates already older than the allowance is an upstream
    // bug; drop them rather than laundering them into a fresh timestamp.
    const src = OPEN_GEO_SOURCES.includes(incoming.geoSource) ? incoming.geoSource : "places";
    // Only Google-derived coordinates can arrive already too old to keep.
    if (src === "places" && Date.now() - Date.parse(stamp) >= GEO_MAX_AGE_DAYS * 86400000) return none;
    return { lat: inLat, lng: inLng, geoAt: stamp, geoSource: src };
  }
  if (existing && existing.lat != null && existing.lng != null && !geoExpired(existing, Date.now())) {
    return { lat: existing.lat, lng: existing.lng, geoAt: existing.geoAt, geoSource: existing.geoSource };
  }
  return none;
}

// --- OUTREACH COMPLIANCE (PECR) ----------------------------------------------
//
// This decides which channels may lawfully be used for each lead, so the answer
// is computed once here rather than remembered correctly every time by a human
// at 9pm.
//
// THE RULE THAT CATCHES TREY. PECR reg. 22 (email/SMS/WhatsApp — "electronic
// mail") does NOT apply to CORPORATE subscribers (Ltd, LLP, PLC, Scottish
// partnerships, public bodies): you may cold-message them without consent.
// It DOES apply to INDIVIDUAL subscribers — sole traders and unincorporated
// partnerships — who need prior consent. Trey sells to salons, cafés, trades and
// therapists, so a large share of the list is in the restricted category.
//
// Soft opt-in is NOT available for scraped leads: it requires details obtained
// during a sale or negotiation, and these people have negotiated nothing.
//
// BUT reg. 22 is about electronic mail only. LIVE PHONE CALLS (reg. 21) are
// allowed to anyone — sole trader or not — provided the number isn't registered
// with TPS/CTPS. POST isn't covered by PECR at all. So every lead is reachable;
// the channel just depends on who they are.
//
// The intended play: call or visit a sole trader, get their consent, then flip
// them to the messaging list. Consent turns a restricted lead into an open one.
//
// PECR's maximum penalty rose to £17.5m / 4% of turnover in February 2026, and
// failing to honour an opt-out is the classic enforcement trigger — hence the
// suppression check, which overrides everything else.
// https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/

// Name suffixes that make a business a CORPORATE subscriber. Deliberately
// conservative: a false "ltd" would authorise an unlawful message, so anything
// ambiguous stays "unknown" and is treated as restricted.
// ANCHORED TO THE END of the name, not merely present in it. "The Limited
// Edition Barber" is a sole trader with an unlucky name, and classifying it as a
// company would authorise a message that PECR forbids. Errors must fall towards
// "restricted": a false negative costs a phone call, a false positive is a
// potential breach. Trailing punctuation is tolerated ("… Ltd.", "… (UK) Ltd").
const CORPORATE_RE = /(\bltd|\blimited|\bplc|\bllp|\bl\.t\.d|\bincorporated|\binc|\bcic|\bcio)[\s.,)\]]*$/i;

function inferLegalStatus(lead) {
  // An explicit value always wins — set by hand or by a Companies House check.
  const explicit = String((lead && lead.legalStatus) || "").toLowerCase();
  if (explicit === "ltd" || explicit === "sole_trader") return explicit;
  const name = String((lead && lead.businessName) || "");
  if (CORPORATE_RE.test(name)) return "ltd";
  return "unknown";
}

/**
 * What may we lawfully do with this lead, and why?
 *
 * `suppressedTails` is a Set of last-9-digit phone tails that have replied STOP
 * (written by whatsapp-inbound.js). Suppression beats everything, including
 * consent — someone who opted out has withdrawn it.
 */
// The only legal values for a lead's pipeline status. Must stay in step with
// STATUSES in leads.html and go.html.
const OUTREACH_STATUSES = ["New", "Come back", "Contacted", "On trial", "Converted", "Lost"];

function outreachPermissions(lead, suppressedTails) {
  const tail = String((lead && lead.phone) || "").replace(/\D/g, "").slice(-9);
  const suppressed = tail.length === 9 && suppressedTails && suppressedTails.has(tail);
  const status = inferLegalStatus(lead);
  const consented = lead && lead.marketingConsent === true;
  // TPS/CTPS must be screened through a licensed service; until a lead has been
  // checked we don't claim it's callable.
  const tps = String((lead && lead.tpsStatus) || "unchecked").toLowerCase();

  if (suppressed) {
    return { electronicMail: false, phone: false, post: true, legalStatus: status,
      reason: "Opted out — replied STOP. Do not contact by phone or message. Post only." };
  }
  // Belt and braces alongside the `suppressed` list (17 Aug 2026). A verbal
  // withdrawal at the door now writes to both, but a lead with no phone number
  // has no suppression-list key at all, and the flag is what covers that case.
  // Checked BEFORE the `ltd` branch, which is what used to override it.
  if (lead && lead.optedOut === true) {
    return { electronicMail: false, phone: false, post: true, legalStatus: status,
      reason: "Opted out — withdrawn in person. Do not contact by phone or message. Post only." };
  }
  if (consented) {
    return { electronicMail: true, phone: tps !== "registered", post: true, legalStatus: status,
      reason: "Consented to marketing — all channels open." };
  }
  if (status === "ltd") {
    return { electronicMail: true, phone: tps !== "registered", post: true, legalStatus: status,
      reason: "Limited company (corporate subscriber) — cold email/WhatsApp allowed. Identify yourself and give an opt-out in every message." };
  }
  return { electronicMail: false, phone: tps !== "registered", post: true, legalStatus: status,
    reason: status === "sole_trader"
      ? "Sole trader — NO cold email/SMS/WhatsApp without consent. Call, post or visit; get consent, then message."
      : "Legal status unknown — treated as a sole trader. Call, post or visit, or confirm at Companies House to unlock messaging." };
}

const norm = (s) => (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");

function leadKey(lead) {
  if (lead.id) return lead.id;
  if (lead.placeId) return "p_" + norm(lead.placeId);
  const base = norm(lead.businessName) + "_" + norm(lead.phone);
  if (base && base !== "_") return "l_" + base;
  // No stable identifier — synthesise a unique key so several same-millisecond
  // bulk-imported rows don't collide and silently overwrite each other.
  return "l_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

exports.handler = async (event) => {
  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch (e) { /* ignore */ } }
  const who = adminIdentity(event, body);
  if (!who) {
    return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const leadsStore = blobsStore("leads");
  const clientsStore = blobsStore("clients");

  async function clientMatchers() {
    const byPlace = new Set(), byName = new Set(), byPhone = new Set();
    try {
      const { blobs } = await clientsStore.list();
      await Promise.all(blobs.map(async (b) => {
        const c = await clientsStore.get(b.key, { type: "json" });
        if (!c) return;
        if (c.placeId) byPlace.add(norm(c.placeId));
        if (c.businessName) byName.add(norm(c.businessName));
        if (c.phone) byPhone.add(norm(c.phone));
      }));
    } catch (e) { /* clients store may be empty */ }
    return { byPlace, byName, byPhone };
  }
  function isClient(l, m) {
    return !!((l.placeId && m.byPlace.has(norm(l.placeId))) ||
              (l.businessName && m.byName.has(norm(l.businessName))) ||
              (l.phone && m.byPhone.has(norm(l.phone))));
  }

  if (event.httpMethod === "GET") {
    const m = await clientMatchers();
    const { blobs } = await leadsStore.list();
    const nowMs = Date.now();
    let purged = 0, purgeFailed = 0;
    const leads = await Promise.all(blobs.map(async (b) => {
      let l = await leadsStore.get(b.key, { type: "json" });
      if (!l) return null;
      // Coordinates past their 30 days are DELETED from the stored record here,
      // not merely omitted from the response. See GEO_MAX_AGE_DAYS above.
      if (geoExpired(l, nowMs)) {
        l = stripGeo(l);
        // FIXED 17 Aug 2026. This was `.catch(() => {})` and still counted the
        // lead as purged — so a failed write reported success while the
        // coordinates survived on disk. An undetectable failure of the exact
        // obligation this code exists to enforce. A failure is now counted
        // separately and logged loudly; the response still hides the stale
        // coordinates, but nobody is told they were deleted when they weren't.
        try {
          await leadsStore.setJSON(b.key, l);
          purged++;
        } catch (e) {
          purgeFailed++;
          console.error(`[leads] COORDINATE PURGE WRITE FAILED for ${b.key} — lat/lng older than ${GEO_MAX_AGE_DAYS} days are still stored:`, e.message);
        }
      }
      return { ...l, id: b.key, isClient: isClient(l, m) };
    }));
    if (purged) console.log(`[leads] purged coordinates older than ${GEO_MAX_AGE_DAYS} days from ${purged} lead(s)`);
    if (purgeFailed) console.error(`[leads] ${purgeFailed} coordinate purge write(s) FAILED — those leads still hold expired lat/lng. The nightly geo-purge will retry.`);
    // Attach the compliance verdict server-side so the UI can't disagree with it.
    let suppressedTails = new Set();
    try {
      const { blobs } = await blobsStore("suppressed").list();
      suppressedTails = new Set(blobs.map((b) => b.key));
    } catch (e) {
      // Fail SAFE: if we can't read the suppression list we must not imply that
      // messaging is fine. Every lead drops to phone/post only.
      console.error("[leads] suppression list unreadable — restricting all outreach:", e.message);
      const restricted = leads.filter(Boolean).map((l) => ({ ...l,
        outreach: { electronicMail: false, phone: true, post: true, legalStatus: inferLegalStatus(l),
          reason: "Suppression list unavailable — messaging blocked until it can be checked." } }));
      return { statusCode: 200, body: JSON.stringify(restricted) };
    }
    const withPerms = leads.filter(Boolean).map((l) => ({ ...l, outreach: outreachPermissions(l, suppressedTails) }));
    return { statusCode: 200, body: JSON.stringify(withPerms) };
  }

  if (event.httpMethod === "POST") {
    if (body.delete) {
      if (!can(who, "delete_lead")) return forbidden("delete_lead");
      await leadsStore.delete(body.delete);
      return { statusCode: 200, body: JSON.stringify({ success: true, deleted: body.delete }) };
    }

    // ---- Doorstep consent -------------------------------------------------
    // A DELIBERATELY SEPARATE PATH from the bulk upsert below, which is hard-wired
    // never to set consent. A scrape must not be able to manufacture permission to
    // message someone; a person standing in front of the owner must.
    //
    // Every ICO PECR penalty has the same root cause: the organisation could not
    // produce evidence of consent. So this stores what the ICO would ask for —
    // who agreed, when, by what method, which channels, and THE EXACT WORDS THEY
    // AGREED TO. The wording is resolved server-side from CONSENT_SCRIPTS by
    // version, never taken from the request, so a record can't claim a script that
    // was never read out. Old records keep the text that was current when taken.
    if (body.consent) {
      const c = body.consent;
      const lead = c.lead || {};
      const key = leadKey(lead);
      const existing = (await leadsStore.get(key, { type: "json" })) || {};
      const now = new Date().toISOString();

      if (c.withdraw) {
        // Withdrawal must be at least as easy as giving it, and must never erase
        // the evidence — the history is the audit trail.
        const record = { ...existing, id: key, marketingConsent: false,
          consentSource: "", optedOut: true, optedOutAt: now, updatedAt: now,
          consentHistory: [...(existing.consentHistory || []),
            { action: "withdrawn", at: now, takenBy: clean(c.takenBy, 60) || "unknown" }] };
        await leadsStore.setJSON(key, record);

        // FIXED 17 Aug 2026. Setting marketingConsent:false was not enough.
        // outreachPermissions() falls through to the `status === "ltd"` branch
        // for any limited company, which reports "cold email/WhatsApp allowed" —
        // so a verbal "stop emailing me" at the door was recorded as evidence and
        // then contradicted by the very screen that decides whether to make
        // contact. Only a WhatsApp STOP actually suppressed anything.
        //
        // The suppression list is keyed on the last 9 digits of the phone, the
        // same key whatsapp-inbound.js writes, so both routes land in one place.
        // Failing to honour an opt-out is the classic PECR enforcement trigger,
        // so a failed write is logged loudly rather than swallowed.
        try {
          const tail = String(record.phone || existing.phone || "").replace(/\D/g, "").slice(-9);
          if (tail.length === 9) {
            await blobsStore("suppressed").setJSON(tail, {
              at: now,
              source: "verbal-withdrawal",
              takenBy: clean(c.takenBy, 60) || "unknown",
              leadId: key,
            });
          }
        } catch (e) {
          console.error("[leads] SUPPRESSION WRITE FAILED on consent withdrawal — this number may keep being contacted:", e.message);
        }

        return { statusCode: 200, body: JSON.stringify({ success: true, id: key, marketingConsent: false, optedOut: true }) };
      }

      const channels = (Array.isArray(c.channels) ? c.channels : [])
        .map((x) => String(x).toLowerCase())
        .filter((x) => CONSENT_CHANNELS.includes(x));
      const script = CONSENT_SCRIPTS[c.scriptVersion] || CONSENT_SCRIPTS[CURRENT_SCRIPT];
      const givenBy = clean(c.givenBy, 80);
      const takenBy = clean(c.takenBy, 60);

      // Refuse a record that wouldn't stand up. An unusable consent record is
      // worse than none — it authorises a message you can't defend.
      const missing = [];
      if (!channels.length) missing.push("at least one channel");
      if (!givenBy) missing.push("the name of the person who agreed");
      if (!takenBy) missing.push("who took the consent");
      if (!lead.placeId && !lead.businessName) missing.push("the business");
      if (missing.length) {
        return { statusCode: 400, body: JSON.stringify({ error: "Can't record consent without " + missing.join(", ") + "." }) };
      }

      const entry = {
        action: "given", at: now, channels,
        method: clean(c.method, 40) || "verbal, in person",
        givenBy, givenByRole: clean(c.givenByRole, 60), takenBy,
        scriptVersion: script.version, wording: script.text,
        // takenBy is what the runner typed; takenByUser is who was authenticated.
        // Once runners have their own tokens the typed field can go entirely.
        takenByUser: who.id,
        where: clean(c.where, 120),
      };
      // Identity facts only. This path must not become a side door for setting
      // outreachStatus, legalStatus, tpsStatus or anything else compliance-bearing.
      const identity = {};
      for (const f of ["placeId", "businessName", "category", "phone", "website", "address"]) {
        if (lead[f]) identity[f] = clean(lead[f], 200);
      }
      const record = {
        ...existing, ...identity, id: key,
        marketingConsent: true,
        consentSource: `Verbal, in person — ${givenBy} on ${now.slice(0, 10)} (script ${script.version})`,
        consentChannels: channels,
        consentGivenAt: now,
        consentHistory: [...(existing.consentHistory || []), entry],
        outreachStatus: existing.outreachStatus || "Contacted",
        ownerId: existing.ownerId != null ? existing.ownerId : who.id,
        source: existing.source || clean(lead.source, 80) || "field walk " + now.slice(0, 10),
        createdAt: existing.createdAt || now,
        updatedAt: now,
      };
      await leadsStore.setJSON(key, record);
      return { statusCode: 200, body: JSON.stringify({ success: true, id: key, marketingConsent: true, recorded: entry }) };
    }

    const now = new Date().toISOString();
    const incoming = Array.isArray(body.leads) ? body.leads : (body.lead ? [body.lead] : []);
    // THE DISTINCTION THAT MAKES THE EDIT CONTROLS WORK.
    //
    // `leads: [...]` is a bulk import — a scrape, a CSV. It must never reset a
    // status you set by hand or invent a legal status, because getting that
    // wrong authorises an unlawful message.
    //
    // `lead: {...}` is a HUMAN editing one record in the UI. Their choice must
    // win, or the control is decorative.
    //
    // The original code applied the import guard to both, so the status pill,
    // the legal-status dropdown and the TPS dropdown all silently threw away
    // what you chose. Three dead controls, found 17 Aug.
    const isBulk = Array.isArray(body.leads);
    if (!incoming.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "No lead(s) provided" }) };
    }
    await Promise.all(incoming.map(async (raw) => {
      const key = leadKey(raw);
      const existing = (await leadsStore.get(key, { type: "json" })) || {};
      // Enrichment upsert. Re-importing the same business (matched on placeId, or
      // name+phone) UPDATES its record in place — it never creates a duplicate.
      // Two safeguards make a re-scrape non-destructive:
      //   1) Only NON-EMPTY incoming values overwrite, so a run that leaves a field
      //      blank (e.g. Apify didn't find a phone/email) can't wipe data you already
      //      have — a number you typed by hand, notes, etc. survive.
      //   2) An existing outreach status always wins, so re-scraping a lead you've
      //      moved to Contacted / On trial / Converted never resets it to "New".
      const incomingClean = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v === "" || v === null || v === undefined) continue;
        incomingClean[k] = v;
      }
      // ADDED 17 Aug 2026. outreachStatus arrives from an imported CSV and was
      // stored verbatim, then rendered into a class attribute by leads.html —
      // which is how a crafted spreadsheet cell became stored XSS with the admin
      // token as the prize. leads.html is fixed too, but a free-text value that
      // only ever has six legal states has no business being stored unvalidated.
      // Anything unrecognised falls back rather than being persisted.
      if (incomingClean.outreachStatus !== undefined
          && !OUTREACH_STATUSES.includes(String(incomingClean.outreachStatus))) {
        delete incomingClean.outreachStatus;
      }
      const record = {
        ...existing, ...incomingClean, id: key,
        outreachStatus: isBulk
          ? (existing.outreachStatus || incomingClean.outreachStatus || "New")
          : (incomingClean.outreachStatus || existing.outreachStatus || "New"),
        // Whose lead this is. Set once, on creation, and never reassigned by a
        // later import — a re-scrape must not move someone else's lead to you.
        // Ownership cannot be reconstructed after the fact, which is why it goes
        // on now rather than when there is a second person to scope it for.
        ownerId: existing.ownerId != null ? existing.ownerId : who.id,
        ...geoFields(incomingClean, existing, now),
        // Compliance facts are decided by a human (or Companies House), never by
        // a scrape. A re-import must not be able to flip a sole trader to "ltd"
        // or manufacture consent and thereby authorise an unlawful message.
        // Read from `raw`, not `incomingClean`, so a human can deliberately set it
        // BACK to "" ("Unknown — restricted"). incomingClean strips empty values,
        // which would make un-setting impossible.
        legalStatus: (!isBulk && "legalStatus" in raw)
          ? String(raw.legalStatus || "")
          : (existing.legalStatus || ""),
        marketingConsent: existing.marketingConsent === true,
        consentSource: existing.consentSource || "",
        tpsStatus: (!isBulk && "tpsStatus" in raw)
          ? (String(raw.tpsStatus || "") || "unchecked")
          : (existing.tpsStatus || "unchecked"),
        createdAt: existing.createdAt || now,
        updatedAt: now,
      };
      delete record.token;
      delete record.isClient;
      await leadsStore.setJSON(key, record);
    }));
    return { statusCode: 200, body: JSON.stringify({ success: true, saved: incoming.length }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
};

// The 30-day coordinate rule, shared with the nightly sweep (geo-purge.mjs).
//
// Exported rather than copied. Two implementations of "when does a coordinate
// expire" would drift, and the day they drift is the day the sweep quietly
// stops deleting something the read path considers stale — the failure mode
// being a Maps Platform terms breach nobody can see. `exports` and
// `module.exports` are the same object here (neither is reassigned), so adding
// these does not disturb `exports.handler` above.
module.exports.geoExpired = geoExpired;
module.exports.stripGeo = stripGeo;
module.exports.GEO_MAX_AGE_DAYS = GEO_MAX_AGE_DAYS;
module.exports.OPEN_GEO_SOURCES = OPEN_GEO_SOURCES;
