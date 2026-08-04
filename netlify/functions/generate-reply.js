const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const signOffMap = {
  "raven holistics": "Naomi",
  "salt therapy room": "Matthew",
  "salt room": "Matthew"
};

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const data = JSON.parse(event.body);

    const businessName = data.businessName || "Raven Holistics";
    const businessType = data.businessType || "business";
    const reviewer = data.reviewer || "Valued Customer";
    const rating = data.rating || 5;
    const reviewText = data.reviewText || "";
    
    // Onboarding settings: "individual" vs "company"
    const perspective = (data.perspective || "individual").toLowerCase();
    
    // Determine sign-off name
    const lookupKey = businessName.toLowerCase().trim();
    const signOffName = signOffMap[lookupKey] || data.signOff || businessName;

    // Set voice instructions based on perspective choice
    const voiceGuidance = perspective === "company"
      ? 'Use plural voice/pronouns ("we", "our", "us") representing the team.'
      : 'Use first-person singular voice/pronouns ("I", "my", "I\'m") representing an individual owner.';

    const prompt = `
You are an AI assistant drafting Google Review replies for ${businessName}, a ${businessType} business.

REVIEW DETAILS:
- Reviewer: ${reviewer}
- Rating: ${rating}/5 Stars
- Review Text: "${reviewText}"

STRICT RULES FOR THE REPLY DRAFT:
1. Perspective: ${voiceGuidance}
2. Grounding: NEVER invent specific services, treatments, products, or staff members NOT explicitly mentioned in the review text.
3. Short/Generic Reviews: If the review text is brief (e.g., "Great service!"), keep the reply short, warm, and broad.
4. Tone: Friendly, appreciative, and professional.
5. Sign-off: Always end the response strictly with "- ${signOffName}".
    `;

    const model = genAI.getGenerativeModel({ 
      model: "gemini-3.6-flash",
      generationConfig: { temperature: 0.0 }
    });
    
    const result = await model.generateContent(prompt);
    const replyDraft = result.response.text().trim();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessName,
        perspective,
        signOffName,
        replyDraft
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
