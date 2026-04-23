const { GoogleGenAI } = require("@google/genai");
const { getTrainingDataForModeration } = require("./training.service");

const MAX_TRAINING_EXAMPLES_IN_PROMPT = 14;

/** When true, if the Gemini call fails after local checks pass, the message is still blocked (safest for high-risk deployments). */
const STRICT_WHEN_AI_FAILS =
    String(process.env.MODERATION_STRICT_WHEN_AI_FAILS || "")
        .toLowerCase() === "true" ||
    String(process.env.MODERATION_STRICT_WHEN_AI_FAILS || "") === "1";

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

function hasGeminiKey() {
    return Boolean(process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim());
}

/** Gemini is skipped when the key is missing or MODERATION_DISABLE_AI is set — npm `bad-words` + local rules still run. */
function shouldUseGemini() {
    if (!hasGeminiKey()) return false;
    const d = String(process.env.MODERATION_DISABLE_AI || "").toLowerCase();
    return d !== "true" && d !== "1";
}

function trainingExamplesBlock(roomId) {
    const rows = getTrainingDataForModeration(roomId)
        .slice(-MAX_TRAINING_EXAMPLES_IN_PROMPT)
        .filter((ex) => ex && typeof ex.message === "string" && ex.message.trim());
    if (!rows.length) return "";
    const lines = rows.map((ex) => {
        const tag = ex.isHarassment ? "HARASSMENT" : "OK";
        const ctx =
            ex.source === "partner_message"
                ? " [labeled from live chat]"
                : ex.source === "flagged_own"
                    ? " [labeled from flagged message]"
                    : "";
        const text = ex.message.trim().replace(/\s+/g, " ").slice(0, 320);
        return `- "${text}" → ${tag}${ctx}`;
    });
    return `

The following are real examples labeled by users for this deployment. Treat similar phrasing consistently with these labels:
${lines.join("\n")}
`;
}

// Lazy-loaded ESM bad-words filter (package is ESM, we are CJS)
let badWordsFilter = null;
/** @returns {string[]} */
function parseModerationEnvList(envVar) {
    const raw = process.env[envVar] || "";
    return raw
        .split(/[,|]/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

async function getBadWordsFilter() {
    if (!badWordsFilter) {
        const { Filter } = await import("bad-words");
        badWordsFilter = new Filter();
        const extraTokens = parseModerationEnvList("MODERATION_EXTRA_WORDS").filter(
            (w) => !/\s/.test(w)
        );
        if (extraTokens.length) {
            badWordsFilter.addWords(...extraTokens.map((w) => w.toLowerCase()));
        }
    }
    return badWordsFilter;
}

/**
 * Variants to run through npm `bad-words` so simple leet/spacing bypasses still match.
 */
function profanityCheckVariants(message) {
    const raw = String(message || "");
    const lower = raw.toLowerCase();
    const leetStripped = lower
        .replace(/0/g, "o")
        .replace(/1/g, "i")
        .replace(/3/g, "e")
        .replace(/4/g, "a")
        .replace(/5/g, "s")
        .replace(/7/g, "t")
        .replace(/@/g, "a")
        .replace(/\$/g, "s")
        .replace(/\*/g, "")
        .replace(/[._\-]+/g, "");
    const collapsed = lower.replace(/\s+/g, "");
    return [...new Set([raw, lower, leetStripped, collapsed].filter((s) => s && s.trim().length))];
}

/**
 * npm `bad-words` profanity filter — always runs first; works even when Gemini is down or disabled.
 * @param {string} message - The message to check
 * @returns {Promise<{ isHarassment: boolean, reason: string } | null>}
 */
async function checkBadWords(message) {
    if (!message || typeof message !== "string") return null;
    try {
        const filter = await getBadWordsFilter();
        for (const chunk of profanityCheckVariants(message)) {
            if (filter.isProfane(chunk)) {
                return {
                    isHarassment: true,
                    reason: "Inappropriate language detected (profanity filter)",
                };
            }
        }
    } catch (err) {
        console.error("Bad-words check error:", err);
    }
    return null;
}

/**
 * Comma-separated phrases or words in MODERATION_BLOCKED_PHRASES (case-insensitive substring).
 */
function checkBlockedPhrases(message) {
    const text = String(message || "");
    const lower = text.toLowerCase();
    const phrases = parseModerationEnvList("MODERATION_BLOCKED_PHRASES");
    for (const p of phrases) {
        const needle = p.toLowerCase();
        if (needle.length >= 2 && lower.includes(needle)) {
            return {
                isHarassment: true,
                reason: "Matched a blocked phrase configured for this server",
            };
        }
    }
    return null;
}

/** Spam / aggression heuristics that do not need a model. */
function checkLocalHeuristics(message) {
    const text = String(message || "");
    if (!text.trim()) return null;

    if (/(.)\1{30,}/.test(text)) {
        return {
            isHarassment: true,
            reason: "Disruptive repetition (spam-like)",
        };
    }

    const letters = text.replace(/[^a-zA-Z]/g, "");
    if (letters.length >= 28) {
        const upper = (text.match(/[A-Z]/g) || []).length;
        if (upper / letters.length > 0.9) {
            return {
                isHarassment: true,
                reason: "Aggressive formatting (almost all capitals)",
            };
        }
    }

    const threatRes = [
        /\bkill\s+your\s?self\b/i,
        /\bkys\b/i,
        /\bunalive\b/i,
        /\b(i'?ll|i\s+will)\s+(kill|hurt|beat|murder)\s+(you|u)\b/i,
    ];
    for (const re of threatRes) {
        if (re.test(text)) {
            return {
                isHarassment: true,
                reason: "Potentially threatening or self-harm-related language",
            };
        }
    }

    return null;
}

/**
 * If user-labeled harassment examples substantially overlap this message, flag (used when Gemini is off, or after a non-strict AI error).
 * Same server handler runs for every peer message — rules are never per-user.
 */
function normalizeForTrainingMatch(message) {
    return String(message || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a saved harassment phrase to the message. Long examples (10+ chars) may use substring rules;
 * short examples use whole-word / token boundaries so "rand" does not match inside "random".
 */
function harassmentExampleMatchesMessage(norm, ex) {
    if (ex.length < 2) return false;
    if (norm === ex) return true;

    if (ex.length >= 10) {
        if (norm.includes(ex)) return true;
        if (norm.length >= 12 && ex.includes(norm)) return true;
        return false;
    }

    if (!/\s/.test(ex)) {
        try {
            const re = new RegExp(`\\b${escapeRegex(ex)}\\b`, "i");
            if (re.test(norm)) return true;
        } catch (_) {
            /* ignore */
        }
        return false;
    }

    const padded = ` ${norm} `;
    return padded.includes(` ${ex} `);
}

function checkTrainingHarassmentOverlap(message, roomId) {
    const norm = normalizeForTrainingMatch(message);
    if (norm.length < 2) return null;

    const rows = getTrainingDataForModeration(roomId).filter((t) => t && t.isHarassment === true);
    for (const t of rows.slice(-40)) {
        const ex = normalizeForTrainingMatch(t.message);
        if (harassmentExampleMatchesMessage(norm, ex)) {
            return {
                isHarassment: true,
                reason: "Very similar to a saved harassment example from training",
            };
        }
    }
    return null;
}

/**
 * User-labeled OK examples: treat similar phrasing as acceptable for this session.
 * Runs only after profanity + local safety rules pass (does not bypass threats / blocked phrases).
 */
/** Exact normalized match only — allows user to override profanity false positives for fixed wording. */
function checkTrainingExactOkMatch(message, roomId) {
    const norm = normalizeForTrainingMatch(message);
    if (norm.length < 2) return null;
    const rows = getTrainingDataForModeration(roomId).filter(
        (t) => t && t.isHarassment === false && typeof t.message === "string"
    );
    for (const t of rows.slice(-40)) {
        const ex = normalizeForTrainingMatch(t.message);
        if (norm === ex && ex.length >= 2) {
            return {
                isHarassment: false,
                reason: "Same wording you labeled as acceptable for this chat",
            };
        }
    }
    return null;
}

function checkTrainingOkOverlap(message, roomId) {
    const norm = normalizeForTrainingMatch(message);
    if (norm.length < 2) return null;

    const rows = getTrainingDataForModeration(roomId).filter(
        (t) => t && t.isHarassment === false && typeof t.message === "string"
    );
    for (const t of rows.slice(-40)) {
        const ex = normalizeForTrainingMatch(t.message);
        if (ex.length < 2) continue;
        if (norm === ex) {
            return {
                isHarassment: false,
                reason: "Matches a message you labeled as acceptable for this chat",
            };
        }
        if (ex.length >= 6 && norm.includes(ex)) {
            return {
                isHarassment: false,
                reason: "Matches a message you labeled as acceptable for this chat",
            };
        }
        if (norm.length >= 6 && ex.includes(norm)) {
            return {
                isHarassment: false,
                reason: "Matches a message you labeled as acceptable for this chat",
            };
        }
    }
    return null;
}

function runAllLocalSync(message) {
    return checkBlockedPhrases(message) || checkLocalHeuristics(message);
}

/**
 * Detects if a message contains harassment or inappropriate content.
 * Order: npm bad-words → blocked phrases / heuristics → Gemini when configured (training examples are in the prompt only) → training overlap only when AI is off or after a non-strict AI failure.
 * Profanity always uses `bad-words` whether or not AI is available.
 */
async function detectHarassment(message, options = {}) {
    const roomId = options.roomId != null ? options.roomId : null;
    const badWordsResult = await checkBadWords(message);
    if (badWordsResult) {
        const exactOk = checkTrainingExactOkMatch(message, roomId);
        if (exactOk) return exactOk;
        return badWordsResult;
    }

    const localSync = runAllLocalSync(message);
    if (localSync) return localSync;

    const harassmentTrainingHit = checkTrainingHarassmentOverlap(message, roomId);
    if (harassmentTrainingHit) return harassmentTrainingHit;

    const okTrainingHit = checkTrainingOkOverlap(message, roomId);
    if (okTrainingHit) return okTrainingHit;

    if (!shouldUseGemini()) {
        const why = !hasGeminiKey()
            ? "Gemini not configured"
            : "AI moderation disabled (MODERATION_DISABLE_AI)";
        return {
            isHarassment: false,
            reason: `Passed npm bad-words + local rules (${why})`,
        };
    }

    try {
        const prompt = `Analyze the following message for harassment, hate speech, bullying, threats, or inappropriate content.

Message: "${message}"
${trainingExamplesBlock(roomId)}
Respond ONLY with a JSON object in this exact format:
{
    "isHarassment": true/false,
    "reason": "brief explanation"
}

Be strict but fair. Consider context. When a user-labeled example marks very similar text as OK (not harassment), you MUST respond with isHarassment false for that phrasing. When similar text is labeled HARASSMENT, flag consistently. Common harassment includes: threats, hate speech, sexual harassment, bullying, discrimination, or encouraging harm.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-lite",
            contents: [{
                role: "user",
                parts: [{ text: prompt }]
            }],
        });

        const responseText = response.text.trim();

        let result;
        try {
            let jsonText = responseText;
            jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                result = JSON.parse(jsonMatch[0]);
            } else {
                result = JSON.parse(jsonText);
            }
        } catch (parseError) {
            const lowerText = responseText.toLowerCase();
            const harassmentKeywords = ['true', 'harassment', 'inappropriate', 'violates', 'harmful', 'offensive'];
            const safeKeywords = ['false', 'safe', 'appropriate', 'acceptable', 'ok'];
            const hasHarassmentKeyword = harassmentKeywords.some(keyword => lowerText.includes(keyword));
            const hasSafeKeyword = safeKeywords.some(keyword => lowerText.includes(keyword));
            const isHarassment = hasHarassmentKeyword && !hasSafeKeyword;
            result = {
                isHarassment,
                reason: responseText.substring(0, 150) || 'Content moderation check'
            };
        }

        let isHarassment = result.isHarassment === true || result.isHarassment === 'true';

        if (isHarassment) {
            const okOverride = checkTrainingOkOverlap(message, roomId);
            if (okOverride) return okOverride;
        }

        return {
            isHarassment,
            reason: result.reason || 'Content moderation check'
        };
    } catch (error) {
        console.error('Error in AI harassment detection:', error);
        if (STRICT_WHEN_AI_FAILS) {
            return {
                isHarassment: true,
                reason: 'AI moderation unavailable; message held under strict fallback policy',
            };
        }
        const trainingAfterAiFail = checkTrainingHarassmentOverlap(message, roomId);
        if (trainingAfterAiFail) return trainingAfterAiFail;
        const okAfterAiFail = checkTrainingOkOverlap(message, roomId);
        if (okAfterAiFail) return okAfterAiFail;
        return {
            isHarassment: false,
            reason: 'AI unavailable; npm bad-words + local rules already passed at start of check',
        };
    }
}

module.exports = { detectHarassment, checkBadWords };
