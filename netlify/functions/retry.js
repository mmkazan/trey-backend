// Retry a send, once, properly, in one place.
//
// THE GAP THIS FILLS. The four scheduled senders each caught a failed Twilio
// call, counted it, logged it and moved on. There was no retry at all. Because
// every idempotency marker embeds the PERIOD it covers — `weekly:<loc>:<wKey>`,
// `monthly:<loc>:<mKey>`, `postsent:<loc>:<mKey>` — the next run looks for a
// different key entirely and never comes back to it. So a Twilio blip lasting
// ninety seconds on the 1st of the month did not delay that client's report: it
// lost it, permanently and silently, and the only trace was one console line.
//
// WHAT IS AND IS NOT WORTH RETRYING
//
// Retrying a request Twilio has already refused on its merits is worse than
// useless: it burns the run's time budget, it counts against the account's rate
// limit, and it cannot succeed. So:
//
//   429, 5xx, network error, timeout  -> transient. Retry.
//   other 4xx                         -> Twilio has judged the request. Stop.
//
// 21211 ("not a valid phone number") is the case that matters here. It is a 400,
// it is what a badly-stored number produces, and hammering it three times just
// delays the twenty clients queued behind it. It needs a human, not a retry.
//
// THE DEADLINE IS LOAD-BEARING. A scheduled function gets 15 minutes. Sleeping
// through a backoff and then starting a send the platform kills halfway is worse
// than not retrying at all — it leaves a client who may or may not have been
// messaged. So every wait is checked against the run's deadline first, and a
// retry that would not finish in time is abandoned deliberately and reported.

const DEFAULTS = {
  attempts: 3,          // one original + two retries
  baseDelayMs: 500,     // 500ms, then 1s. Short: a scheduler is not a user.
  maxDelayMs: 4000,
};

/**
 * True if this error is worth trying again.
 *
 * Reads the status out of the message the senders throw — `Twilio 503: ...` —
 * because that is the shape they already produce and changing all four to throw
 * a richer error is a bigger edit than this is worth. An error with no status at
 * all is a network or DNS failure, which is the most retryable thing there is.
 */
function isTransient(err) {
  const msg = String((err && err.message) || err || "");
  const m = msg.match(/\b(\d{3})\b/);
  if (!m) return true;                       // network/abort/DNS — retry
  const status = Number(m[1]);
  if (status === 429) return true;           // rate limited — backing off is the fix
  if (status >= 500 && status <= 599) return true;
  return false;                              // 4xx: Twilio has judged it
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 *
 * @param fn        the thing to do. Called with the attempt number (1-based).
 * @param opts.deadline    epoch ms the run must not overrun. Required in a
 *                         scheduled function; omit only in a test.
 * @param opts.attempts    total tries, including the first.
 * @param opts.onRetry     (err, attempt, waitMs) — for logging. Never throws.
 * @param opts.isRetryable  override the classifier (tests, non-Twilio callers).
 *
 * Throws the LAST error if every attempt fails, with `.attempts` and
 * `.gaveUpEarly` attached so the caller can report honestly rather than
 * guessing why it stopped.
 */
async function withRetry(fn, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const retryable = o.isRetryable || isTransient;
  let lastErr;

  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= o.attempts) break;
      if (!retryable(err)) {
        err.attempts = attempt;
        err.gaveUpEarly = "permanent";
        throw err;
      }
      const wait = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(2, attempt - 1));
      // Would the wait alone push us past the deadline? Then there is no point
      // waiting: stop now and let the run log say so, rather than sleeping into
      // a kill and leaving a client in an unknown state.
      if (o.deadline && Date.now() + wait >= o.deadline) {
        err.attempts = attempt;
        err.gaveUpEarly = "deadline";
        throw err;
      }
      if (o.onRetry) { try { o.onRetry(err, attempt, wait); } catch (e) { /* logging must never break a send */ } }
      await sleep(wait);
    }
  }
  if (lastErr) { lastErr.attempts = o.attempts; lastErr.gaveUpEarly = ""; }
  throw lastErr;
}

module.exports = { withRetry, isTransient, DEFAULTS };
