// ASK HEALTH — is the business actually asking customers to tap?
//
// Pure logic, no network, so it's fully testable. Shared by report.js (the
// client-facing coaching section), admin.html (spotting silent clients) and the
// scheduled nudge.
//
// WHY THIS EXISTS
// The stand doesn't ask. It only removes the friction — the motivation comes from
// a human saying "would you mind tapping that?". A business that never asks gets
// almost no reviews, concludes Trey doesn't work, and churns through no fault of
// the product. Trey counts taps separately from reviews, so it can SEE whether
// the asking is happening — which no competitor selling a review card can claim.
//
// TWO SIGNALS, deliberately kept apart because they mean different things:
//   1. taps/week  — is anyone asking at all?
//   2. tap→review — are the taps turning into reviews once they happen?
// High taps + low conversion is a different problem (wrong review link, people
// bouncing) from low taps (nobody's asking).
//
// HONESTY NOTE: we do not know the client's footfall, so an absolute tap count
// conflates "quiet week" with "nobody asked". All copy therefore stays curious
// rather than accusatory — "worth a nudge to the team?" not "you're failing".

const DAY = 86400000;

// The line that actually works, per trade. Short, natural, and said at the till
// or over a brew — not a script anyone would feel daft reading out.
const TIPS = {
  auto:        "As you hand the keys back: “If you were happy, would you mind tapping that? Takes ten seconds.”",
  cafe:        "As you hand the coffee over: “If you’ve got a sec, give that a tap for us — it really helps.”",
  restaurant:  "When you drop the bill: “If you enjoyed it, a quick tap on that means a lot to us.”",
  barber:      "While you’re brushing them down: “Happy with it? Give that a tap on your way out.”",
  salon:       "At the mirror, before they pay: “If you love it, would you mind tapping that for me?”",
  gym:         "After a good session: “If you’re enjoying it here, tap that on your way past — helps us loads.”",
  plumber:     "Once you’ve packed up: “All sorted — if you were happy, would you mind tapping this? Two seconds.”",
  electrician: "Before you leave: “If you’re happy with the job, a quick tap on this really helps me out.”",
  trades:      "When you’re settling up: “If you’re pleased with it, would you mind tapping that? It’s the main way people find me.”",
  dentist:     "At reception, after the appointment: “If you were looked after today, would you mind tapping that?”",
  clinic:      "As they book the next one: “If today went well, a quick tap on that helps other people find us.”",
  retail:      "As you hand over the bag: “If you found what you needed, would you mind tapping that?”",
  generic:     "As they pay or leave: “If you were happy, would you mind tapping that? Takes ten seconds.”",
};

function tipFor(trade) {
  return TIPS[trade] || TIPS.generic;
}

// Days since the owner activated the stand (null if never activated).
function daysLive(client, now) {
  const t = client && client.trialStartedAt ? new Date(client.trialStartedAt).getTime() : NaN;
  if (!isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY));
}

/**
 * askHealth({ client, taps, reviews, weeks, trade, now })
 *   taps    — taps counted in the window
 *   reviews — reviews attributed to taps in the same window
 *   weeks   — length of the window in weeks (>=1)
 *   trade   — tradeOf(businessType) from profile-audit.js
 *
 * Returns { state, severity, headline, detail, tip, tipRelevant, tapsPerWeek, conversion }.
 *   severity: 0 nothing to say · 1 gentle · 2 worth acting on
 *   tipRelevant: only true when the problem is the ASKING. A client with plenty
 *   of taps that aren't converting is already asking fine — showing them "here's
 *   how to ask" would read as if we hadn't looked at their numbers.
 */
function askHealth(input) {
  input = input || {};
  const client = input.client || {};
  const now = isFinite(input.now) ? input.now : Date.now();
  const weeks = Math.max(1, Number(input.weeks) || 4);
  const taps = Math.max(0, Number(input.taps) || 0);
  const reviews = Math.max(0, Number(input.reviews) || 0);
  const trade = input.trade || "generic";
  const tip = tipFor(trade);
  const live = daysLive(client, now);

  const tapsPerWeek = Math.round((taps / weeks) * 10) / 10;
  // Guard the denominator — a client with 0 taps has no conversion, not 0%.
  const conversion = taps > 0 ? Math.round((reviews / taps) * 100) : null;

  const base = { tapsPerWeek, conversion, tip, tipRelevant: false, taps, reviews };

  // Not activated yet — nothing to judge.
  if (live === null) {
    return Object.assign({}, base, {
      state: "not_activated", severity: 0,
      headline: "Your stand isn’t switched on yet",
      detail: "Tap it and press Activate when you’re ready to start.",
    });
  }

  // Too early to draw any conclusion.
  if (live < 3) {
    return Object.assign({}, base, {
      state: "waiting", severity: 0,
      headline: "You’re all set up",
      detail: "Give it a few days — we’ll let you know how the asking is going.",
    });
  }

  // Live, but nobody has tapped it at all.
  if (taps === 0) {
    return Object.assign({}, base, {
      state: "silent", severity: 2, tipRelevant: true,
      headline: "No taps yet",
      detail: "Your stand is live and working, but nobody has tapped it. That almost always means "
        + "the ask isn’t happening — it’s the one bit we can’t do for you.",
    });
  }

  // Taps are happening but almost nobody finishes the review. Different problem:
  // the ask is working, something downstream isn't.
  //
  // Requires the stand to have been live 14+ days. There is real lag between a
  // customer tapping and the review appearing (they write it later; Google syncs
  // on its own schedule), so flagging this in week one would cry wolf at exactly
  // the moment a new client is deciding whether to trust us.
  if (live >= 14 && taps >= 8 && conversion !== null && conversion < 25) {
    return Object.assign({}, base, {
      state: "not_converting", severity: 2,
      headline: "Plenty of taps, not many reviews",
      detail: `${taps} taps but only ${reviews} ${reviews === 1 ? "review" : "reviews"}. People are `
        + "tapping and then dropping out — worth checking your review link goes straight to the "
        + "write-a-review box, and that you’re asking people who were genuinely happy.",
    });
  }

  if (tapsPerWeek < 2) {
    return Object.assign({}, base, {
      state: "low", severity: 1, tipRelevant: true,
      headline: "The asking has gone quiet",
      detail: `About ${tapsPerWeek} ${tapsPerWeek === 1 ? "tap" : "taps"} a week. Worth a reminder to `
        + "whoever’s front of house — it slips easily when you’re busy.",
    });
  }

  if (tapsPerWeek < 6) {
    return Object.assign({}, base, {
      state: "healthy", severity: 0,
      headline: "The asking is happening",
      detail: `About ${tapsPerWeek} taps a week. Every extra ask is another review — nudge it up `
        + "when you can.",
    });
  }

  return Object.assign({}, base, {
    state: "great", severity: 0,
    headline: "Your team are on it",
    detail: `About ${tapsPerWeek} taps a week. That’s the habit that builds a rating — keep it going.`,
  });
}

module.exports = { askHealth, tipFor, TIPS, daysLive };
