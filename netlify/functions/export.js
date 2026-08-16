const { getStore } = require("@netlify/blobs");
const { adminIdentity, can, unauthorized, forbidden } = require("./admin-auth.js");

/**
 * TAKE A COPY OF EVERYTHING, so a bad day is an inconvenience and not the end.
 *
 *   GET /.netlify/functions/export?format=json   -> full backup, every store
 *   GET /.netlify/functions/export?format=csv    -> clients, for Excel
 *   GET /.netlify/functions/export?format=csv&what=leads
 *
 * TWO FORMATS ON PURPOSE, because they do different jobs:
 *
 *   CSV  is for READING. Open it in Excel, sort it, send someone a column. It is
 *        NOT a backup: it flattens nested data (a lead's consentHistory is an
 *        array of records — the evidence that a message was lawful), loses types,
 *        and cannot be reloaded faithfully.
 *   JSON is for RESTORING. Every store, every key, exactly as stored. Ugly to
 *        look at, but it is the thing that gets the business back.
 *
 * If you only ever download one, download the JSON.
 *
 * NOTE THIS FILE CONTAINS PERSONAL DATA — names, phone numbers, email addresses
 * and consent records. Once downloaded it's a copy living on a laptop, and it's
 * covered by the same obligations as the live data. Keep it somewhere sensible
 * and delete old ones.
 */

// Every store Trey writes to. Kept deliberately explicit rather than discovered,
// so adding a store without adding it here is a visible omission rather than a
// silently incomplete backup.
//
// MUST STAY IN STEP WITH client.js's delete lists. If a store is worth wiping
// per-client, it's worth backing up.
const ALL_STORES = [
  "clients", "leads",                                    // the irreplaceable ones
  "taps", "taptally", "stats", "reviewtally", "ratinghistory",  // history/counters
  "reviews", "reviewsseen", "posts", "postsent", "photosent", "photoreq",
  "reportssent", "approvalpending",
  "refcodes", "stripecustomers", "stripeevents", "stripeunmatched",
  "suppressed",                                          // the STOP list — legally load-bearing
];

// A per-store ceiling so one enormous store can't blow the function's time limit
// and hand back a truncated file that LOOKS complete. If it's ever hit, the
// backup says so, loudly, in the file and in the response.
const MAX_KEYS_PER_STORE = 5000;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

async function dumpStore(name) {
  const store = blobsStore(name);
  const out = { entries: {}, count: 0, truncated: false, error: null };
  let blobs = [];
  try {
    ({ blobs } = await store.list());
  } catch (e) {
    // A store that has never been written to may not exist. That's not a failure.
    out.error = e.message;
    return out;
  }
  if (blobs.length > MAX_KEYS_PER_STORE) {
    out.truncated = true;
    out.totalKeys = blobs.length;
    blobs = blobs.slice(0, MAX_KEYS_PER_STORE);
  }
  for (const b of blobs) {
    try {
      out.entries[b.key] = await store.get(b.key, { type: "json" });
    } catch (e) {
      // Not every blob is JSON. Keep the raw text rather than dropping the record.
      try { out.entries[b.key] = { __raw: await store.get(b.key) }; }
      catch (e2) { out.entries[b.key] = { __unreadable: e2.message }; }
    }
  }
  out.count = Object.keys(out.entries).length;
  return out;
}

// --- CSV ---------------------------------------------------------------------

// Excel decides a CSV's encoding by sniffing, and gets UTF-8 wrong without a byte
// order mark — "£25" arrives as "Â£25". The BOM is what stops that.
const BOM = "﻿";

function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);   // flattened, and lossy — see the header comment
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Columns worth seeing first. Everything else follows alphabetically, so a field
// added later still appears rather than being silently dropped.
const CSV_FIRST = {
  clients: ["locationId", "businessName", "contactFirstName", "contactSurname", "phone",
    "phoneRaw", "email", "companyAddress", "subscriptionStatus", "plan", "hardware",
    "country", "ownerId", "createdAt"],
  leads: ["businessName", "category", "phone", "website", "address", "outreachStatus",
    "legalStatus", "marketingConsent", "consentChannels", "consentGivenAt", "ownerId",
    "source", "createdAt"],
};

function toCsv(records, kind) {
  if (!records.length) return BOM + "No records\n";
  const seen = new Set();
  records.forEach((r) => Object.keys(r || {}).forEach((k) => seen.add(k)));
  const first = (CSV_FIRST[kind] || []).filter((k) => seen.has(k));
  const rest = [...seen].filter((k) => !first.includes(k)).sort();
  const cols = [...first, ...rest];
  const lines = [cols.join(",")];
  for (const r of records) lines.push(cols.map((c) => csvCell(r && r[c])).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}

// --- handler -----------------------------------------------------------------

exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  const who = adminIdentity(event, null, params);
  if (!who) return unauthorized();
  // A full dump of every customer, lead and consent record is not something a
  // future runner should be able to take off the premises.
  if (!can(who, "export_data")) return forbidden("export_data");

  const stamp = new Date().toISOString().slice(0, 10);
  const format = String(params.format || "json").toLowerCase();

  // Worth a line in the logs: this is the whole database leaving the building.
  console.warn(`[export] ${format} export by ${who.id}`);

  const headers = (filename, type) => ({
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${filename}"`,
    // Never let a copy of the customer database sit in a CDN or browser cache.
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
  });

  try {
    if (format === "csv") {
      const what = String(params.what || "clients").toLowerCase();
      if (!["clients", "leads"].includes(what)) {
        return { statusCode: 400, body: JSON.stringify({ error: "what must be clients or leads" }) };
      }
      const dump = await dumpStore(what);
      const records = Object.entries(dump.entries).map(([key, v]) =>
        (v && typeof v === "object" ? { id: key, ...v } : { id: key, value: v }));
      return {
        statusCode: 200,
        headers: headers(`trey-${what}-${stamp}.csv`, "text/csv; charset=utf-8"),
        body: toCsv(records, what),
      };
    }

    const stores = {};
    let total = 0;
    const truncated = [];
    for (const name of ALL_STORES) {
      const d = await dumpStore(name);
      stores[name] = d.entries;
      total += d.count;
      if (d.truncated) truncated.push({ store: name, saved: d.count, total: d.totalKeys });
    }

    const backup = {
      _trey_backup: 1,
      takenAt: new Date().toISOString(),
      takenBy: who.id,
      site: process.env.URL || "",
      storeCount: ALL_STORES.length,
      recordCount: total,
      // If anything was capped, say so IN THE FILE. A backup that quietly omits
      // records is worse than no backup, because you'd trust it.
      truncated,
      // Secrets are env vars and are NOT in here. A restore needs them set again:
      // CLIENT_ADMIN_TOKEN, TREY_REPORT_SECRET, TREY_WEBHOOK_SECRET, the Twilio,
      // Stripe, Google and Resend keys.
      note: "Restore needs the environment variables too — they are not in this file.",
      stores,
    };
    if (truncated.length) console.warn("[export] TRUNCATED:", JSON.stringify(truncated));

    return {
      statusCode: 200,
      headers: headers(`trey-backup-${stamp}.json`, "application/json; charset=utf-8"),
      body: JSON.stringify(backup, null, 2),
    };
  } catch (err) {
    console.error("[export] failed:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Export failed: " + err.message }) };
  }
};

module.exports.toCsv = toCsv;
module.exports.csvCell = csvCell;
module.exports.ALL_STORES = ALL_STORES;
