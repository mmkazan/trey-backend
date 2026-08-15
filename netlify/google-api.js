// Google Business Profile API helper (v4 "My Business" API) — the engine for
// PUBLISHING a Google Post and UPLOADING a location photo on a client's behalf.
//
// Everything here is DORMANT until BOTH are true:
//   • process.env.TREY_LIVE_POSTING === "true"
//   • GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are set
// Until then isEnabled() returns false and callers fall back to copy/paste.
// This mirrors the same gate approve.js uses for posting review replies, so
// review replies, Google Posts and photo uploads all switch on together once
// your Business Profile API access (case 2-1187000041217) is approved.
//
// Scope used by the refresh token: https://www.googleapis.com/auth/business.manage
//
// NOTE (photos): the 3-step bytes upload below is coded to Google's documented
// flow but is UNVERIFIED end-to-end (can't be tested until API access is live).
// Re-check the upload URL against Google's "Upload media" docs when you enable it.

const V4 = "https://mybusiness.googleapis.com/v4";
const BINFO = "https://mybusinessbusinessinformation.googleapis.com/v1";

function creds() {
  return {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh: process.env.GOOGLE_REFRESH_TOKEN,
  };
}

// Both a master switch AND the presence of Google OAuth creds.
function isEnabled() {
  const c = creds();
  return process.env.TREY_LIVE_POSTING === "true" && !!(c.id && c.secret && c.refresh);
}

// Exchange the long-lived refresh token for a short-lived access token.
async function getAccessToken() {
  const c = creds();
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.id,
      client_secret: c.secret,
      refresh_token: c.refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error_description || data.error || "Google token refresh failed");
  return data.access_token;
}

// Publish a STANDARD Google Post (a "local post") to the client's location.
// summary = the post text (max ~1500 chars; Google truncates). Optional CTA.
async function createLocalPost({ accountId, locationId }, summary, opts = {}) {
  if (!accountId || !locationId) throw new Error("Missing Google accountId/locationId for this client");
  const token = await getAccessToken();
  const body = {
    languageCode: "en-GB",
    summary: String(summary || "").slice(0, 1490),
    topicType: "STANDARD",
  };
  if (opts.ctaUrl) {
    body.callToAction = { actionType: opts.ctaType || "LEARN_MORE", url: opts.ctaUrl };
  }
  const url = `${V4}/accounts/${accountId}/locations/${locationId}/localPosts`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google localPosts.create ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data; // { name, state, searchUrl, ... }
}

// Upload a single photo (raw bytes) as a LOCATION photo (ADDITIONAL category).
// Three-step: start upload -> PUT bytes -> create media referencing the data ref.
async function uploadLocationPhoto({ accountId, locationId }, bytes, contentType = "image/jpeg") {
  if (!accountId || !locationId) throw new Error("Missing Google accountId/locationId for this client");
  const token = await getAccessToken();
  const parent = `accounts/${accountId}/locations/${locationId}`;

  // 1) Start an upload — returns a data-ref resourceName.
  const startResp = await fetch(`${V4}/${parent}/media:startUpload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const startData = await startResp.json().catch(() => ({}));
  if (!startResp.ok || !startData.resourceName) {
    throw new Error(`Google media:startUpload ${startResp.status}: ${JSON.stringify(startData).slice(0, 200)}`);
  }
  const resourceName = startData.resourceName;

  // 2) Upload the raw bytes to the media upload endpoint for that resourceName.
  //    (Confirm this URL against Google's "Upload media" docs at enable-time.)
  const uploadResp = await fetch(
    `https://mybusiness.googleapis.com/upload/v1/media/${resourceName}?upload_type=media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
      body: bytes,
    }
  );
  if (!uploadResp.ok) {
    throw new Error(`Google media bytes upload ${uploadResp.status}: ${(await uploadResp.text().catch(() => "")).slice(0, 200)}`);
  }

  // 3) Create the media item referencing the uploaded bytes.
  const createResp = await fetch(`${V4}/${parent}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaFormat: "PHOTO",
      locationAssociation: { category: "ADDITIONAL" },
      dataRef: { resourceName },
    }),
  });
  const createData = await createResp.json().catch(() => ({}));
  if (!createResp.ok) throw new Error(`Google media.create ${createResp.status}: ${JSON.stringify(createData).slice(0, 200)}`);
  return createData; // { name, googleUrl, ... }
}

// --- Profile read / update (Business Information API v1) ---------------------
// Read a location's profile fields for the completeness audit. locationId is the
// bare id (v1 resource name is "locations/{id}", no account prefix).
async function getLocation(locationId, readMask) {
  const token = await getAccessToken();
  const mask = readMask || "name,title,categories,phoneNumbers,websiteUri,regularHours,profile,serviceItems,openInfo,storefrontAddress";
  const resp = await fetch(`${BINFO}/locations/${encodeURIComponent(locationId)}?readMask=${encodeURIComponent(mask)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google getLocation ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Apply an approved fix (categories / description / serviceItems / hours). patch
// is a partial Location; updateMask is the comma-list of fields being changed.
async function updateLocation(locationId, patch, updateMask) {
  const token = await getAccessToken();
  const resp = await fetch(`${BINFO}/locations/${encodeURIComponent(locationId)}?updateMask=${encodeURIComponent(updateMask)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google updateLocation ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Count location photos (v4 media list). Used by the completeness score.
async function listPhotoCount(accountId, locationId) {
  const token = await getAccessToken();
  const resp = await fetch(`${V4}/accounts/${accountId}/locations/${locationId}/media`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google media.list ${resp.status}`);
  return data.totalMediaItemCount || (Array.isArray(data.mediaItems) ? data.mediaItems.length : 0);
}

module.exports = { isEnabled, getAccessToken, createLocalPost, uploadLocationPhoto, getLocation, updateLocation, listPhotoCount };
