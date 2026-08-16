/**
 * WHO is making this admin request — not merely "is the token valid".
 *
 * WHY THIS EXISTS
 * Trey has two completely separate authentication systems and they must stay
 * separate:
 *
 *   1. SHOP OWNERS never log in. Their access is a signed capability URL —
 *      HMAC-SHA256(locationId, TREY_REPORT_SECRET). The URL *is* the account.
 *      Nothing in this file touches that, and nothing here ever should.
 *   2. THE BACK OFFICE (admin.html, leads.html, go.html) uses a shared bearer
 *      token, CLIENT_ADMIN_TOKEN. That's this file.
 *
 * The eventual direction is several people using the back office — "runners"
 * walking their own patch with go.html, each seeing their own leads. That needs
 * per-user identity and record ownership, and retrofitting *ownership* onto data
 * that never recorded it is impossible; retrofitting *login* onto code is merely
 * tedious.
 *
 * So this returns an identity object today, while there is exactly one user:
 *
 *     const who = adminIdentity(event, body);      // null when unauthorised
 *     if (!who) return unauthorized();
 *     record.ownerId = who.id;
 *
 * Every call site is then already written in the shape that supports many users.
 * Adding user #2 becomes: a users store, and a change inside THIS FILE ONLY.
 * Nothing else has to move.
 *
 * It also removes a real hazard: this comparison was previously copy-pasted into
 * four functions. Duplicated auth drifts, and auth that drifts is a security bug.
 */

const crypto = require("crypto");

// Constant-time compare that can't throw on a length mismatch (timingSafeEqual
// requires equal-length buffers, so the length check must come first).
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

/**
 * Resolve an admin request to an identity, or null.
 *
 * The token is read from the Authorization header (preferred), then the JSON
 * body, then query params — the last only because a couple of GET-only
 * maintenance endpoints need it. Query strings leak through logs, history and
 * referrers, so new endpoints should use the header.
 *
 * @returns {{id:string,name:string,role:string}|null}
 */
function adminIdentity(event, body, params) {
  const h = (event && event.headers) || {};
  const auth = h.authorization || h.Authorization || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim() ||
    (body && body.token) || (params && params.token) || "";

  if (!tokenMatches(provided, process.env.CLIENT_ADMIN_TOKEN || "")) return null;

  // One user today. The owner id is settable so the first record written after
  // this deploys is already attributed to a stable id rather than to a name that
  // might be edited later.
  return {
    id: process.env.TREY_OWNER_ID || "owner",
    name: process.env.TREY_OWNER_NAME || "Trey",
    role: "owner",
  };
}

/**
 * Role gate. Today every authenticated user is the owner, so this passes
 * trivially — the point is that the CHECK EXISTS at the dangerous call sites, so
 * the day a second person holds a token nobody has to remember to add it under
 * pressure.
 *
 * ROLES (intended, not yet implemented):
 *   owner  — everything, including destructive deletes and billing
 *   runner — their own leads; may create clients; may NOT delete
 */
function can(identity, action) {
  if (!identity) return false;
  // export_data is here because a full backup is every customer, every lead and
  // every consent record in one file — not something a runner should be able to
  // walk out with.
  const OWNER_ONLY = ["delete_client", "delete_lead", "billing", "manage_users",
    "export_data", "restore_data"];
  if (OWNER_ONLY.includes(action)) return identity.role === "owner";
  return true;
}

const unauthorized = () => ({
  statusCode: 403,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: "Unauthorized" }),
});

const forbidden = (action) => ({
  statusCode: 403,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: `Your account can't ${String(action).replace(/_/g, " ")}.` }),
});

module.exports = { adminIdentity, can, unauthorized, forbidden, tokenMatches };
