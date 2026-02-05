const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

/**
 * Detects if a message contains harassment or inappropriate content
 * @param {string} message - The message to check
 * @returns {Promise<{isHarassment: boolean, reason: string}>}
 */
async function detectHarassment(message) {
    try {
        const prompt = `Analyze the following message for harassment, hate speech, bullying, threats, or inappropriate content. 
        
Message: "${message}"

Respond ONLY with a JSON object in this exact format:
{
    "isHarassment": true/false,
    "reason": "brief explanation"
}

Be strict but fair. Consider context. Common harassment includes: threats, hate speech, sexual harassment, bullying, discrimination, or encouraging harm.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{
                role: "user",
                parts: [{ text: prompt }]
            }],
        });

        const responseText = response.text.trim();
        
        // Try to parse JSON response
        let result;
        try {
            // Extract JSON from response if it's wrapped in markdown or code blocks
            let jsonText = responseText;
            
            // Remove markdown code blocks if present
            jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            
            // Try to find JSON object
            const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                result = JSON.parse(jsonMatch[0]);
            } else {
                result = JSON.parse(jsonText);
            }
        } catch (parseError) {
            // Fallback: check if response contains keywords indicating harassment
            const lowerText = responseText.toLowerCase();
            const harassmentKeywords = ['true', 'harassment', 'inappropriate', 'violates', 'harmful', 'offensive'];
            const safeKeywords = ['false', 'safe', 'appropriate', 'acceptable', 'ok'];
            
            const hasHarassmentKeyword = harassmentKeywords.some(keyword => lowerText.includes(keyword));
            const hasSafeKeyword = safeKeywords.some(keyword => lowerText.includes(keyword));
            
            // If we find harassment keywords but no safe keywords, consider it harassment
            const isHarassment = hasHarassmentKeyword && !hasSafeKeyword;
            
            result = {
                isHarassment: isHarassment,
                reason: responseText.substring(0, 150) || 'Content moderation check'
            };
        }

        return {
            isHarassment: result.isHarassment === true || result.isHarassment === 'true',
            reason: result.reason || 'Content moderation check'
        };
    } catch (error) {
        console.error('Error in harassment detection:', error);
        // Fail-safe: if AI service fails, allow message but log it
        return {
            isHarassment: false,
            reason: 'Moderation service unavailable'
        };
    }
}

module.exports = { detectHarassment };

