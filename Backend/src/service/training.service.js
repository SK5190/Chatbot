const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// Store training data (in production, use a database)
let trainingData = [];

/**
 * Add training data for harassment detection
 * @param {Object} data - Training data with examples and labels
 */
function addTrainingData(data) {
    trainingData.push({
        ...data,
        timestamp: new Date(),
        id: Date.now()
    });
    console.log('Training data added:', data);
}

/**
 * Get all training data
 * @returns {Array} Training data array
 */
function getTrainingData() {
    return trainingData;
}

/**
 * Train the model with custom examples (for future use)
 * @param {Array} examples - Array of {message, isHarassment} examples
 */
async function trainModel(examples) {
    // This is a placeholder for future model fine-tuning
    // Currently, we use prompt engineering with examples
    console.log('Training with examples:', examples.length);
    
    // Store examples for use in moderation prompts
    trainingData.push(...examples.map(ex => ({
        message: ex.message,
        isHarassment: ex.isHarassment,
        timestamp: new Date(),
        id: Date.now()
    })));
    
    return {
        success: true,
        message: `Trained with ${examples.length} examples`,
        totalExamples: trainingData.length
    };
}

module.exports = {
    addTrainingData,
    getTrainingData,
    trainModel
};




