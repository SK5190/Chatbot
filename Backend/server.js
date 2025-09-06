require('dotenv').config()
const app = require('./src/app')
const { createServer } = require("http");
const { Server } = require("socket.io");
const generateResponse = require('./src/service/ai.service')

const httpServer = createServer(app);
const ChatHistory = [];

const io = new Server(httpServer, {
  cors:{
    origin: "http://localhost:5173"
  }
});

io.on("connection", (socket) => {
  console.log("a user connected")

  socket.on("disconnect", () =>{
    console.log("user disconnected")
  });

  socket.on("ai-message", async (data) => {
    console.log("Data received:",data);
      ChatHistory.push({
      role : "user",
      parts: [{ text: data}]
    })
    
    const response = await generateResponse(ChatHistory);
    console.log("AI Response:", response);
    ChatHistory.push({
      role : "model",
      parts: [{ text: response}]
    }
    )
    socket.emit("ai-response", response);

  
  })
});

httpServer.listen(3000, () => {
    console.log('Server is running on port 3000');
})