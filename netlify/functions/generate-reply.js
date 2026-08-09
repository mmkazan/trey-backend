exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // Internal-only endpoint: called server-to-server by review-webhook. Require
  // the shared secret (sent as the X-Trey-Internal header) so this isn't an
  // open Gemini proxy anyone can call to burn the API key.
  const internalSecret = process.env.TREY_TAPPY_SECRET_TOKEN;
  if (internalSecret) {
    const h = event.headers || {};
    const provided = h["x-trey-internal"] || h["X-Trey-Internal"] || "";
    const a = Buffer.from(String(provided)), b = Buffer.from(String(internalSecret));
    const ok = a.length === b.length && require("crypto").timingSafeEqual(a, b);
    if (!ok) {
      return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
    }
  } else {
    console.warn("[generate-reply] TREY_TAPPY_SECRET_TOKEN not set — endpoint is unauthenticated.");
  }

  try {
    const body = JSON.parse(event.body || "{}");

    // Parameters (posted server-to-server by review-webhook)
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
      String(voicePerspective || "").toLowerCase() === "individual"
        ? "Write in the first-person singular ('I', 'my', 'me')."
        : "Write in the first-person plural ('we', 'our', 'us').";

    // System prompt with safely formatted UK English rules
    const systemPrompt = `You are writing an authentic reply to a review for ${businessName} (a ${businessType} business) received via ${source}.

Review Details:
- Reviewer: ${reviewerName}
- Star Rating: ${rating}/5
- Customer Comment: "${comment}"

Rules for the reply:
1. Language: Use UK English spelling strictly (for example: centre, apologise, organise).
2. Location Terms: Refer to the venue as ${businessType} or ${businessName}. Avoid generic words like 'center'.
3. Greeting: Always start with a polite greeting (e.g., "Hi ${reviewerName},").
4. Tone: 
   - For 4-5 star reviews: Warm, enthusiastic, personal, and appreciative.
   - For 1-3 star reviews: Serious, empathetic, professional, and urgent. Never use bracketed placeholders like [phone/email]. Express concern and offer to connect offline.
5. Contradiction Handling: If the comment is positive but the star rating is low (1-3 stars), politely acknowledge the positive feedback while asking to clarify the low star score.
6. Contact Info (Low Ratings):
   ${businessPhone ? `- Direct customer to call ${businessPhone}` : `- Invite them to reach out directly to ${publicSignOffName} or your team offline.`}
7. Perspective: ${pronounRule}
8. Specificity: MANDATORY. Address specific details mentioned in the comment.
9. Length: Keep it concise (2–3 sentences max).
10. Sign-off: Do NOT add closing words like "Warmly," or "Best,". Simply end with a clean double line break, followed strictly by "${publicSignOffName}" on its own line.`;

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

    const text =
      data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
    if (!text) {
      throw new Error("Gemini returned no reply text (possibly safety-blocked or empty).");
    }
    const replyDraft = text.trim();

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
