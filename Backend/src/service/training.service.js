/** Examples with no room (AI-only / legacy). */
let globalTrainingData = [];
/** Match-scoped examples: discarded when either peer leaves (room ends). */
const sessionTrainingByRoomId = new Map();

function normalizeRoomId(roomId) {
    if (roomId == null) return null;
    const s = String(roomId).trim();
    return s ? s.slice(0, 120) : null;
}

/**
 * Add training data for harassment detection
 * @param {Object} data - Training data with examples and labels
 */
function addTrainingData(data) {
    const roomId = normalizeRoomId(data.roomId);
    const row = {
        message: data.message,
        isHarassment: Boolean(data.isHarassment),
        source: data.source || 'manual',
        sourceMessageId: data.sourceMessageId || null,
        partnerDisplayName: data.partnerDisplayName || null,
        roomId,
        timestamp: new Date(),
        id: Date.now()
    };
    if (roomId) {
        if (!sessionTrainingByRoomId.has(roomId)) sessionTrainingByRoomId.set(roomId, []);
        sessionTrainingByRoomId.get(roomId).push(row);
    } else {
        globalTrainingData.push(row);
    }
    console.log('Training data added:', row);
}

/**
 * Remove all training examples tied to a live chat room (both users disconnected).
 * @param {string} roomId
 */
function clearSessionTraining(roomId) {
    const k = normalizeRoomId(roomId);
    if (!k) return;
    sessionTrainingByRoomId.delete(k);
}

/**
 * Rows used for moderation (global + this match’s session examples).
 * @param {string | null | undefined} roomId
 * @returns {Array}
 */
function getTrainingDataForModeration(roomId) {
    const k = normalizeRoomId(roomId);
    const session = k ? (sessionTrainingByRoomId.get(k) || []) : [];
    return [...globalTrainingData, ...session];
}

/**
 * Get all training data (global + every active session bucket)
 * @returns {Array}
 */
function getTrainingData() {
    const sessionFlat = [...sessionTrainingByRoomId.values()].flat();
    return [...globalTrainingData, ...sessionFlat];
}

/**
 * Train the model with custom examples (for future use)
 * @param {Array} examples - Array of {message, isHarassment} examples
 */
async function trainModel(examples) {
    console.log('Training with examples:', examples.length);

    globalTrainingData.push(...examples.map(ex => ({
        message: ex.message,
        isHarassment: ex.isHarassment,
        source: 'batch',
        roomId: null,
        sourceMessageId: null,
        partnerDisplayName: null,
        timestamp: new Date(),
        id: Date.now()
    })));

    return {
        success: true,
        message: `Trained with ${examples.length} examples`,
        totalExamples: getTrainingData().length
    };
}

module.exports = {
    addTrainingData,
    getTrainingData,
    getTrainingDataForModeration,
    clearSessionTraining,
    trainModel
};

