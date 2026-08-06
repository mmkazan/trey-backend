exports.handler = async (event) => {
  const { locationId, googleUrl } = event.queryStringParameters || {};

  // Await the fetch so Netlify doesn't kill the connection mid-flight
  if (process.env.MAKE_TAP_WEBHOOK_URL) {
    try {
      await fetch(process.env.MAKE_TAP_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          locationId, 
          timestamp: new Date().toISOString() 
        })
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
