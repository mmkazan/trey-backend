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

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const loc = (params.locationId || "").trim();
  if (!loc) {
    return { statusCode: 400, body: JSON.stringify({ error: "locationId is required" }) };
  }

  // Keep in step with admin.html's makeTapUrl() and tap.js — the stand link is
  // /tap?locationId=<loc>, which counts the visit and redirects to Google.
  const base = process.env.URL || "https://treyv1.netlify.app";
  const tapUrl = `${base}/.netlify/functions/tap?locationId=${encodeURIComponent(loc)}`;

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
