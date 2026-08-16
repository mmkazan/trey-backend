const { getStore } = require("@netlify/blobs");
const { adminIdentity, can, unauthorized, forbidden } = require("./admin-auth.js");
const { ALL_STORES } = require("./export.js");

/**
 * PUT A BACKUP BACK.
 *
 *   POST { backup, mode:"preview" }                     -> what WOULD change (default)
 *   POST { backup, mode:"missing" }                     -> create only what's absent
 *   POST { backup, mode:"overwrite", confirm:"OVERWRITE" } -> replace matching keys too
 *
 * A restore is more dangerous than the problem it solves. The failure everybody
 * has is the same: you reach for the backup on a bad day, run it in a panic, and
 * it overwrites good data with an older copy — turning a partial loss into a
 * total one. So this is built to be boring:
 *
 *   - PREVIEW IS THE DEFAULT. Ask it to restore and it tells you what it would do.
 *     You have to ask a second time, differently, to make it happen.
 *   - "missing" NEVER OVERWRITES. It only creates keys that aren't there. This is
 *     the mode for "I deleted a client by mistake" and it cannot lose data.
 *   - "overwrite" needs the word typed out. It replaces keys present in the file.
 *   - NOTHING IS EVER DELETED. Records that exist now but aren't in the backup are
 *     left alone. A restore can only add or replace, never subtract — so an old
 *     backup can't wipe out newer customers.
 *
 * That last rule is what makes restoring a stale backup survivable.
 */

const MODES = ["preview", "missing", "overwrite"];
const CONFIRM_WORD = "OVERWRITE";

function blobsStore(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

// export.js stores a non-JSON blob as {__raw:"…"} and an unreadable one as
// {__unreadable:"…"}. Unwrap the first; refuse to restore the second, because
// writing a placeholder over a real value would be worse than leaving the gap.
function valueFor(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if ("__unreadable" in v) return { skip: true };
    if ("__raw" in v) return { raw: String(v.__raw) };
  }
  return { json: v };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  // Netlify caps a synchronous function's request body at roughly 6 MB. A backup
  // bigger than that never even reaches this code, so say what to do about it
  // rather than letting it look like a mystery failure.
  const rawLen = (event.body || "").length;
  if (rawLen > 5_500_000) {
    return json(413, {
      error: `That backup is ${(rawLen / 1048576).toFixed(1)} MB, past what one request can carry.`,
      advice: "Export and restore one store at a time: Full backup with ?stores=leads, then ?stores=clients, and so on.",
    });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "That file isn't valid JSON. Is it the .json backup rather than the .csv?" }); }

  const who = adminIdentity(event, body);
  if (!who) return unauthorized();
  if (!can(who, "restore_data")) return forbidden("restore_data");

  const backup = body.backup;
  if (!backup || typeof backup !== "object") return json(400, { error: "No backup supplied." });
  // The marker stops someone restoring a CSV, a half-downloaded file, or some
  // other JSON entirely — all of which would otherwise write nonsense into the
  // stores and be very hard to unpick.
  if (backup._trey_backup !== 1) {
    return json(400, { error: "That doesn't look like a Trey backup. Use the .json file from the Full backup button." });
  }
  if (!backup.stores || typeof backup.stores !== "object") {
    return json(400, { error: "That backup has no stores in it." });
  }

  const mode = String(body.mode || "preview").toLowerCase();
  if (!MODES.includes(mode)) return json(400, { error: `mode must be one of: ${MODES.join(", ")}` });
  if (mode === "overwrite" && String(body.confirm || "").trim() !== CONFIRM_WORD) {
    return json(400, { error: `To overwrite existing records, type ${CONFIRM_WORD} to confirm.` });
  }

  const warnings = [];
  // A truncated backup is not a complete picture. Say so before anything is
  // written, not after — the file records this precisely so it can be surfaced.
  if (Array.isArray(backup.truncated) && backup.truncated.length) {
    for (const t of backup.truncated) {
      warnings.push(`"${t.store}" was capped when this backup was taken — it holds ${t.saved} of ${t.total} records.`);
    }
  }
  if (backup.site && process.env.URL && backup.site !== process.env.URL) {
    warnings.push(`This backup came from ${backup.site}, and you're restoring into ${process.env.URL}.`);
  }
  const unknown = Object.keys(backup.stores).filter((s) => !ALL_STORES.includes(s));
  if (unknown.length) warnings.push(`Ignoring unrecognised store(s): ${unknown.join(", ")}.`);

  const plan = {};
  let toCreate = 0, toOverwrite = 0, identical = 0, skipped = 0;

  // Netlify kills a synchronous function at 10 seconds, and this does a read AND
  // a write per record. Done one at a time — as the first version did — a few
  // hundred records is well past the limit and the whole restore dies.
  //
  // Batching is safe here in a way it wouldn't be for most writes, because a
  // restore is IDEMPOTENT: anything already put back shows as "identical" next
  // time round. So running out of time is recoverable — say what's left and let
  // the user press again — rather than a half-finished mess.
  const CONCURRENCY = 20;
  const DEADLINE = Date.now() + 7500;
  let ranOutOfTime = false;

  try {
    for (const name of ALL_STORES) {
      if (ranOutOfTime) break;
      const entries = backup.stores[name];
      if (!entries || typeof entries !== "object") continue;
      const keys = Object.keys(entries);
      if (!keys.length) continue;

      const store = blobsStore(name);
      const s = { create: 0, overwrite: 0, identical: 0, skipped: 0, remaining: 0, examples: [] };

      for (let i = 0; i < keys.length; i += CONCURRENCY) {
        if (Date.now() > DEADLINE) {
          ranOutOfTime = true;
          s.remaining += keys.length - i;
          break;
        }
        await Promise.all(keys.slice(i, i + CONCURRENCY).map(async (key) => {
          const v = valueFor(entries[key]);
          if (v.skip) { s.skipped++; skipped++; return; }

          let existing;
          let exists = true;
          try { existing = await store.get(key, { type: "json" }); }
          catch (e) { try { existing = await store.get(key); } catch (e2) { existing = null; } }
          if (existing === null || existing === undefined) exists = false;

          const incoming = "raw" in v ? v.raw : v.json;
          if (exists && same(existing, incoming)) { s.identical++; identical++; return; }

          if (exists) {
            s.overwrite++; toOverwrite++;
            if (s.examples.length < 5) s.examples.push({ key, action: "overwrite" });
            if (mode !== "overwrite") return;            // preview, or "missing": leave it alone
          } else {
            s.create++; toCreate++;
            if (s.examples.length < 5) s.examples.push({ key, action: "create" });
            if (mode === "preview") return;
          }

          if ("raw" in v) await store.set(key, v.raw);
          else await store.setJSON(key, v.json);
        }));
      }
      if (s.create || s.overwrite || s.identical || s.skipped || s.remaining) plan[name] = s;
    }
  } catch (err) {
    console.error("[restore] failed part-way:", err);
    return json(500, {
      error: "Restore failed part-way through: " + err.message,
      partial: true, plan,
      note: "Nothing was deleted. Re-running is safe — records already restored will show as identical.",
    });
  }

  const applied = mode !== "preview";
  if (applied) {
    console.warn(`[restore] ${mode} by ${who.id}: created ${toCreate}, overwrote ${mode === "overwrite" ? toOverwrite : 0}`);
  }

  if (ranOutOfTime) warnings.push(
    "Ran out of time part-way. Nothing is broken — restoring is safe to repeat, " +
    "and anything already put back will show as identical. Press the same button again.");

  return json(200, {
    mode, applied, ranOutOfTime,
    backupTakenAt: backup.takenAt || null,
    backupTakenBy: backup.takenBy || null,
    summary: {
      created: applied ? toCreate : 0,
      overwritten: applied && mode === "overwrite" ? toOverwrite : 0,
      wouldCreate: toCreate,
      wouldOverwrite: toOverwrite,
      identical, skipped,
    },
    plan, warnings,
    // Stated on every response, because it's the fact that makes restoring a
    // stale backup safe and people don't believe it unless you keep saying it.
    note: "Nothing is ever deleted by a restore. Records not in the backup are left untouched.",
  });
};

module.exports.valueFor = valueFor;
module.exports.CONFIRM_WORD = CONFIRM_WORD;
