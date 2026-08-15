// Tap-stand QR generator.
//
// Returns a print-ready PNG QR code for a client's tap-stand URL. Generated
// server-side (via the `qrcode` npm package) so the admin page needs no CDN or
// browser library, and the QR downloads as a clean file.
//
//   GET /.netlify/functions/tap-qr?locationId=<loc>[&size=600]
//
// The QR simply encodes the PUBLIC tap URL (the same link that goes on the
// physical stand), so this endpoint is intentionally public — no admin token.

const QRCode = require("qrcode");

// Recover the locationId from the short-link path: /q/<locationId>.
// Same reason as tap.js's locationFromPath() — the _redirects rewrite DOES run
// this function, but Netlify doesn't substitute :splat into the destination's
// query string, so /q/<id> arrived with no locationId and returned
// "locationId is required". Verified against production 15 Aug.
function locationFromPath(event) {
  const raw = (event && (event.path || event.rawUrl)) || "";
  let pathname = String(raw);
  if (/^https?:\/\//i.test(pathname)) {
    try { pathname = new URL(pathname).pathname; } catch (e) { /* keep raw */ }
  }
  const m = pathname.match(/^\/q\/([^/?#]+)/);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const loc = (params.locationId || locationFromPath(event) || "").trim();
  if (!loc) {
    return { statusCode: 400, body: JSON.stringify({ error: "locationId is required" }) };
  }

  // Keep in step with admin.html's makeTapUrl() and tap.js. We encode the SHORT
  // form (/t/<loc>, rewritten by _redirects) rather than the long function URL:
  // fewer characters means a lower-density QR, which matters on a ~30mm key fob
  // where a dense code scans badly. The long URL still works for anything already
  // printed or programmed.
  const base = process.env.URL || "https://treyv1.netlify.app";
  const tapUrl = `${base}/t/${encodeURIComponent(loc)}`;

  // Clamp size so a stray ?size= can't ask for a huge render.
  let size = parseInt(params.size, 10);
  if (!Number.isFinite(size) || size < 200) size = 600;
  if (size > 1200) size = 1200;

  try {
    const png = await QRCode.toBuffer(tapUrl, {
      type: "png",
      width: size,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172aff", light: "#ffffffff" },
    });
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
      body: png.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error("[tap-qr] generation failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: "QR generation failed" }) };
  }
};
