const express = require('express');
const { isAllowedOrigin } = require('./config/allowedOrigins');
const { addTrainingData, getTrainingData, trainModel } = require('./service/training.service');
const generateResponse = require('./service/ai.service');
const { requestOtp, verifyOtpAndIssueToken, SESSION_TTL_SECONDS } = require('./service/auth.service');

const app = express();

// CORS — production origins via ALLOWED_ORIGINS or FRONTEND_URL (see allowedOrigins.js)
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

app.get('/',(req,res) => {
    res.send("Working.")
})

app.get('/api/auth/session-ttl', (req, res) => {
  res.json({ sessionTtlSeconds: SESSION_TTL_SECONDS });
});

app.post('/api/auth/request-otp', async (req, res) => {
  try {
    const { email, displayName } = req.body || {};
    const result = await requestOtp(email, displayName);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({
      success: true,
      message: result.message,
      emailHint: result.emailHint
    });
  } catch (e) {
    console.error('request-otp', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body || {};
    const result = verifyOtpAndIssueToken(email, otp);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({
      success: true,
      token: result.token,
      displayName: result.displayName,
      email: result.email,
      expiresInSeconds: result.expiresInSeconds
    });
  } catch (e) {
    console.error('verify-otp', e);
    res.status(500).json({ error: e.message });
  }
});

// Test AI model endpoint (for health check / testing)
app.post('/api/test-ai', async (req, res) => {
    try {
        const message = req.body?.message ?? 'Say "Hello, the AI is working!" in one short sentence.';
        const chatHistory = [{ role: 'user', parts: [{ text: message }] }];
        const response = await generateResponse(chatHistory);
        res.json({ success: true, message: message, response });
    } catch (error) {
        console.error('Test AI error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            hint: process.env.GEMINI_API_KEY ? 'AI service error' : 'GEMINI_API_KEY is not set in .env'
        });
    }
});

// Training endpoints
app.post('/api/training', async (req, res) => {
    try {
        const { message, isHarassment, source, sourceMessageId, partnerDisplayName, roomId } = req.body || {};
        
        if (!message || typeof isHarassment !== 'boolean') {
            return res.status(400).json({ error: 'Message and isHarassment (boolean) are required' });
        }

        const allowedSources = new Set(['manual', 'partner_message', 'flagged_own']);
        const src = allowedSources.has(source) ? source : 'manual';
        const sessionRoom =
            roomId != null && String(roomId).trim()
                ? String(roomId).trim().slice(0, 120)
                : null;

        addTrainingData({
            message: String(message).slice(0, 4000),
            isHarassment,
            source: src,
            sourceMessageId: sourceMessageId != null ? String(sourceMessageId).slice(0, 200) : null,
            partnerDisplayName: partnerDisplayName != null ? String(partnerDisplayName).slice(0, 80) : null,
            roomId: sessionRoom
        });
        res.json({ success: true, message: 'Training data added successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/training/batch', async (req, res) => {
    try {
        const { examples } = req.body;
        
        if (!Array.isArray(examples)) {
            return res.status(400).json({ error: 'Examples array is required' });
        }
        
        const result = await trainModel(examples);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/training', (req, res) => {
    const trainingData = getTrainingData();
    res.json({ trainingData, count: trainingData.length });
});

module.exports = app;