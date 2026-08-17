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
  // FAILS CLOSED, changed 17 Aug 2026. This was the third copy of the pattern
  // review-webhook.js and stripe-webhook.js were both fixed to remove on 15 Aug:
  //     if (secret) { enforce } else { warn and carry on }
  // With the var unset, the "else" is the branch that runs — and this endpoint
  // is a Gemini proxy, so that is a free public LLM endpoint with no rate limit
  // whose only signal would be the API bill. The var is set today; the guard
  // was one Netlify deletion away from being worthless.
  const internalSecret = process.env.TREY_TAPPY_SECRET_TOKEN;
  if (!internalSecret) {
    console.error("[generate-reply] TREY_TAPPY_SECRET_TOKEN is not set — refusing all requests.");
    return { statusCode: 500, body: JSON.stringify({ error: "Not configured" }) };
  }
  {
    const h = event.headers || {};
    const provided = h["x-trey-internal"] || h["X-Trey-Internal"] || "";
    const a = Buffer.from(String(provided)), b = Buffer.from(String(internalSecret));
    const ok = a.length === b.length && require("crypto").timingSafeEqual(a, b);
    if (!ok) {
      return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
    }
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
      brandVoice = "",
      // The client's last few approved replies, newest first. Every reply used
      // to be written in total isolation, so the model had no way of knowing it
      // had opened the previous three with "Thank you so much for your lovely
      // review!" and named the same room in each. Individually they read
      // beautifully; stacked on a public profile — which is how people actually
      // read them — they read as a mail merge, undermining the one thing Trey
      // sells. Passing these in is what makes variation possible at all.
      recentReplies = [],
    } = body;

    const pronounRule =
      String(voicePerspective || "").toLowerCase() === "individual"
        ? "Write in the first-person singular ('I', 'my', 'me')."
        : "Write in the first-person plural ('we', 'our', 'us').";

    // Google reviews can be a STAR RATING ONLY, with no written text — this is
    // very common on tap-driven reviews. If we hand the model an empty comment
    // AND tell it to "address specific details", it will invent what the
    // customer "said" — the single most damaging thing this product could post.
    // So branch: with no comment, forbid referencing any specifics and reply to
    // the rating alone.
    const trimmedComment = String(comment ?? "").trim();
    const hasComment = trimmedComment.length > 0;
    const ratingNum = Number(rating) || 0;

    const commentLine = hasComment
      ? `- Customer Comment: "${trimmedComment}"`
      : `- Customer Comment: (NONE — the customer left a star rating only, with no written text)`;

    const specificityRule = hasComment
      ? `8. Specificity: MANDATORY. Address specific details mentioned in the comment.`
      : `8. No written feedback: The customer left NO comment — only a ${ratingNum}-star rating. Do NOT invent, assume, quote, paraphrase, or refer to anything they "said", "mentioned", "experienced", or "enjoyed". Reply to the RATING ONLY: thank ${reviewerName} by name and ${ratingNum >= 4 ? "warmly acknowledge the positive rating and invite them back" : "acknowledge the low rating with genuine concern and invite them to reach out offline so you can put it right"}. Keep it warm and general — never specific.`;

    // The client's own 1–2 sentence description of how they sound. This is the
    // single biggest lever on reply quality — it makes every reply sound like
    // THIS business rather than a generic bot. It sets character, but must never
    // soften the sincerity/urgency owed to a low rating.
    // NOTE — this used to say "match this personality, warmth and PHRASING
    // closely", which turned the brand voice into a phrase bank: the model lifted
    // its wording verbatim into every single reply, so Raven Holistics' "tranquil
    // garden treatment room" appeared in back-to-back replies on her public
    // profile. The voice is meant to set CHARACTER, not supply a script.
    const brandVoiceBlock = (brandVoice && String(brandVoice).trim())
      ? `\nBrand Voice — how ${businessName} sounds. Match this personality and warmth; it sets the character of the reply (for low ratings, sincerity and urgency still come first). Write in this voice — do NOT copy its wording verbatim, and do not treat any phrase in it as one that must appear:\n"${String(brandVoice).trim()}"\n`
      : "";

    // Show the model what it already said for THIS business, and forbid reusing
    // it. Capped at 4 and trimmed — enough to establish the pattern to avoid
    // without bloating the prompt or the latency budget.
    const priorReplies = (Array.isArray(recentReplies) ? recentReplies : [])
      .map((r) => String(r || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 4);

    const varietyBlock = priorReplies.length
      ? `\nAlready posted for ${businessName} — these are PUBLIC and sit directly above the reply you are writing:\n` +
        priorReplies.map((r, i) => `${i + 1}. "${r.slice(0, 320)}"`).join("\n") +
        `\nVARIETY IS MANDATORY. Do NOT reuse the opening sentence, the closing sentence, or any distinctive phrase from the replies above — find a different way in and a different way out. A reader scrolling this profile must not be able to tell these were written by the same system. Re-using a specific detail (a room, a treatment, a signature touch) is allowed ONLY if it is genuinely relevant here AND you word it differently.\n`
      : "";

    // System prompt with safely formatted UK English rules
    const systemPrompt = `You are writing an authentic reply to a review for ${businessName} (a ${businessType} business) received via ${source}.

Review Details:
- Reviewer: ${reviewerName}
- Star Rating: ${rating}/5
${commentLine}
${brandVoiceBlock}${varietyBlock}
Rules for the reply:
1. Language: Use UK English spelling strictly (for example: centre, apologise, organise).
2. Location Terms: Refer to the venue as ${businessType} or ${businessName}. Avoid generic words like 'center'.
3. Greeting: Always start with a polite greeting (e.g., "Hi ${reviewerName},").
3b. Opening line: Vary it. Do NOT default to "Thank you so much for your lovely review!" — that phrase and its close variants are overused. Open in a way that responds to what THIS person actually said.
4. Tone:
   - When a Brand Voice is given above, write in it — it sets the personality of the reply, not its wording. Never quote it back.
   - For 4-5 star reviews: Warm, enthusiastic, personal, and appreciative.
   - For 1-3 star reviews: Serious, empathetic, professional, and urgent. Never use bracketed placeholders like [phone/email]. Express concern and offer to connect offline.
5. Contradiction Handling: If the comment is positive but the star rating is low (1-3 stars), politely acknowledge the positive feedback while asking to clarify the low star score.
6. Contact Info (Low Ratings):
   ${businessPhone ? `- Direct customer to call ${businessPhone}` : `- Invite them to reach out directly to ${publicSignOffName} or your team offline.`}
7. Perspective: ${pronounRule}
${specificityRule}
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
