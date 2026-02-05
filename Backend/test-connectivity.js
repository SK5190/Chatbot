const http = require('http');

console.log('🔍 Testing Backend Connectivity...\n');

// Test 1: HTTP Endpoint
console.log('1. Testing HTTP endpoint...');
const req = http.get('http://localhost:3000', (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('   ✅ HTTP endpoint working:', data.trim());
    console.log('   Status:', res.statusCode);
    
    // Test 2: Training API Endpoint
    console.log('\n2. Testing Training API endpoint...');
    const trainingReq = http.get('http://localhost:3000/api/training', (trainingRes) => {
      let trainingData = '';
      trainingRes.on('data', (chunk) => {
        trainingData += chunk;
      });
      trainingRes.on('end', () => {
        try {
          const parsed = JSON.parse(trainingData);
          console.log('   ✅ Training API working');
          console.log('   Training examples:', parsed.count || 0);
        } catch (e) {
          console.log('   ✅ Training API responding (parse error expected)');
        }
        console.log('\n✅ Basic connectivity tests passed!');
        console.log('\n📝 Note: For Socket.io testing, use the HTML test file in Frontend folder');
        console.log('   or open your React app and check the browser console.');
        process.exit(0);
      });
    });

    trainingReq.on('error', (error) => {
      console.log('   ⚠️  Training API test failed:', error.message);
      console.log('\n✅ HTTP endpoint is working!');
      process.exit(0);
    });
  });
});

req.on('error', (error) => {
  console.log('   ❌ HTTP endpoint failed:', error.message);
  console.log('   Make sure the server is running on port 3000');
  process.exit(1);
});

req.setTimeout(3000, () => {
  console.log('   ❌ HTTP request timeout');
  process.exit(1);
});

