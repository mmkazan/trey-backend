// csv-lib.js — CSV cell encoding with formula-injection defence.
//
// Extracted from export.js (2026-08-18 security review, M3) so the rule can be
// unit-tested with no dependency on @netlify/blobs — the same pattern as
// link-keys.js and stripe-ordering.js.
//
// WHY: a spreadsheet (Excel, Google Sheets, LibreOffice) treats a cell whose
// first character is = + - @ (or a tab/CR it skips over to reach one) as a
// FORMULA. Trey's client and lead exports contain public, attacker-supplied
// values — a business name from self-serve signup, a lead name from an imported
// or Apify CSV — so `=HYPERLINK("http://evil",...)` or `=WEBSERVICE(...)` sitting
// in a backup would execute the moment the admin opens the file. The OWASP
// mitigation is to prefix such a cell with a single quote.

// Neutralise a value that a spreadsheet might execute as a formula. Plain numbers
// (including negatives like -5) are left untouched so real numeric columns stay
// numeric.
function csvSafe(s) {
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return "'" + s;
  return s;
}

// Encode one value as a CSV cell: formula-neutralise, then RFC-4180 quote if it
// contains a comma, quote or newline.
function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);   // flattened, and lossy — see export.js header
  const s = csvSafe(String(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { csvCell, csvSafe };
