exports.handler = async (event, context) => {
  const { accountId, locationId, reviewId, replyText, token } = event.queryStringParameters || {};

  // TOGGLE: Set to true while waiting for Google ticket approval
  const MOCK_MODE = true; 

  // 1. Security Check
  if (!token || token !== process.env.TREY_TAPPY_SECRET_TOKEN) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `
        <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #f8fafc;">
          <h1 style="color: #ef4444; font-size: 48px; margin-bottom: 10px;">⛔ Unauthorized</h1>
          <p style="color: #475569; font-size: 18px;">Invalid security token. Please try again from WhatsApp.</p>
        </body>
      `
    };
  }

  try {
    if (!MOCK_MODE) {
      // Live Google API Execution (Runs when Google approves access)
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
          grant_type: 'refresh_token',
        })
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(tokenData.error_description || 'Token refresh failed');

      const googleApiUrl = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`;

      const replyResponse = await fetch(googleApiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ comment: replyText })
      });

      if (!replyResponse.ok) {
        const errorData = await replyResponse.json();
        throw new Error(JSON.stringify(errorData));
      }
    }

    // 2. Return Mobile Success UI Screen
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reply Posted | Trey Tappy</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f1f5f9; padding: 20px;">
          <div style="background: white; border-radius: 16px; padding: 32px 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); text-align: center; max-width: 400px; width: 100%;">
            <div style="background: #dcfce7; width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
              <span style="font-size: 32px;">✅</span>
            </div>
            <h2 style="color: #0f172a; margin: 0 0 8px 0;">Posted to Google!</h2>
            <p style="color: #64748b; font-size: 15px; margin-bottom: 24px; line-height: 1.4;">Your response has been published directly to your Google Business listing.</p>
            
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: left; font-size: 13px; color: #334155; font-style: italic;">
              "${replyText}"
            </div>
            
            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">Trey Tappy • Reputation on Autopilot</p>
          </div>
        </body>
        </html>
      `
    };

  } catch (error) {
    console.error("API Error:", error.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `
        <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #f8fafc;">
          <h1 style="color: #ef4444; font-size: 36px; margin-bottom: 10px;">⚠️ Posting Failed</h1>
          <p style="color: #475569; font-size: 16px;">Error: ${error.message}</p>
        </body>
      `
    };
  }
};
