exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    // Extract parameters from Make payload
    const {
      businessName = "our business",
      businessType = "business",
      voicePerspective = "Individual",
      publicSignOffName = "the team",
      reviewerName = "there",
      rating = 5,
      comment = "",
    } = body;

    // Determine pronoun style based on voice perspective
    const pronounRule =
      voicePerspective.toLowerCase() === "individual"
        ? "Write in the first-person singular ('I', 'my', 'me')."
        : "Write in the first-person plural ('we', 'our', 'us').";

    // System prompt tailored for Gemini 3.6 Flash
    const systemPrompt = `You are writing an authentic reply to a Google review for ${businessName} (a ${businessType} business).

Review Details:
- Reviewer: ${reviewerName}
- Star Rating: ${rating}/5
- Customer Comment: "${comment}"

Rules for the reply:
1. Tone: 
   - For 4-5 star reviews: Warm, enthusiastic, personal, and appreciative.
   - For 1-3 star reviews: Serious, empathetic, professional, and urgent. Do NOT sound overly cheerful or use phrases like "so grateful" or "thrilled". Express immediate concern and provide a direct invitation to speak offline.
2. Perspective: ${pronounRule}
3. Specificity: MANDATORY. Explicitly mention and address specific details from the customer's comment (e.g., feeling relaxed or enjoying the staff).
4. Length: Keep it concise (2–4 sentences max).
5. Sign-off: Do NOT add closing words like "Warmly," or "Best,". Simply end with a clean line break, followed strictly by "${publicSignOffName}" on its own line.`;

    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY environment variable is missing in Netlify.");
    }

    // Call Gemini 3.6 Flash API directly via fetch
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt }] }],
        }),
      }
    );

    const data = await response.json();

    if (data.error) {
      throw new Error(`Gemini API Error: ${data.error.message}`);
    }

    const replyDraft = data.candidates[0].content.parts[0].text.trim();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyDraft: replyDraft,
        publicSignOffName: publicSignOffName,
        businessName: businessName,
      }),
    };
  } catch (error) {
    console.error("Error generating reply:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Failed to generate AI reply" }),
    };
  }
};
