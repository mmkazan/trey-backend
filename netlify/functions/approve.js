const axios = require('axios');

exports.handler = async (event, context) => {
  // 1. Extract query parameters from WhatsApp click
  const { accountId, locationId, reviewId, replyText, token } = event.queryStringParameters;

  // 2. Security Check (Validate secret token)
  if (!token || token !== process.env.TREY_TAPPY_SECRET_TOKEN) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #f8fafc;">
          <h1 style="color: #ef4444; font-size: 48px; margin-bottom: 10px;">⛔ Unauthorized</h1>
          <p style="color: #475569; font-size: 18px;">Invalid security token. Please try again from WhatsApp.</p>
        </body>
      `
    };
  }

  try {
    // 3. Obtain Google API Access Token (Stored in env or refreshed)
    const googleAccessToken = process.env.GOOGLE_BUSINESS_ACCESS_TOKEN;

    // 4. Construct Google Business Profile API endpoint
    // Endpoint: accounts/{accountId}/locations/{locationId}/reviews/{reviewId}/reply
    const googleApiUrl = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`;

    // 5. Post the reply directly to Google
    await axios.put(
      googleApiUrl,
      { comment: replyText },
      {
        headers: {
          'Authorization': `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // 6. Return mobile-friendly success confirmation screen
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
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
    console.error("Google API Error:", error.response ? error.response.data : error.message);
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #f8fafc;">
          <h1 style="color: #ef4444; font-size: 36px; margin-bottom: 10px;">⚠️ Posting Failed</h1>
          <p style="color: #475569; font-size: 16px;">Could not connect to Google Business API. Please check your credentials or try again later.</p>
        </body>
      `
    };
  }
};
