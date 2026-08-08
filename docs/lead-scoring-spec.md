Trey — Leads & Lead-Scoring Spec
Captured from the earlier design chat so it lives with the code and never gets lost again.
Sourcing
* Leads are scraped from Google Maps via Apify, city by city (matches the launch plan of targeting one city at a time).
* The raw Apify export (CSV) is run through the scoring rules below to produce a scored 15-column CSV, which is then uploaded into the Leads page.
* Longer term this can be replaced/augmented by the Places API (already set up) to enrich leads live and stay within Google's terms.
Leads page (prototype from the earlier chat — to be built + wired to the backend)
* Quick-add — type a name/business, hit enter, it's added.
* Status pills — New → Contacted → On trial → Converted / Lost, tap to change.
* Expandable cards — tap any lead to edit name, business type, phone/email, notes, and status.
* Status counts — small pill row at the top showing how many leads are in each stage.
* CSV export button — export current leads.
* Designed to be where the scored Apify CSV import lands.
* NEW for this build: bulk CSV upload, manual single add, and link to the client list so anyone already onboard shows a "Client ✓" badge (don't chase existing customers).
Lead scoring system — ADOPTED MODEL (v2)
v2 refines the original Gemini spec (kept below for reference) after testing on a real 41-business Derby scrape. Changes: reward business health (a very low rating is flagged, not crowned), make the "pain" recency-aware (unanswered 1–3★ within 12 months), and add reachability (phone/email/website) so leads you can actually contact rank higher. Every lead carries a plain-English Score Reasons breakdown.


100-point score:


* Reply gap (max 25): 0% owner-response = +25 · <30% = +18 · <60% = +8 (rate measured over the ~10 most-recent scraped reviews)
* Rating health (max 25): 4.0–4.7★ = +25 (sweet spot) · 3.5–3.99★ or 4.71–4.9★ = +15 · >4.9★ = +12 · 3.0–3.49★ = +8 · <3.0★ = 0 and flagged LOW RATING
* Recent unanswered criticism (max 20): +7 per unanswered 1–3★ review from the last 12 months, capped at 20
* Review volume (max 15): 25–300 = +15 · 10–24 or 301–800 = +10 · >800 = +6 · <10 = +4 (flagged THIN)
* Reachability (max 15): phone +6 · email +6 · website +3


Tiers: Tier 1 ≥ 72 · Tier 2 52–71 · Tier 3 < 72. Flags: LOW RATING (<3.0★), THIN (<10 reviews).


Adopted export columns (sorted Tier↑ then Score↓): Tier | Score | Business Name | Category | Primary Email | Phone | Google Rating | Total Reviews | Owner Response Rate | Recent Unanswered Poor Reviews | Key Sales Hook / Review Sample | Score Reasons | Flag | Direct Review URL | Website | Address | Outreach Status


Real-data result (41 Derby businesses): Tier 1 = 5, Tier 2 = 22, Tier 3 = 14.


________________


Original scoring spec (from Gemini — superseded by v2 above, kept for reference)
Data cleaning / exclusions
* Drop permanently or temporarily closed locations.
* Force phone numbers to string format (leading ') to protect the + and leading zeros.
* Pull emails across all emails/0–emails/16 columns (use the first non-empty as Primary Email).
* Rating falls back through: totalScore → rating → stars.
* Review count falls back through: reviewsCount → userRatingsCount.
100-point score
* Response Gap (max 40):
   * +20 if owner response rate < 30%
   * +20 if rating is 3.5★–4.6★
* Pain Point (max 30):
   * +10 per recent unanswered 1–3★ review, capped at 30
* Volume Sweet Spot (max 30):
   * +30 if 15–200 reviews
   * +15 if >200 reviews
   * +10 if <15 reviews
Tiers
* Tier 1: score ≥ 80
* Tier 2: score 60–79
* Tier 3: score < 60
Key sales hook
* The latest unanswered 1–3★ review, formatted: [1★ 01/08/2026] "review text..."
Export schema (15 columns, sorted by Tier ascending, then Score descending)
Tier | Score | Business Name | Category | Primary Email | Phone | Google Rating | Total Reviews | Owner Response Rate | Unanswered Poor Reviews Count | Key Sales Hook / Review Sample | Direct Review URL | Website | Address | Outreach Status
Open item before building the scorer
To compute owner response rate, unanswered 1–3★ reviews, and the hook quote, the scorer needs the per-review fields from the raw Apify export (e.g. reviews/N/stars, reviews/N/publishedAtDate, reviews/N/responseFromOwnerText). Exact column names must be confirmed from a real Apify CSV sample before the parser is finalised.
