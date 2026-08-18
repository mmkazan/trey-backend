const { getStore } = require("@netlify/blobs");
const { adminIdentity, can, unauthorized, forbidden } = require("./admin-auth.js");
const { csvCell: csvLibCell } = require("./csv-lib.js");

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
  // ADDED 17 Aug 2026. "walks" was missing, and walk.js's own header says the
  // door-knock log "is recorded as it happens or not at all" — nothing else in
  // the product can reconstruct it. It was in no backup, and because restore.js
  // iterates this same list, a hand-edited backup containing it was discarded
  // as an "unrecognised store". "config" and "runlog" were missing too.
  "walks", "walkplans", "config", "runlog", "messagestatus",
];

// A per-store ceiling so one enormous store can't blow the function's time limit
// and hand back a truncated file that LOOKS complete. If it's ever hit, the
// backup says so, loudly, in the file and in the response.
const MAX_KEYS_PER_STORE = 5000;

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

// Netlify kills a synchronous function at 10 seconds. The first version fetched
// every blob STRICTLY SEQUENTIALLY — one network round trip each — and with a few
// hundred records across twenty stores that ran past the limit and the whole
// thing died with a 502. The CSV kept working because it only ever reads ONE
// store, which is why the two behaved differently.
//
// Fetching in parallel batches turns minutes of round trips into seconds.
const FETCH_CONCURRENCY = 25;

async function dumpStore(name, deadline) {
  const store = blobsStore(name);
  const out = { entries: {}, count: 0, truncated: false, error: null, timedOut: false };
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

  for (let i = 0; i < blobs.length; i += FETCH_CONCURRENCY) {
    if (deadline && Date.now() > deadline) { out.timedOut = true; break; }
    const batch = blobs.slice(i, i + FETCH_CONCURRENCY);
    await Promise.all(batch.map(async (b) => {
      try {
        out.entries[b.key] = await store.get(b.key, { type: "json" });
      } catch (e) {
        // Not every blob is JSON. Keep the raw text rather than dropping the record.
        try { out.entries[b.key] = { __raw: await store.get(b.key) }; }
        catch (e2) { out.entries[b.key] = { __unreadable: e2.message }; }
      }
    }));
  }
  out.count = Object.keys(out.entries).length;
  return out;
}

// --- CSV ---------------------------------------------------------------------

// Excel decides a CSV's encoding by sniffing, and gets UTF-8 wrong without a byte
// order mark — "£25" arrives as "Â£25". The BOM is what stops that.
const BOM = "﻿";

// CSV cell encoding + formula-injection defence now lives in csv-lib.js so it
// can be unit-tested without @netlify/blobs (2026-08-18 security review, M3).
function csvCell(v) {
  return csvLibCell(v);
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
  // No `params` argument: the admin token must come from the Authorization
  // header or the POST body, NEVER the query string. A token in a URL lands in
  // Netlify's request logs, browser history and any Referer — and this endpoint
  // returns every client, lead and consent record in one file.
  const who = adminIdentity(event, null);
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

    // Let the caller grab a subset, so an enormous single store can always be
    // fetched on its own even if everything at once won't fit in the time.
    const only = String(params.stores || "").split(",").map((x) => x.trim()).filter(Boolean);
    const wanted = only.length ? ALL_STORES.filter((s) => only.includes(s)) : ALL_STORES;
    if (only.length && !wanted.length) {
      return { statusCode: 400, body: JSON.stringify({ error: `Unknown store(s). Valid: ${ALL_STORES.join(", ")}` }) };
    }

    const deadline = Date.now() + 8000;
    const stores = {};
    let total = 0;
    const truncated = [];
    const incomplete = [];
    for (const name of wanted) {
      const d = await dumpStore(name, deadline);
      stores[name] = d.entries;
      total += d.count;
      if (d.truncated) truncated.push({ store: name, saved: d.count, total: d.totalKeys });
      if (d.timedOut) incomplete.push(name);
      if (Date.now() > deadline && wanted.indexOf(name) < wanted.length - 1) {
        // Ran out of time with stores still to go. A backup that LOOKS complete
        // but isn't is the worst possible outcome, so refuse rather than hand
        // one over.
        const done = wanted.slice(0, wanted.indexOf(name) + 1);
        const missed = wanted.filter((s) => !done.includes(s));
        return { statusCode: 200, headers: headers("trey-backup-INCOMPLETE.json", "application/json; charset=utf-8"),
          body: JSON.stringify({
            error: "Too much data to back up in one request.",
            partial: true, completed: done, missing: missed,
            advice: `Download these separately: /.netlify/functions/export?format=json&stores=${missed.join(",")}`,
          }) };
      }
    }
    if (incomplete.length) {
      return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({
          error: `Ran out of time reading: ${incomplete.join(", ")}. Nothing was written to; this is a read-only operation.`,
          partial: true,
          advice: `Download the big ones on their own: /.netlify/functions/export?format=json&stores=${incomplete.join(",")}`,
        }) };
    }

    const backup = {
      _trey_backup: 1,
      takenAt: new Date().toISOString(),
      takenBy: who.id,
      site: process.env.URL || "",
      storeCount: wanted.length,
      partOfSet: only.length ? only : null,
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
