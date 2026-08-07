const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const { locationId, googleUrl } = event.queryStringParameters || {};

  if (locationId) {
    try {
      const tapsStore = getStore({ name: "taps", siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
      await tapsStore.setJSON(locationId, {
        timestamp: new Date().toISOString(),
        processed: false,
      });
    } catch (err) {
      console.error('Tap logging error:', err);
    }
  }

  const target = googleUrl
    ? decodeURIComponent(googleUrl)
    : `https://search.google.com/local/writereview?placeid=${locationId}`;

  return {
    statusCode: 302,
    headers: { Location: target }
  };
};
