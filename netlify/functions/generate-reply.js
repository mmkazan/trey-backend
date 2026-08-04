const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Gemini API with your key stored in Netlify environment variables
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Custom sign-off mapping for specific business owners
const signOffMap = {
  "Raven Holistics": "Naomi",
  "Salt Therapy Room": "Matthew"
};

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const data = JSON.parse(event.body);

    // Extract dynamic fields from payload (with sensible defaults)
    const businessName = data.businessName || "Raven Holistics";
    const businessType = data.businessType || "holistic health & wellness";
    const reviewer = data.reviewer || "Valued Customer";
    const rating = data.rating || 5;
    const reviewText = data.reviewText || "";

    // Determine sign-off: Uses signOffMap first, then custom payload signOff, or defaults to businessName
    const signOffName = signOffMap[businessName] || data.signOff || businessName;

    // Construct the strict, dynamic prompt for Gemini
    const prompt = `
You are an AI assistant drafting Google Review replies for ${businessName}, a ${businessType} business.

REVIEW DETAILS:
- Reviewer: ${reviewer}
- Rating: ${rating}/5 Stars
- Review Text: "${reviewText}"

STRICT RULES FOR THE REPLY DRAFT:
1. Grounding: NEVER invent specific services, treatments, products, or staff members that are NOT explicitly mentioned in the review text above.
2. Short/Generic Reviews: If the review text is brief or generic (e.g., "Great service!"), keep the reply short, warm, and broad (e.g., "Thank you for taking the time to leave us a review! We're so glad you had a great experience.").
3. Tone: Warm, professional, and appreciative.
4. Sign-off: Always end the response strictly with "- ${signOffName}".
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const replyDraft = result.response.text().trim();

    // Return structured payload ready for Make.com / Twilio
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessName,
        reviewer,
        rating,
        reviewText,
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
