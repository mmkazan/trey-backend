// tests/signup-admin-alert.test.js
//
// The "you have a new signup" heads-up email to Matthew (2026-08-19).
//
// signup.js requires @netlify/blobs, which isn't installed in this zero-dependency
// suite, so these are source-pattern assertions (same approach as the referrer /
// re-read checks in security-review-2026-08-18.test.js). Every one FAILS on the
// pre-feature signup.js.

const fs = require("fs");
const path = require("path");
const FN = path.join(__dirname, "..", "netlify", "functions");
const signup = fs.readFileSync(path.join(FN, "signup.js"), "utf8");

exports.run = function (t) {
  // The function exists.
  t.ok(/async function sendAdminSignupAlert\(record\)/.test(signup),
    "signup: sendAdminSignupAlert(record) is defined");

  // Default recipient is info@trey.today, env-overridable.
  t.ok(/ADMIN_ALERT_TO\s*=\s*process\.env\.ADMIN_ALERT_EMAIL\s*\|\|\s*"info@trey\.today"/.test(signup),
    "signup: the alert defaults to info@trey.today and can be overridden by ADMIN_ALERT_EMAIL");
  t.ok(/to:\s*\[ADMIN_ALERT_TO\]/.test(signup),
    "signup: the alert email is addressed to ADMIN_ALERT_TO");

  // The handler actually calls it.
  const callIdx = signup.indexOf("await sendAdminSignupAlert(record)");
  t.ok(callIdx > 0, "signup: the handler invokes sendAdminSignupAlert(record)");

  // It fires INDEPENDENTLY of the customer welcome-email 24h dedupe — a duplicate
  // signup is still a record Matthew must reconcile, so the alert must not be
  // buried inside the `else` that sends the welcome email.
  const suppressIdx = signup.indexOf("welcome email suppressed");
  t.ok(suppressIdx > 0 && callIdx > suppressIdx,
    "signup: the admin alert is sent after (outside) the welcome-email dedupe branch");

  // Same never-throws contract as the welcome email: guarded on the key, wrapped.
  const fnBody = signup.slice(signup.indexOf("async function sendAdminSignupAlert"), signup.indexOf("function escapeHtml"));
  t.ok(/RESEND_API_KEY/.test(fnBody) && /return false/.test(fnBody),
    "signup: the alert quietly no-ops when RESEND_API_KEY is unset");
  t.ok(/catch \(e\)/.test(fnBody) && /finally/.test(fnBody) && /AbortController/.test(fnBody),
    "signup: the alert is wrapped (try/catch/finally) with a timeout — never blocks or fails the signup");

  // Reply goes to the customer, not to the alert's own inbox.
  t.ok(/reply_to:\s*record\.email\s*\|\|\s*RESEND_REPLY_TO/.test(fnBody),
    "signup: replying to the alert reaches the customer");

  // Subject names the business so it's scannable in the inbox.
  t.ok(/subject:\s*`New Trey signup — \$\{biz\}`/.test(fnBody),
    "signup: the subject line names the new business");
};
