require('dotenv').config()
const app = require('./src/app')
const { createServer } = require("http");
const { Server } = require("socket.io");
const generateResponse = require('./src/service/ai.service')
const { detectHarassment } = require('./src/service/moderation.service')
const { clearSessionTraining } = require('./src/service/training.service')
const { verifySocketToken } = require('./src/service/auth.service')

const httpServer = createServer(app);

// Store connected users and their pairs
const connectedUsers = new Map(); // socketId -> {userId, partnerId, roomId}
const waitingUsers = []; // { socketId, userId, displayName }
const pendingConsent = new Map(); // socketId -> shared pending object (both sockets)
const userProfiles = new Map(); // socketId -> { userId, displayName }
const messages = new Map(); // messageId -> {message, userId, partnerId, timestamp, isHarassment, edited, deleted}
const aiChatHistories = new Map(); // socketId -> ChatHistory array for AI conversations

// Room management
const rooms = new Map(); // roomId -> {user1, user2, messages}

const io = new Server(httpServer, {
  cors:{
    origin: ["http://localhost:5173", "http://localhost:5174"],
    methods: ["GET", "POST"],
    credentials: true
  },
  allowRequest: (req, callback) => {
    callback(null, true);
  }
});

/** Must match Frontend MODERATION_EDIT_WINDOW_MS — time to edit a flagged message before auto-delete. */
const MODERATION_EDIT_WINDOW_MS = 5000

function clearHarassmentDeleteTimer(message) {
  if (message?.pendingHarassmentTimeout != null) {
    clearTimeout(message.pendingHarassmentTimeout)
    message.pendingHarassmentTimeout = null
  }
}

function emitMessageDeletedForHarassment(msg) {
  const senderSocketId = Array.from(connectedUsers.entries())
    .find(([, info]) => info.userId === msg.userId)?.[0]
  if (senderSocketId) {
    io.to(senderSocketId).emit('message-deleted', { messageId: msg.messageId })
  }
  const partnerSocket = Array.from(connectedUsers.entries())
    .find(([, info]) => info.userId === msg.partnerId)?.[0]
  if (partnerSocket) {
    io.to(partnerSocket).emit('message-deleted', { messageId: msg.messageId })
  }
}

function finalizeHarassmentDeletion(messageId) {
  const checkMessage = messages.get(messageId)
  if (!checkMessage || checkMessage.edited || checkMessage.deleted) return
  checkMessage.deleted = true
  emitMessageDeletedForHarassment(checkMessage)
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const v = verifySocketToken(token);
  if (!v.ok) {
    return next(new Error(v.error || 'Unauthorized'));
  }
  socket.authUser = {
    email: v.email,
    displayName: v.displayName,
    tokenExpSec: v.exp
  };
  next();
});

// Helper function to generate unique user ID
function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Helper function to generate room ID
function generateRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function getDisplayName(socketId) {
  const name = userProfiles.get(socketId)?.displayName?.trim();
  return name || 'Someone';
}

function clearPendingConsent(pending) {
  pendingConsent.delete(pending.waitingSocketId);
  pendingConsent.delete(pending.incomingSocketId);
}

// Helper: queue user for match (pairing happens only after the waiting user accepts)
function findMatch(socketId, userId) {
  if (waitingUsers.length > 0) {
    const partner = waitingUsers.shift();
    const pending = {
      waitingSocketId: partner.socketId,
      incomingSocketId: socketId,
      waitingUserId: partner.userId,
      incomingUserId: userId,
      waitingName: partner.displayName || getDisplayName(partner.socketId),
      incomingName: getDisplayName(socketId)
    };
    pendingConsent.set(partner.socketId, pending);
    pendingConsent.set(socketId, pending);
    return { pendingConsent: true, pending };
  }
  const profile = userProfiles.get(socketId);
  waitingUsers.push({
    socketId,
    userId,
    displayName: profile?.displayName?.trim() || getDisplayName(socketId)
  });
  return { pendingConsent: false };
}

function finalizeMatch(pending) {
  clearPendingConsent(pending);
  const roomId = generateRoomId();
  rooms.set(roomId, {
    user1: pending.waitingUserId,
    user2: pending.incomingUserId,
    messages: []
  });
  connectedUsers.set(pending.waitingSocketId, {
    userId: pending.waitingUserId,
    partnerId: pending.incomingUserId,
    roomId
  });
  connectedUsers.set(pending.incomingSocketId, {
    userId: pending.incomingUserId,
    partnerId: pending.waitingUserId,
    roomId
  });
  io.sockets.sockets.get(pending.waitingSocketId)?.join(roomId);
  io.sockets.sockets.get(pending.incomingSocketId)?.join(roomId);
  io.to(pending.waitingSocketId).emit('matched', {
    partnerId: pending.incomingUserId,
    partnerName: pending.incomingName,
    roomId
  });
  io.to(pending.incomingSocketId).emit('matched', {
    partnerId: pending.waitingUserId,
    partnerName: pending.waitingName,
    roomId
  });
}

io.on("connection", (socket) => {
  console.log("a user connected:", socket.id)

  const { displayName: authDisplayName, email: authEmail, tokenExpSec } = socket.authUser;
  const userId = generateUserId();
  userProfiles.set(socket.id, {
    userId,
    displayName: authDisplayName,
    email: authEmail
  });
  socket.emit('user-id', userId);

  const msLeft = Math.max(0, tokenExpSec * 1000 - Date.now());
  const sessionTimer = setTimeout(() => {
    try {
      socket.emit('session-expired', { message: 'Your session time limit ended. Please sign in again.' });
    } catch (_) {}
    socket.disconnect(true);
  }, msLeft);
  socket.once('disconnect', () => clearTimeout(sessionTimer));

  socket.on("disconnect", () => {
    console.log("user disconnected:", socket.id)

    const pending = pendingConsent.get(socket.id);
    if (pending) {
      clearPendingConsent(pending);
      if (pending.waitingSocketId === socket.id) {
        io.to(pending.incomingSocketId).emit('match-cancelled');
      } else {
        waitingUsers.push({
          socketId: pending.waitingSocketId,
          userId: pending.waitingUserId,
          displayName: pending.waitingName
        });
        io.to(pending.waitingSocketId).emit('waiting-for-match');
      }
    }
    
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
        clearSessionTraining(userInfo.roomId)
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
    userProfiles.delete(socket.id);
  });

  // Find match / connect with another user
  socket.on("find-match", () => {
    const profile = userProfiles.get(socket.id);
    if (!profile?.displayName?.trim()) {
      socket.emit('error', { message: 'Please enter your name before finding a match.' });
      return;
    }
    // Remove self from queue if still there (e.g. Leave was clicked but cancel-search didn't reach server)
    const existingIdx = waitingUsers.findIndex(u => u.socketId === socket.id);
    if (existingIdx !== -1) waitingUsers.splice(existingIdx, 1);
    const matchResult = findMatch(socket.id, userId);
    
    if (matchResult.pendingConsent) {
      const p = matchResult.pending;
      io.to(p.waitingSocketId).emit('match-request', {
        partnerName: p.incomingName,
        partnerId: p.incomingUserId
      });
      io.to(p.incomingSocketId).emit('match-pending', {
        partnerName: p.waitingName,
        partnerId: p.waitingUserId
      });
    } else {
      socket.emit('waiting-for-match');
    }
  });

  socket.on('accept-match', () => {
    const pending = pendingConsent.get(socket.id);
    if (!pending || pending.waitingSocketId !== socket.id) {
      socket.emit('error', { message: 'No incoming chat request to accept.' });
      return;
    }
    finalizeMatch(pending);
  });

  socket.on('decline-match', () => {
    const pending = pendingConsent.get(socket.id);
    if (!pending || pending.waitingSocketId !== socket.id) {
      socket.emit('error', { message: 'No incoming chat request to decline.' });
      return;
    }
    clearPendingConsent(pending);
    waitingUsers.push({
      socketId: pending.waitingSocketId,
      userId: pending.waitingUserId,
      displayName: pending.waitingName
    });
    io.to(pending.incomingSocketId).emit('match-declined', { reason: 'peer-declined' });
    io.to(pending.waitingSocketId).emit('waiting-for-match');
  });

  // Cancel search / leave queue / withdraw consent request
  socket.on("cancel-search", () => {
    const pending = pendingConsent.get(socket.id);
    if (pending) {
      clearPendingConsent(pending);
      if (pending.incomingSocketId === socket.id) {
        waitingUsers.push({
          socketId: pending.waitingSocketId,
          userId: pending.waitingUserId,
          displayName: pending.waitingName
        });
        io.to(pending.waitingSocketId).emit('waiting-for-match');
        io.to(pending.incomingSocketId).emit('match-cancelled');
      } else {
        waitingUsers.push({
          socketId: pending.waitingSocketId,
          userId: pending.waitingUserId,
          displayName: pending.waitingName
        });
        io.to(pending.incomingSocketId).emit('match-declined', { reason: 'peer-declined' });
        io.to(pending.waitingSocketId).emit('waiting-for-match');
      }
      return;
    }
    const idx = waitingUsers.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) {
      waitingUsers.splice(idx, 1);
      socket.emit('search-cancelled');
    }
  });

  // Send message to partner
  socket.on("user-message", async (data) => {
    const userInfo = connectedUsers.get(socket.id);
    
    if (!userInfo || !userInfo.partnerId) {
      socket.emit('error', { message: 'You are not connected to anyone' });
      return;
    }
    
    const text = typeof data?.text === 'string' ? data.text : '';
    const messageId = data?.messageId;
    if (!text.trim()) {
      socket.emit('error', { message: 'Message cannot be empty' });
      return;
    }
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
    const modRoomId = userInfo.roomId ?? null
    detectHarassment(text, { roomId: modRoomId }).then(result => {
      const storedMessage = messages.get(messageData.messageId);
      
      if (storedMessage && !storedMessage.edited) {
        storedMessage.isHarassment = result.isHarassment;
        storedMessage.pendingModeration = false;
        
        if (result.isHarassment) {
          clearHarassmentDeleteTimer(storedMessage)
          storedMessage.harassmentDeleteAt = Date.now() + MODERATION_EDIT_WINDOW_MS
          storedMessage.pendingHarassmentTimeout = setTimeout(() => {
            finalizeHarassmentDeletion(messageData.messageId)
          }, MODERATION_EDIT_WINDOW_MS)
          
          // Warn the sender
          socket.emit('harassment-detected', {
            messageId: messageData.messageId,
            reason: result.reason,
            warning: 'Your message was flagged by our content policy. Please edit it within 5 seconds or it will be removed.'
          });
        } else {
          // Message is safe: tell sender so "Checking..." clears, then broadcast to partner
          socket.emit('message-approved', { messageId: messageData.messageId });
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
    }).catch((err) => {
      console.error('Moderation check failed:', err);
      const storedMessage = messages.get(messageData.messageId);
      if (!storedMessage || storedMessage.edited || storedMessage.deleted) return;
      storedMessage.pendingModeration = false;
      storedMessage.deleted = true;
      socket.emit('message-deleted', { messageId: messageData.messageId });
      socket.emit('error', {
        message: 'Could not verify your message. Please try again.'
      });
    });
    
    // Send message to sender immediately (pending moderation)
    socket.emit('user-message-sent', {
      messageId: messageData.messageId,
      text,
      timestamp,
      pendingModeration: true
    });
  });

  socket.on('moderation-edit-pause', (data) => {
    const messageId = typeof data?.messageId === 'string' ? data.messageId : null
    if (!messageId) return
    const message = messages.get(messageId)
    if (!message || message.userId !== userId) return
    if (!message.isHarassment || message.edited || message.deleted) return
    clearHarassmentDeleteTimer(message)
    const deadline = message.harassmentDeleteAt
    message.harassmentPausedRemainingMs = Math.max(
      0,
      deadline != null ? deadline - Date.now() : MODERATION_EDIT_WINDOW_MS
    )
  })

  socket.on('moderation-edit-resume', (data) => {
    const messageId = typeof data?.messageId === 'string' ? data.messageId : null
    if (!messageId) return
    const message = messages.get(messageId)
    if (!message || message.userId !== userId) return
    if (!message.isHarassment || message.edited || message.deleted) return
    clearHarassmentDeleteTimer(message)
    const remaining =
      message.harassmentPausedRemainingMs != null
        ? message.harassmentPausedRemainingMs
        : MODERATION_EDIT_WINDOW_MS
    delete message.harassmentPausedRemainingMs
    message.harassmentDeleteAt = Date.now() + remaining
    message.pendingHarassmentTimeout = setTimeout(() => {
      finalizeHarassmentDeletion(messageId)
    }, remaining)
  })

  // Edit message
  socket.on("edit-message", async (data) => {
    const { messageId, newText } = data;
    const message = messages.get(messageId);
    
    if (!message || message.userId !== userId) {
      socket.emit('error', { message: 'Message not found or unauthorized' });
      return;
    }

    clearHarassmentDeleteTimer(message)
    delete message.harassmentDeleteAt
    delete message.harassmentPausedRemainingMs
    
    message.text = newText;
    message.edited = true;
    message.timestamp = Date.now();
    
    // Re-check for harassment
    const userInfo = connectedUsers.get(socket.id);
    const modRoomId = userInfo?.roomId ?? null
    const result = await detectHarassment(newText, { roomId: modRoomId });
    message.isHarassment = result.isHarassment;
    message.pendingModeration = false;
    
    if (result.isHarassment) {
      // Still harassment, delete immediately
      message.deleted = true;
      socket.emit('message-deleted', { messageId });
      
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
        warning: 'Your edited message was also flagged and has been removed.'
      });
    } else {
      // Safe now, broadcast to partner
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
