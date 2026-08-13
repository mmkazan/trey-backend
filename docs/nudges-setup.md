# "Keep your profile active" nudges — setup & enable

Two new scheduled WhatsApp nudges that help Trey subscribers do the two Google
Business Profile things almost nobody does: **post monthly** and **refresh photos
quarterly**. Google rewards active profiles.

## What's in this build (5 files)
- `netlify/functions/google-post-send.mjs` — monthly (5th, 09:00 UTC). Drafts a
  short on-brand Google Post per client (Gemini, with a safe fallback) and
  WhatsApps it with a one-tap approve/copy link.
- `netlify/functions/google-post.js` — the login-free, per-post signed page: read,
  tweak, then **publish to Google** (when the API is on) or **copy/paste**.
- `netlify/functions/photo-refresh-send.mjs` — quarterly (8th of Jan/Apr/Jul/Oct).
  WhatsApps a tailored **shot-list** for the client's trade.
- `netlify/functions/whatsapp-inbound.js` — extended with a **dormant** photo branch:
  when enabled, photos a client replies with get uploaded straight to their Google
  profile. Until enabled, behaviour is exactly the old "how to reach us" reply.
- `netlify/functions/google-api.js` — the engine: publish a Post, upload a photo.
  Dormant until Google API is live.

## FAIL-SAFE
Nothing sends until you set the two Twilio content SIDs. Deploying this changes
nothing on its own. Auto-publish/photo-upload stay off until `TREY_LIVE_POSTING`
+ Google creds exist (same gate as posting review replies).

---

## Phase 1 — turn on the nudges (works NOW, no Google API)
Owners get the drafted post to copy/paste and the photo shot-list; they action them.

1. **Create 2 WhatsApp templates in Twilio** (Content Template Builder, category UTILITY):
   - **`trey_google_post`** — body uses {{1}} business name and {{2}} the drafted post,
     plus a **URL button** "View & post" pointing to:
     `https://trey.today/.netlify/functions/google-post?{{3}}`
     Example body:
     > 📣 Time for your Google post, {{1}} — keeps you showing up. Here's one ready to go:
     > "{{2}}"
     > Tap below to post it (or tweak it first).
   - **`trey_photo_refresh`** — body uses {{1}} business name and {{2}} the shot-list.
     No button needed. Example body:
     > 📸 Quarterly nudge, {{1}}: fresh photos help you rank. Snap 3–4 this week —
     > ideas: {{2}}. Add them in the Google app → your business → Photos → +.
2. **Set Netlify env vars:** `TWILIO_POST_CONTENT_SID` and `TWILIO_PHOTO_CONTENT_SID`
   to those template SIDs.
3. Deploy. Post nudge fires the 5th; photo nudge the 8th of Jan/Apr/Jul/Oct.

## Phase 2 — auto-publish + photo upload (after Google API access is approved)
Same gate as auto-posting review replies.

1. Ensure `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` are set
   and `TREY_LIVE_POSTING="true"`. → the post page's "Approve & post to Google" button
   goes live automatically.
2. Set `TREY_PHOTO_UPLOAD="true"` → the inbound photo branch wakes up, and the quarterly
   sender opens a 21-day "reply with photos" window per client.
3. Update the **`trey_photo_refresh`** template copy to: "…just reply to this message with
   your photos and we'll add them to your Google profile for you."
4. **Verify** the media bytes-upload URL in `google-api.js` against Google's current
   "Upload media" docs — it's coded to spec but untested until the API is live.

## Notes
- Exclude a client from all nudges: set `nudgesOptOut: true` on their record.
- New blob stores (auto-created): `posts`, `postsent`, `photosent`, `photoreq`.
- Links are per-post signed with `TREY_REPORT_SECRET` (same model as reports/inbox).
- Scheduled functions fire on their cron only; to test sooner, temporarily change a
  schedule or add a manual trigger.
