require('dotenv').config()
const app = require('./src/app')
const { createServer } = require("http");
const { Server } = require("socket.io");
const generateResponse = require('./src/service/ai.service')
const { detectHarassment } = require('./src/service/moderation.service')

const httpServer = createServer(app);

// Store connected users and their pairs
const connectedUsers = new Map(); // socketId -> {userId, partnerId, roomId}
const waitingUsers = []; // Users waiting for a match
const messages = new Map(); // messageId -> {message, userId, partnerId, timestamp, isHarassment, edited, deleted}
const aiChatHistories = new Map(); // socketId -> ChatHistory array for AI conversations

// Room management
const rooms = new Map(); // roomId -> {user1, user2, messages}

const io = new Server(httpServer, {
  cors:{
    origin: ["http://localhost:5173", "http://localhost:5174"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Helper function to generate unique user ID
function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Helper function to generate room ID
function generateRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Helper function to find or create a match
function findMatch(socketId, userId) {
  if (waitingUsers.length > 0) {
    // Match with waiting user
    const partner = waitingUsers.shift();
    const roomId = generateRoomId();
    
    // Create room
    rooms.set(roomId, {
      user1: partner.userId,
      user2: userId,
      messages: []
    });
    
    // Update both users
    connectedUsers.set(partner.socketId, {
      userId: partner.userId,
      partnerId: userId,
      roomId: roomId
    });
    
    connectedUsers.set(socketId, {
      userId: userId,
      partnerId: partner.userId,
      roomId: roomId
    });
    
    // Join both users to the room
    io.sockets.sockets.get(partner.socketId)?.join(roomId);
    io.sockets.sockets.get(socketId)?.join(roomId);
    
    return { matched: true, partnerId: partner.userId, roomId };
  } else {
    // Add to waiting list
    waitingUsers.push({ socketId, userId });
    return { matched: false };
  }
}

io.on("connection", (socket) => {
  console.log("a user connected:", socket.id)
  
  const userId = generateUserId();
  socket.emit('user-id', userId);

  socket.on("disconnect", () => {
    console.log("user disconnected:", socket.id)
    
    const userInfo = connectedUsers.get(socket.id);
    if (userInfo) {
      // Notify partner
      const partnerSocket = Array.from(connectedUsers.entries())
        .find(([_, info]) => info.userId === userInfo.partnerId)?.[0];
      
      if (partnerSocket) {
        io.to(partnerSocket).emit('partner-disconnected');
        connectedUsers.delete(partnerSocket);
      }
      
      // Remove from room
      if (userInfo.roomId) {
        rooms.delete(userInfo.roomId);
      }
      
      connectedUsers.delete(socket.id);
    }
    
    // Remove from waiting list
    const waitingIndex = waitingUsers.findIndex(u => u.socketId === socket.id);
    if (waitingIndex !== -1) {
      waitingUsers.splice(waitingIndex, 1);
    }
    
    // Clean up AI chat history
    aiChatHistories.delete(socket.id);
  });

  // Find match / connect with another user
  socket.on("find-match", () => {
    const matchResult = findMatch(socket.id, userId);
    
    if (matchResult.matched) {
      socket.emit('matched', {
        partnerId: matchResult.partnerId,
        roomId: matchResult.roomId
      });
      
      // Notify partner
      const partnerSocket = Array.from(connectedUsers.entries())
        .find(([_, info]) => info.userId === matchResult.partnerId)?.[0];
      
      if (partnerSocket) {
        io.to(partnerSocket).emit('matched', {
          partnerId: userId,
          roomId: matchResult.roomId
        });
      }
    } else {
      socket.emit('waiting-for-match');
    }
  });

  // Send message to partner
  socket.on("user-message", async (data) => {
    const userInfo = connectedUsers.get(socket.id);
    
    if (!userInfo || !userInfo.partnerId) {
      socket.emit('error', { message: 'You are not connected to anyone' });
      return;
    }
    
    const { text, messageId } = data;
    const timestamp = Date.now();
    
    // Store message
    const messageData = {
      messageId: messageId || `msg_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
      text,
      userId,
      partnerId: userInfo.partnerId,
      timestamp,
      isHarassment: false,
      edited: false,
      deleted: false,
      pendingModeration: true
    };
    
    messages.set(messageData.messageId, messageData);
    
    // Check for harassment asynchronously
    detectHarassment(text).then(result => {
      const storedMessage = messages.get(messageData.messageId);
      
      if (storedMessage && !storedMessage.edited) {
        storedMessage.isHarassment = result.isHarassment;
        storedMessage.pendingModeration = false;
        
        if (result.isHarassment) {
          // Set timer to delete after 5 seconds if not edited
          setTimeout(() => {
            const checkMessage = messages.get(messageData.messageId);
            if (checkMessage && !checkMessage.edited && !checkMessage.deleted) {
              checkMessage.deleted = true;
              
              // Notify both users to remove the message
              socket.emit('message-deleted', { messageId: messageData.messageId });
              
              const partnerSocket = Array.from(connectedUsers.entries())
                .find(([_, info]) => info.userId === userInfo.partnerId)?.[0];
              
              if (partnerSocket) {
                io.to(partnerSocket).emit('message-deleted', { messageId: messageData.messageId });
              }
            }
          }, 5000);
          
          // Warn the sender
          socket.emit('harassment-detected', {
            messageId: messageData.messageId,
            reason: result.reason,
            warning: 'Your message contains inappropriate content. Please edit it within 5 seconds or it will be deleted.'
          });
        } else {
          // Message is safe, broadcast to partner
          const partnerSocket = Array.from(connectedUsers.entries())
            .find(([_, info]) => info.userId === userInfo.partnerId)?.[0];
          
          if (partnerSocket) {
            io.to(partnerSocket).emit('user-message-received', {
              messageId: messageData.messageId,
              text,
              senderId: userId,
              timestamp
            });
          }
        }
      }
    });
    
    // Send message to sender immediately (pending moderation)
    socket.emit('user-message-sent', {
      messageId: messageData.messageId,
      text,
      timestamp,
      pendingModeration: true
    });
  });

  // Edit message
  socket.on("edit-message", async (data) => {
    const { messageId, newText } = data;
    const message = messages.get(messageId);
    
    if (!message || message.userId !== userId) {
      socket.emit('error', { message: 'Message not found or unauthorized' });
      return;
    }
    
    message.text = newText;
    message.edited = true;
    message.timestamp = Date.now();
    
    // Re-check for harassment
    const result = await detectHarassment(newText);
    message.isHarassment = result.isHarassment;
    message.pendingModeration = false;
    
    if (result.isHarassment) {
      // Still harassment, delete immediately
      message.deleted = true;
      socket.emit('message-deleted', { messageId });
      
      const userInfo = connectedUsers.get(socket.id);
      if (userInfo && userInfo.partnerId) {
        const partnerSocket = Array.from(connectedUsers.entries())
          .find(([_, info]) => info.userId === userInfo.partnerId)?.[0];
        
        if (partnerSocket) {
          io.to(partnerSocket).emit('message-deleted', { messageId });
        }
      }
      
      socket.emit('harassment-detected', {
        messageId,
        reason: result.reason,
        warning: 'Your edited message still contains inappropriate content and has been deleted.'
      });
    } else {
      // Safe now, broadcast to partner
      const userInfo = connectedUsers.get(socket.id);
      if (userInfo && userInfo.partnerId) {
        const partnerSocket = Array.from(connectedUsers.entries())
          .find(([_, info]) => info.userId === userInfo.partnerId)?.[0];
        
        if (partnerSocket) {
          io.to(partnerSocket).emit('user-message-received', {
            messageId,
            text: newText,
            senderId: userId,
            timestamp: message.timestamp
          });
        }
      }
      
      socket.emit('message-edited', {
        messageId,
        text: newText,
        timestamp: message.timestamp
      });
    }
  });

  // Legacy AI chat (for backward compatibility)
  socket.on("ai-message", async (data) => {
    console.log("AI message received from socket:", socket.id, "Data:", data);
    
    // Get or create chat history for this user
    if (!aiChatHistories.has(socket.id)) {
      aiChatHistories.set(socket.id, []);
    }
    
    const chatHistory = aiChatHistories.get(socket.id);
    
    // Add user message to history
    chatHistory.push({
      role: "user",
      parts: [{ text: data }]
    });
    
    try {
      const response = await generateResponse(chatHistory);
      console.log("AI Response for socket", socket.id, ":", response);
      
      // Add AI response to history
      chatHistory.push({
        role: "model",
        parts: [{ text: response }]
      });
      
      // Emit response only to the sender
      socket.emit("ai-response", response);
    } catch (error) {
      console.error("Error generating AI response:", error);
      socket.emit("ai-response", "Sorry, I encountered an error. Please try again.");
    }
  });
});

httpServer.listen(3000, () => {
    console.log('Server is running on port 3000');
});
