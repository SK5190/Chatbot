const express = require('express');
const { addTrainingData, getTrainingData, trainModel } = require('./service/training.service');

const app = express();

// CORS middleware
app.use((req, res, next) => {
  const allowedOrigins = ['http://localhost:5173', 'http://localhost:5174'];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
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

// Training endpoints
app.post('/api/training', async (req, res) => {
    try {
        const { message, isHarassment } = req.body;
        
        if (!message || typeof isHarassment !== 'boolean') {
            return res.status(400).json({ error: 'Message and isHarassment (boolean) are required' });
        }
        
        addTrainingData({ message, isHarassment });
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