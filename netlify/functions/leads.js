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
function adminAuthorized(event, body) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim() || (body && body.token) || "";
  const expected = process.env.CLIENT_ADMIN_TOKEN || "";
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && require("crypto").timingSafeEqual(a, b);
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
  if (!adminAuthorized(event, body)) {
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
    const leads = await Promise.all(blobs.map(async (b) => {
      const l = await leadsStore.get(b.key, { type: "json" });
      return l ? { ...l, id: b.key, isClient: isClient(l, m) } : null;
    }));
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
      await leadsStore.delete(body.delete);
      return { statusCode: 200, body: JSON.stringify({ success: true, deleted: body.delete }) };
    }
    const now = new Date().toISOString();
    const incoming = Array.isArray(body.leads) ? body.leads : (body.lead ? [body.lead] : []);
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
      const record = {
        ...existing, ...incomingClean, id: key,
        outreachStatus: existing.outreachStatus || incomingClean.outreachStatus || "New",
        // Compliance facts are decided by a human (or Companies House), never by
        // a scrape. A re-import must not be able to flip a sole trader to "ltd"
        // or manufacture consent and thereby authorise an unlawful message.
        legalStatus: existing.legalStatus || "",
        marketingConsent: existing.marketingConsent === true,
        consentSource: existing.consentSource || "",
        tpsStatus: existing.tpsStatus || "unchecked",
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
