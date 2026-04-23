const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

async function generateResponse(ChatHistory) {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: ChatHistory,
    })

    return response.text;
}

module.exports = generateResponse