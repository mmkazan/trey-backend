// The daily digest's pure half — every section builder, the date handling and
// the email renderer. Takes its data as arguments and touches nothing.
//
// SPLIT OUT DELIBERATELY. daily-digest.mjs is a Netlify v2 ESM function and
// imports @netlify/blobs, which only exists inside the Netlify runtime. A test
// that imported it could not run at all — and the code most worth testing here
// is exactly the part that has no IO in it: the window arithmetic, the "is this
// section empty" decisions, and the escaping. Same shape as phone.js, which was
// split out for the same reason after eight copies of toE164 drifted apart.
//
// CommonJS, so tests/ can require it directly; the .mjs imports it as a default.

// Caps so one runaway store cannot produce a 5MB email.
const MAX_ROWS_PER_SECTION = 40;

// EVERY scheduled function, with how often it runs.
//
// This was three entries until 18 Aug, because a two-intervals-of-slack rule is
// useless on a monthly job — it would take two months of silence to complain.
// Now that a run recording `ok:false` is reported IMMEDIATELY regardless of
// recency, the monthly and quarterly jobs are worth watching: their failures
// surface the next morning, and their staleness surfaces eventually.
//
// A name here that never appears in the run log reads as "no run ever recorded",
// so adding one commits its function to recording every exit. See runlog.js.
const EXPECTED_SCHEDULERS = [
  { name: "fetch-reviews", everyHours: 1 },
  { name: "geo-purge", everyHours: 24 },
  { name: "weekly-report-send", everyHours: 24 * 7 },
  { name: "monthly-report-send", everyHours: 24 * 31 },
  { name: "monthly-google-sync", everyHours: 24 * 31 },
  { name: "google-post-send", everyHours: 24 * 31 },
  { name: "photo-refresh-send", everyHours: 24 * 93 },
];

const iso = (d) => new Date(d).toISOString();
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Parse anything into a timestamp, or NaN. Records written by six different
// functions over three weeks are not uniformly shaped, and a bad date must not
// take a section down with it.
function ts(v) {
  if (!v) return NaN;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

const inWindow = (v, from, to) => {
  const t = ts(v);
  return Number.isFinite(t) && t >= from && t < to;
};

// ---------------------------------------------------------------------------
// Sections. Each returns { title, lines[], alert? } or null when nothing
// happened. Returning null is what makes a quiet day three lines instead of ten
// empty headings — an email that looks the same every morning stops being read.
// ---------------------------------------------------------------------------

async function sectionNewCustomers(clients, from, to) {
  const rows = clients
    .filter((c) => inWindow(c.value.createdAt, from, to))
    .map((c) => {
      const v = c.value;
      const hw = v.hardware === "fob" ? "key fob" : v.hardware === "stand" ? "stand" : "hardware not set";
      return `<b>${esc(v.businessName || c.key)}</b> — ${esc(hw)}${v.email ? ` · ${esc(v.email)}` : ""}`;
    });
  return rows.length ? { title: "New signups", lines: rows } : null;
}

async function sectionActivations(clients, from, to) {
  const rows = clients
    .filter((c) => inWindow(c.value.trialStartedAt, from, to))
    .map((c) => `<b>${esc(c.value.businessName || c.key)}</b> pressed Activate — trial running`);
  return rows.length ? { title: "Activations", lines: rows } : null;
}

// Not "what happened" but "what is about to". A trial that lapses unnoticed is a
// customer lost silently, which is the same class of failure as an undelivered
// WhatsApp.
async function sectionTrialsEnding(clients, now) {
  const rows = [];
  for (const c of clients) {
    const v = c.value;
    const started = ts(v.trialStartedAt);
    if (!Number.isFinite(started)) continue;
    if (v.subscriptionStatus === "active" || v.hardwareOnly) continue;
    const days = Number(v.trialDays) || 14;
    const endsIn = Math.ceil((started + days * 86400000 - now) / 86400000);
    if (endsIn >= 0 && endsIn <= 3) {
      rows.push(`<b>${esc(v.businessName || c.key)}</b> — trial ends ${endsIn === 0 ? "today" : `in ${endsIn} day${endsIn === 1 ? "" : "s"}`}`);
    }
  }
  return rows.length ? { title: "Trials ending", lines: rows, alert: true } : null;
}

// Delta against the stored snapshot. `baseline` is null on the very first run.
async function sectionTaps(tallies, baseline, clientName) {
  const rows = [];
  let total = 0;
  for (const [loc, count] of Object.entries(tallies)) {
    const before = baseline ? (baseline[loc] || 0) : null;
    if (before === null) continue;
    const delta = count - before;
    if (delta > 0) {
      total += delta;
      rows.push(`<b>${esc(clientName(loc))}</b> — ${delta} tap${delta === 1 ? "" : "s"}`);
    }
  }
  if (!baseline) {
    return { title: "Taps", lines: ["<i>First run — no baseline to compare against yet. Tomorrow's digest will show the change.</i>"] };
  }
  if (!rows.length) return null;
  rows.sort();
  return { title: `Taps (${total})`, lines: rows };
}

async function sectionReviews(reviews, from, to, clientName) {
  const fresh = reviews.filter((r) => inWindow(r.value.createdAt, from, to));
  if (!fresh.length) return null;
  const rows = fresh.map((r) => {
    const v = r.value;
    const stars = Number(v.rating) >= 1 && Number(v.rating) <= 5 ? "★".repeat(Number(v.rating)) : "?";
    const via = v.source === "tap" ? " (via your stand)" : "";
    return `<b>${esc(v.businessName || clientName(v.locationId))}</b> ${esc(stars)}${esc(via)} — ${esc(v.status || "pending")}`;
  });
  return { title: `New reviews (${fresh.length})`, lines: rows };
}

// A reply drafted, alerted, and then never approved is the loop failing quietly
// at the last step — the customer got the message and did nothing, or never got
// it at all. Either way it needs a human.
async function sectionAwaitingApproval(reviews, now) {
  const stale = reviews.filter((r) => {
    const v = r.value;
    if (v.status !== "pending") return false;
    const t = ts(v.createdAt);
    return Number.isFinite(t) && now - t > 24 * 3600_000;
  });
  if (!stale.length) return null;
  const rows = stale.map((r) => {
    const age = Math.floor((now - ts(r.value.createdAt)) / 86400000);
    return `<b>${esc(r.value.businessName || r.value.locationId)}</b> — waiting ${age} day${age === 1 ? "" : "s"}`;
  });
  return { title: `Replies still unapproved (${stale.length})`, lines: rows, alert: true };
}

// The section this whole digest was worth building for. twilio-status.js records
// terminal message outcomes; nothing has ever read them.
async function sectionDelivery(statuses, from, to) {
  const bad = statuses.filter((m) =>
    inWindow(m.value.at, from, to) && ["failed", "undelivered"].includes(String(m.value.status)));
  if (!bad.length) return null;
  const rows = bad.map((m) => {
    const v = m.value;
    const code = v.errorCode ? ` — Twilio ${esc(v.errorCode)}` : "";
    const hint = String(v.errorCode) === "63016"
      ? " (outside Meta's 24-hour window — this one needs a template)" : "";
    return `WhatsApp to …${esc(v.toTail || "????")} <b>${esc(v.status)}</b>${code}${hint}`;
  });
  return { title: `WhatsApps that did not arrive (${bad.length})`, lines: rows, alert: true };
}

// A scheduler that stops firing leaves no trace anywhere else in the product.
//
// `latest` maps scheduler name -> its most recent run RECORD (or null). Reading
// the record, not just the key, is what lets this distinguish three states that
// need three different responses:
//
//   never ran        -> it may never have deployed, or it dies before it logs
//   ran and FAILED   -> it is running fine and the work is failing. Actionable.
//   ran too long ago -> it has stopped firing
//
// On 18 Aug the first digest reported "fetch-reviews — no run ever recorded".
// True, and useless: fetch-reviews was in fact running every 15 minutes and
// returning early on a Google token error, on a path that wrote no run log at
// all. "No run ever recorded" sent us looking for a scheduling problem that did
// not exist. A failed run that says so is worth ten that stay quiet.
async function sectionSchedulers(runlogKeys, latest, now) {
  const lines = [];
  let anyProblem = false;
  for (const s of EXPECTED_SCHEDULERS) {
    const prefix = `${s.name}:`;
    let newest = 0;
    for (const k of runlogKeys) {
      if (!k.startsWith(prefix)) continue;
      const t = ts(k.slice(prefix.length));
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    const rec = (latest && latest[s.name]) || null;

    if (!newest) {
      // "NEVER RAN" IS ONLY EVIDENCE FOR A FREQUENT JOB.
      //
      // A job that runs monthly and has no record may simply not be due yet, or
      // may pre-date the run log existing. We cannot tell those from a genuine
      // failure without knowing when it deployed — and four red lines every
      // morning for jobs that are fine is how a reader learns to skip the red
      // box, which costs more than the check is worth.
      //
      // So: absence of a record only alarms for something that should have run
      // at least daily. A monthly job that is actually broken still surfaces the
      // moment it runs and records ok:false, which is the case that matters.
      if (s.everyHours <= 24) {
        lines.push(`<b>${esc(s.name)}</b> — no run ever recorded`);
        anyProblem = true;
      }
      continue;
    }
    // It ran. Did the run WORK? A scheduler firing perfectly on time while every
    // run fails is the worst of the three states and the old check called it fine.
    if (rec && rec.ok === false) {
      const why = rec.reason ? ` (${esc(rec.reason)})` : "";
      const detail = rec.detail ? ` — ${esc(String(rec.detail).slice(0, 120))}` : "";
      const hrs = Math.floor((now - newest) / 3600_000);
      lines.push(`<b>${esc(s.name)}</b> — last run <b>failed</b>${why}${detail}` +
                 (hrs > 0 ? ` · ${hrs}h ago` : " · just now"));
      anyProblem = true;
      continue;
    }
    // A run that COMPLETED but failed every item it touched.
    //
    // The state that matters on Google-approval day: once the refresh token is
    // fixed, fetch-reviews will get past the token step and start calling the
    // reviews API per client. If the Business Profile API is not approved yet,
    // every one of those calls 403s — the run finishes, writes ok:true, and
    // would have looked perfectly healthy here while collecting nothing.
    if (rec && rec.ok !== false && Number(rec.failed) > 0) {
      const done = Number(rec.processed) || 0;
      const all = done > 0 && Number(rec.failed) >= done;
      lines.push(`<b>${esc(s.name)}</b> — last run finished but <b>${esc(rec.failed)}</b> ` +
                 `item${Number(rec.failed) === 1 ? "" : "s"} failed` +
                 (all ? " — that is <b>everything it tried</b>" : ` of ${esc(done)}`));
      anyProblem = true;
      continue;
    }
    // Two intervals of slack, so one skipped tick is not a false alarm.
    const overdueBy = now - newest - s.everyHours * 2 * 3600_000;
    if (overdueBy > 0) {
      const hrs = Math.floor((now - newest) / 3600_000);
      lines.push(`<b>${esc(s.name)}</b> — last ran ${hrs}h ago`);
      anyProblem = true;
    }
  }
  return anyProblem ? { title: "Schedulers", lines, alert: true } : null;
}

// The most recent run-log key for each expected scheduler, so the caller can
// fetch just those few records instead of every run log ever written.
// fetch-reviews alone writes 96 a day; reading them all to answer "did the last
// one work" would be the sequential-reads defect this codebase keeps finding.
function latestRunKeys(runlogKeys) {
  const out = {};
  for (const s of EXPECTED_SCHEDULERS) {
    const prefix = `${s.name}:`;
    let best = null, bestT = 0;
    for (const k of runlogKeys || []) {
      if (!k.startsWith(prefix)) continue;
      const t = ts(k.slice(prefix.length));
      if (Number.isFinite(t) && t > bestT) { bestT = t; best = k; }
    }
    if (best) out[s.name] = best;
  }
  return out;
}

async function sectionWalks(walks, from, to) {
  const days = walks.filter((w) => inWindow(w.value.updatedAt, from, to));
  if (!days.length) return null;
  let doors = 0, signups = 0;
  for (const d of days) {
    doors += Number(d.value.doors) || 0;
    signups += Number(d.value.signups) || 0;
  }
  if (!doors && !signups) return null;
  // The one number the whole runner model rests on and nothing else can
  // reconstruct after the fact.
  const rate = signups ? ` — <b>${(doors / signups).toFixed(0)} doors per signup</b>` : "";
  return { title: "Trey Go", lines: [`${doors} door${doors === 1 ? "" : "s"} knocked, ${signups} signup${signups === 1 ? "" : "s"}${rate}`] };
}

async function sectionBilling(events, from, to) {
  const fresh = events.filter((e) => inWindow(e.value && (e.value.at || e.value.createdAt), from, to));
  if (!fresh.length) return null;
  const rows = fresh.slice(0, MAX_ROWS_PER_SECTION)
    .map((e) => esc((e.value && e.value.type) || e.key));
  return { title: `Stripe events (${fresh.length})`, lines: rows };
}

// ---------------------------------------------------------------------------

function renderEmail({ from, to, sections, notes, firstRun }) {
  const hours = Math.round((to - from) / 3600_000);
  const alerts = sections.filter((s) => s.alert);
  const quiet = !sections.length;

  const head = firstRun
    ? `First digest. Covering the last ${hours} hours.`
    : `Covering the ${hours} hours since the last digest — ${esc(iso(from).slice(0, 16).replace("T", " "))} to ${esc(iso(to).slice(0, 16).replace("T", " "))} UTC.`;

  const body = quiet
    ? `<p style="font-size:15px;color:#0f172a;margin:18px 0;">Nothing moved. No signups, no taps, no reviews, and nothing broken.</p>`
    : sections.map((s) => `
      <div style="margin:0 0 18px;padding:12px 14px;border-radius:10px;border:1px solid ${s.alert ? "#fecaca" : "#e2e8f0"};background:${s.alert ? "#fef2f2" : "#ffffff"};">
        <div style="font-weight:800;font-size:13px;letter-spacing:.02em;color:${s.alert ? "#b91c1c" : "#0f172a"};margin-bottom:8px;">${esc(s.title)}</div>
        ${s.lines.slice(0, MAX_ROWS_PER_SECTION).map((l) => `<div style="font-size:13.5px;color:#334155;line-height:1.6;">${l}</div>`).join("")}
        ${s.lines.length > MAX_ROWS_PER_SECTION ? `<div style="font-size:12px;color:#64748b;margin-top:6px;">…and ${s.lines.length - MAX_ROWS_PER_SECTION} more.</div>` : ""}
      </div>`).join("");

  // A section that failed says so. A digest that quietly drops a section is
  // worse than no digest, because it reads as "nothing happened".
  const noteBlock = notes.length
    ? `<div style="margin-top:20px;padding:10px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:12.5px;color:#92400e;">
         <b>This digest is incomplete.</b><br>${notes.map(esc).join("<br>")}
       </div>` : "";

  const subject = alerts.length
    ? `Trey — ${alerts.length} thing${alerts.length === 1 ? "" : "s"} need${alerts.length === 1 ? "s" : ""} you`
    : quiet ? "Trey — quiet day" : "Trey — daily activity";

  const html = `<!doctype html><html><body style="margin:0;background:#eef3fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:620px;margin:0 auto;padding:24px 18px;">
      <div style="font-size:17px;font-weight:800;color:#0f172a;">Trey — daily activity</div>
      <div style="font-size:12.5px;color:#64748b;margin:4px 0 20px;">${head}</div>
      ${body}
      ${noteBlock}
      <div style="font-size:11.5px;color:#94a3b8;margin-top:22px;border-top:1px solid #e2e8f0;padding-top:10px;">
        Sent by daily-digest. Sections with nothing in them are left out on purpose.
      </div>
    </div></body></html>`;

  return { subject, html };
}


// Doors you promised to go back to.
//
// "Come back" is the most common outcome of a cold knock — the owner wasn't in —
// and it is the one door you most need to find again. The status recorded the
// intent and nothing recorded WHEN, so the promise lived in your head.
//
// Overdue ones come first and never age out of the list: a door you meant to
// revisit three weeks ago is not less important than today's, it is more. That
// is the opposite of how a notification usually behaves, and it is deliberate —
// this is a to-do list, not a feed.
//
// `now` is passed in so the whole thing is testable without touching the clock.
async function sectionComeBacks(leads, now) {
  const due = [];
  for (const row of leads || []) {
    const l = (row && row.value) || {};
    if ((l.outreachStatus || "") !== "Come back") continue;
    const t = ts(l.comeBackAt);
    if (!Number.isFinite(t)) continue;      // no date set — nothing to be due
    // Anything up to the end of today counts as due. Comparing against the
    // exact minute would hide a 9am callback from a 7am digest, which is the
    // one it most needs to tell you about.
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    if (t > endOfToday.getTime()) continue;
    due.push({ l, t });
  }
  if (!due.length) return null;

  due.sort((a, b) => a.t - b.t);            // most overdue first
  const startOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const lines = due.map(({ l, t }) => {
    const days = Math.round((startOf(t) - startOf(now)) / 86400000);
    const when = days < 0
      ? (days === -1 ? "since yesterday" : Math.abs(days) + " days overdue")
      : "today";
    const at = new Date(t);
    const hhmm = String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
    const where = l.address ? " — " + esc(l.address) : "";
    return "<b>" + esc(l.businessName || l.id || "(unnamed lead)") + "</b> · " +
           esc(when) + " · " + esc(hhmm) + esc(where);
  });

  const overdue = due.filter((d) => startOf(d.t) < startOf(now)).length;
  const title = "Come back today (" + due.length + ")" +
    (overdue ? " — " + overdue + " overdue" : "");
  // Always an alert. A door you said you would return to is a promise you made
  // to a person, and it belongs at the top of the email with the other things
  // that need you, not in the activity list underneath.
  return { title: title, lines: lines, alert: true };
}

// What to persist as the next baseline.
//
// THE BUG THIS EXISTS TO PREVENT. The taps read is wrapped in a guard like every
// other read, and a guard that fails yields an empty object. Writing that empty
// object as the snapshot would mean the next run sees a baseline of `{}` — which
// is truthy, so every client looks brand new, and every client's ALL-TIME tap
// total gets reported as a single day's activity. One transient blob error and
// the next morning's email is nonsense that looks like a record day.
//
// So the snapshot only advances when the taps read actually succeeded. When it
// did not, the previous baseline is carried forward: the next delta then spans
// two days, which is the honest answer, and matches what a missed run does.
function nextSnapshot(prevState, tapTotals, tapsOk, finishedAt, windowTo) {
  const carried = (prevState && prevState.tapTotals) || null;
  // windowTo is the UPPER BOUND of the window this run reported (the `now`
  // captured before the reads), NOT finishedAt. finishedAt is minutes later,
  // after the sends. Tomorrow's window must start where today's ENDED, or every
  // event timestamped between `now` and finishedAt (a review, signup, delivery
  // failure, Stripe event during the up-to-8-minute run) falls into neither
  // window and is silently never reported. (2026-08-18 security review, M4.)
  // Fall back to finishedAt only for a state written before this field existed.
  return { finishedAt, windowTo: windowTo || finishedAt, tapTotals: tapsOk ? tapTotals : carried };
}

module.exports = {
  nextSnapshot,
  iso, esc, ts, inWindow,
  sectionNewCustomers, sectionActivations, sectionTrialsEnding, sectionTaps,
  sectionReviews, sectionAwaitingApproval, sectionDelivery, sectionSchedulers,
  sectionWalks, sectionBilling, sectionComeBacks, latestRunKeys,
  renderEmail,
  EXPECTED_SCHEDULERS, MAX_ROWS_PER_SECTION,
};
