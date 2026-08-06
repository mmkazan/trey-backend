exports.handler = async (event) => {
  const { locationId, googleUrl } = event.queryStringParameters || {};

  if (!locationId) {
    return { statusCode: 400, body: 'Missing locationId' };
  }

  // Log tap to Make.com Tap Webhook in the background
  if (process.env.MAKE_TAP_WEBHOOK_URL) {
    fetch(process.env.MAKE_TAP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locationId,
        timestamp: new Date().toISOString()
      })
    }).catch(err => console.error('Logging failed:', err));
  }

  // Redirect customer directly to Google Review page
  const target = googleUrl ? decodeURIComponent(googleUrl) : `https://search.google.com/local/writereview?placeid=${locationId}`;

  return {
    statusCode: 302,
    headers: {
      Location: target,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    },
    body: ''
  };
};
