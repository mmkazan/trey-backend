# Trey — Enhanced Monthly Report (spec)

The "read more" page the monthly WhatsApp links to: a branded, per-client web page
showing the month's performance in a clean, screenshottable layout. Personalised
with the client's own logo. Mobile-first (it's opened from WhatsApp on a phone).

## Goal
Turn the short monthly WhatsApp summary into a shareable page a business owner is
proud to look at (and screenshot) — proof, every month, that Trey is working.

## Delivery
- A Netlify function that **server-renders a full self-contained HTML page** (same
  pattern as `tap.js`'s pause page): one request in, finished HTML out. No separate
  API call, so it loads instantly when tapped from WhatsApp.
- Suggested file: `netlify/functions/report.js`.
- Suggested URL: `/.netlify/functions/report?loc=<locationId>&m=<YYYY-MM>&k=<key>`
  (`m` optional → defaults to the last complete calendar month).

## Access / security
The page shows one client's stats, so the link must not be **guessable** (a
competitor shouldn't be able to swap in another `locationId`).
- Add a per-client key `k` = HMAC-SHA256(locationId, TREY_REPORT_SECRET) truncated,
  verified by the function. Non-guessable, no login needed, safe to send over WhatsApp.
- Reuse the existing secret-env pattern (like `TREY_TAPPY_SECRET_TOKEN`); add
  `TREY_REPORT_SECRET` on Netlify.

## Data (all already tracked — no new capture needed)
- **clients** store: `businessName`, `logoUrl`, `placeId`, `initialGoogleRating`,
  `initialReviewCount`, `googleRating` (current), `reviewCount` (current), `createdAt`.
- **taptally** store: `${loc}:${YYYY-MM}` (taps that month), `${loc}:total`.
- **reviewtally** store: `${loc}:${YYYY-MM}` → `{ tapReviews, organicReviews }` (that month).
- **stats** store: cumulative `tapReviews` / `organicReviews`.
- Google rating movement = `initialGoogleRating` → `googleRating` (synced monthly by
  `monthly-google-sync`).
- Optional review highlight: pull a recent 5★ from the **reviews** store
  (`review:${loc}:${YYYY-MM}:*`).

## Page sections (mobile-first, Trey styling — green #059669, slate #0f172a)
1. **Header** — client `logoUrl` (fallback: Trey mark), business name,
   "Your month with Trey — {Month Year}".
2. **Hero: the rating climb** — "Your Google rating: {initial}★ → {now}★" with a
   green +{delta} badge and up-arrow. Neutral wording if flat/down (no fake hype).
3. **Stat tiles** — Taps this month · New Google reviews this month.
4. **Trey's contribution** — "Trey brought in {tapReviews} of your {tapReviews+organic}
   new reviews this month" (the money line; the via-Trey / direct split).
5. **Since you joined** — total reviews gained + rating change since `createdAt`
   (the bigger journey).
6. **Customer highlight (optional)** — one recent glowing review, in quotes.
7. **Footer** — "Powered by Trey", optional link to their Google profile.
- Design: clean cards, big numbers, generous spacing, looks great as a screenshot.

## Linking it from the monthly message
The current `trey_monthly_report` template is **text-only and already submitted
(immutable)**. To add the report link we'll need a **new template version** with a
URL button ("View your full report") whose dynamic variable is the report URL, or
put the link in the body of a v2 monthly template. Decide at build time.

## Build order (for next session, in the code-connected setup)
1. `report.js` function (data read + HMAC check + HTML render).
2. `TREY_REPORT_SECRET` env var on Netlify.
3. Test with a real `loc` + generated `k` on a fake client.
4. Later: v2 monthly template with the report-link button, wired to send the URL.
