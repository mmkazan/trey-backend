exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed. Send a POST request." }),
    };
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "GEMINI_API_KEY environment variable is missing on Netlify!" }),
      };
    }

    const reviewData = JSON.parse(event.body);

    const systemInstruction = `
You are the AI Review Engine for 'trey.today'.
Your job is to draft polite, context-aware responses to Google reviews.

RULES:
1. STAR RATING:
   - 5 Stars: Warm, grateful, brief (2-3 sentences max).
   - 1-3 Stars: Empathetic, non-defensive, provide offline contact info. NEVER argue.
2. PRONOUNS & PERSPECTIVE:
   - If business_structure is "Solo Practitioner": ALWAYS write using "I", "me", "my" and sign off with owner_first_name if provided.
   - If business_structure is "Team": Use "We", "us", "our".

OUTPUT FORMAT: Return ONLY raw JSON:
{
  "draft_reply": "string",
  "sentiment": "Positive" | "Neutral" | "Negative",
  "requires_owner_alert": boolean,
  "summary_reason": "string"
}
`;

    // Direct REST API Call using stable gemini-1.5-flash
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            {
              parts: [{ text: `Process this review: ${JSON.stringify(reviewData)}` }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json"
          }
        }),
      }
    );

    const data = await response.json();

    if (data.error) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gemini_error: data.error }),
      };
    }

    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      const resultText = data.candidates[0].content.parts[0].text;
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: resultText,
      };
    }

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unexpected response format from Gemini", raw_google_response: data }),
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error.message }),
    };
  }
};