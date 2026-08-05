exports.handler = async (event, context) => {
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
      businessPhone = "",
      source = "Google Direct",
    } = body;

    const pronounRule =
      voicePerspective.toLowerCase() === "individual"
        ? "Write in the first-person singular ('I', 'my', 'me')."
        : "Write in the first-person plural ('we', 'our', 'us').";

    const systemPrompt = `You are writing an authentic reply to a review for ${businessName} (a ${businessType} business) received via ${source}.

Review Details:
- Reviewer: ${reviewerName}
- Star Rating: ${rating}/5
- Customer Comment: "${comment}"

Rules for the reply:
1. Greeting: Always start with a polite greeting (e.g., "Hi ${reviewerName}," or "Dear ${reviewerName},").
2. Tone: 
   - For 4-5 star reviews: Warm, enthusiastic, personal, and appreciative.
   - For 1-3 star reviews: Serious, empathetic, professional, and urgent. Never use bracketed placeholders like [phone/email]. Express immediate concern and offer to connect offline.
3. Contact Info (Low Ratings):
   ${businessPhone ? `- Direct customer to call ${businessPhone}` : '- Invite them to reach out directly to your team offline without using placeholders like [insert email].'}
4. Perspective: ${pronounRule}
5. Specificity: MANDATORY. Address specific details mentioned in the comment.
6. Length: Keep it concise (2–3 sentences max).
7. Sign-off: Do NOT add closing words like "Warmly," or "Best,". Simply end with a clean double line break, followed strictly by "${publicSignOffName}" on its own line.`;

    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY environment variable is missing in Netlify.");
    }

    // Call Gemini 3.6 Flash API
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
        source: source,
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
