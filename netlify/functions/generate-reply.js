const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

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

    // Extract parameters from Make payload (Fix #1: Using publicSignOffName)
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

    // Dynamic prompt instructing OpenAI to reference specific review details (Fix #2)
    const prompt = `You are writing an authentic reply to a Google review for ${businessName} (a ${businessType} business).

Review Details:
- Reviewer: ${reviewerName}
- Star Rating: ${rating}/5
- Customer Comment: "${comment}"

Rules for the reply:
1. Tone: Warm, enthusiastic, personal, and genuinely appreciative. Avoid generic corporate clichés like "Thank you for taking the time to leave a review."
2. Perspective: ${pronounRule}
3. Specificity: MANDATORY. Explicitly mention and address specific details from the customer's comment (e.g., if they mentioned feeling relaxed, enjoying staff, or a specific treatment, highlight that!).
4. Length: Keep it concise (2–4 sentences max).
5. Sign-off: MUST end with a warm closing line on its own line, followed by the exact name: "${publicSignOffName}".

Generate the response text now:`;

    const response = await openai.createCompletion({
      model: "gpt-3.5-turbo-instruct", // Or "gpt-4" / chat completions endpoint depending on your SDK setup
      prompt: prompt,
      max_tokens: 250,
      temperature: 0.7,
    });

    const replyDraft = response.data.choices[0].text.trim();

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
      body: JSON.stringify({ error: "Failed to generate AI reply" }),
    };
  }
};
