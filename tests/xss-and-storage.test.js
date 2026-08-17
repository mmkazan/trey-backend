// Stored XSS (C3), token storage (H3), and the backup store list (H7).

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify", "functions");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

exports.run = function (t) {
  // === C3: the class-attribute XSS in leads.html ==========================
  //
  // clsStatus() built a CLASS ATTRIBUTE and only stripped whitespace. It
  // escaped nothing. outreachStatus arrives from an imported CSV, so a crafted
  // cell broke out of the attribute and ran on render with no click needed —
  // and the admin token in sessionStorage authorises export.js, i.e. the whole
  // customer, lead and consent database.
  const leadsHtml = read("leads.html");

  const m = leadsHtml.match(/const clsStatus=([^\n]*)/);
  t.ok(!!m, "clsStatus still exists in leads.html");
  const clsStatusSrc = m ? m[1] : "";
  t.ok(!/replace\(\/\\s\/g/.test(clsStatusSrc),
    "REGRESSION: clsStatus no longer uses the whitespace-only strip");
  t.ok(/\[\^A-Za-z0-9_-\]/.test(clsStatusSrc),
    "clsStatus allow-lists class-safe characters only");

  // Behavioural check: rebuild the helper and feed it real payloads.
  const clsStatus = eval("(" + clsStatusSrc.replace(/;\s*$/, "") + ")");
  const payloads = [
    ['"/autofocus/onfocus=fetch(0)/x="', "attribute-breakout with autofocus"],
    ['"><script>alert(1)</script>', "tag breakout"],
    ["' onmouseover='alert(1)", "single-quote breakout"],
    ['x"onclick="alert(1)', "quote injection"],
    ["`${alert(1)}`", "template-literal injection"],
  ];
  for (const [payload, label] of payloads) {
    const out = clsStatus(payload);
    t.ok(!/["'<>`=\/\\()]/.test(out), `clsStatus neutralises ${label}`);
    t.ok(/^s-[A-Za-z0-9_-]*$/.test(out), `clsStatus output stays class-safe for ${label}`);
  }
  t.eq(clsStatus("Come back"), "s-Comeback", "legitimate status still maps to its class");
  t.eq(clsStatus("New"), "s-New", "New maps unchanged");
  t.eq(clsStatus(null), "s-New", "null falls back to New");
  t.eq(clsStatus(undefined), "s-New", "undefined falls back to New");

  // Server side: an unrecognised status must not be persisted at all.
  const leadsJs = fs.readFileSync(path.join(FN, "leads.js"), "utf8");
  t.ok(/OUTREACH_STATUSES/.test(leadsJs), "leads.js defines an outreach status allow-list");
  t.ok(/delete incomingClean\.outreachStatus/.test(leadsJs),
    "leads.js drops an outreachStatus that is not on the allow-list");
  const statuses = leadsJs.match(/const OUTREACH_STATUSES = \[(.*?)\]/s);
  t.ok(statuses && statuses[1].includes('"Come back"'),
    "the allow-list carries the real pipeline statuses");

  // === H3: the field phone must not keep the admin token across restarts ===
  const goHtml = read("go.html");
  t.ok(!/localStorage\.(get|set|remove)Item\(\s*["']treyAdminToken/.test(goHtml),
    "REGRESSION: go.html no longer puts the admin token in localStorage");
  t.ok(/sessionStorage\.getItem\("treyAdminToken"\)/.test(goHtml),
    "go.html reads the token from sessionStorage");
  t.ok(/sessionStorage\.setItem\("treyAdminToken"/.test(goHtml),
    "go.html writes the token to sessionStorage");
  t.ok(/sessionStorage\.removeItem\("treyAdminToken"\)/.test(goHtml),
    "go.html clears the token from sessionStorage on 403");

  // All three admin surfaces must now agree.
  for (const f of ["admin.html", "leads.html", "go.html"]) {
    const src = read(f);
    t.ok(!/localStorage\.setItem\(\s*["']treyAdminToken/.test(src),
      `${f} does not persist the admin token in localStorage`);
  }

  // === H7: stores missing from backup, restore and erasure =================
  const exportJs = fs.readFileSync(path.join(FN, "export.js"), "utf8");
  const allStores = exportJs.match(/const ALL_STORES = \[(.*?)\];/s);
  t.ok(!!allStores, "export.js still declares ALL_STORES");
  const storeList = allStores ? allStores[1] : "";

  // walks is the one the product cannot reconstruct — walk.js's own header says
  // it is "recorded as it happens or not at all". It was in no backup, and
  // restore.js iterates this same list, so a hand-edited backup containing it
  // was discarded as an "unrecognised store".
  for (const store of ["walks", "config", "messagestatus", "runlog"]) {
    t.ok(storeList.includes(`"${store}"`), `ALL_STORES includes "${store}"`);
  }
  for (const store of ["clients", "leads", "suppressed", "stripeunmatched"]) {
    t.ok(storeList.includes(`"${store}"`), `ALL_STORES still includes "${store}"`);
  }

  // Every store the code actually writes to should be in the backup list.
  const fnFiles = fs.readdirSync(FN).filter((f) => /\.(js|mjs)$/.test(f));
  const used = new Set();
  for (const f of fnFiles) {
    const src = fs.readFileSync(path.join(FN, f), "utf8");
    for (const mm of src.matchAll(/blobsStore\(\s*["']([a-z]+)["']\s*\)/g)) used.add(mm[1]);
    for (const mm of src.matchAll(/getStore\(\{\s*name:\s*["']([a-z]+)["']/g)) used.add(mm[1]);
  }
  const missing = [...used].filter((s) => !storeList.includes(`"${s}"`));
  t.eq(missing, [], "every blob store written by the code appears in ALL_STORES");

  // walks must also be erasable — day records carry business names and what was
  // said at the door, so they are personal data under a GDPR erasure request.
  const clientJs = fs.readFileSync(path.join(FN, "client.js"), "utf8");
  t.ok(/\["walks"/.test(clientJs), "client.js deletes walk-log records for an erased client");

  // === Deleted endpoints stay deleted =====================================
  for (const gone of ["seed-demo.js", "test-review-alert.js", "test-approval-buttons.js"]) {
    t.ok(!fs.existsSync(path.join(FN, gone)), `${gone} is deleted`);
  }
  const allSrc = fnFiles.map((f) => fs.readFileSync(path.join(FN, f), "utf8")).join("\n");
  t.ok(!/seed-demo|test-review-alert|test-approval-buttons/.test(allSrc),
    "nothing still references the deleted test endpoints");

  // === Dead code stays dead ===============================================
  t.ok(!/TREY_MARK/.test(fs.readFileSync(path.join(FN, "report.js"), "utf8")),
    "the dead 7KB TREY_MARK constant is gone from report.js");
  t.ok(!/thankYouPage/.test(fs.readFileSync(path.join(FN, "tap.js"), "utf8")),
    "the uncalled thankYouPage() is gone from tap.js");
  t.ok(!/reputationStrong/.test(allSrc), "the write-only reputationStrong flag is gone");
  t.ok(!/generative-ai/.test(read("package.json")),
    "the unused @google/generative-ai dependency is gone");
};
