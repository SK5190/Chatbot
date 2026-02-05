import { useState, useRef, useEffect } from 'react'
import './App.css'
import { io } from "socket.io-client";


function App() {
  const [message, setMessage] = useState('')
  const [socket, setSocket] = useState(null)
  const [chatHistory, setChatHistory] = useState([])
  const [userId, setUserId] = useState(null)
  const [partnerId, setPartnerId] = useState(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isWaiting, setIsWaiting] = useState(false)
  const [showTrainingModal, setShowTrainingModal] = useState(false)
  const [trainingMessage, setTrainingMessage] = useState('')
  const [trainingIsHarassment, setTrainingIsHarassment] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState(null)
  const [editText, setEditText] = useState('')
  const [harassmentWarnings, setHarassmentWarnings] = useState(new Map())
  const [notification, setNotification] = useState(null)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  const showNotification = (message, type = 'info') => {
    setNotification({ message, type })
    setTimeout(() => setNotification(null), 4000)
  }

  useEffect(() => {
    scrollToBottom()
  }, [chatHistory])

  useEffect(() => {
    let socketInstance = io("http://localhost:3000");
    setSocket(socketInstance)

    socketInstance.on('user-id', (id) => {
      setUserId(id)
    })

    socketInstance.on('matched', (data) => {
      setPartnerId(data.partnerId)
      setIsConnected(true)
      setIsWaiting(false)
      showNotification('Successfully matched with a partner!', 'success')
    })

    socketInstance.on('waiting-for-match', () => {
      setIsWaiting(true)
      setIsConnected(false)
      showNotification('Searching for a match...', 'info')
    })

    socketInstance.on('partner-disconnected', () => {
      setIsConnected(false)
      setPartnerId(null)
      setChatHistory([])
      showNotification('Your partner has disconnected', 'warning')
    })

    socketInstance.on('user-message-sent', (data) => {
      const messageObj = {
        id: data.messageId,
        text: data.text,
        sender: 'user',
        timestamp: new Date(data.timestamp),
        pendingModeration: data.pendingModeration
      }
      setChatHistory(prev => [...prev, messageObj])
    })

    socketInstance.on('user-message-received', (data) => {
      const messageObj = {
        id: data.messageId,
        text: data.text,
        sender: 'partner',
        timestamp: new Date(data.timestamp),
        senderId: data.senderId
      }
      setChatHistory(prev => [...prev, messageObj])
    })

    socketInstance.on('harassment-detected', (data) => {
      setHarassmentWarnings(prev => {
        const newMap = new Map(prev)
        newMap.set(data.messageId, {
          reason: data.reason,
          warning: data.warning
        })
        return newMap
      })

      showNotification('Inappropriate content detected. Please edit your message.', 'error')

      // Remove warning after 5 seconds
      setTimeout(() => {
        setHarassmentWarnings(prev => {
          const newMap = new Map(prev)
          newMap.delete(data.messageId)
          return newMap
        })
      }, 5000)
    })

    socketInstance.on('message-deleted', (data) => {
      setChatHistory(prev => prev.filter(msg => msg.id !== data.messageId))
      setHarassmentWarnings(prev => {
        const newMap = new Map(prev)
        newMap.delete(data.messageId)
        return newMap
      })
      showNotification('Message deleted due to inappropriate content', 'error')
    })

    socketInstance.on('message-edited', (data) => {
      setChatHistory(prev => prev.map(msg => 
        msg.id === data.messageId 
          ? { ...msg, text: data.text, timestamp: new Date(data.timestamp), pendingModeration: false }
          : msg
      ))
      setEditingMessageId(null)
      setEditText('')
      showNotification('Message updated successfully', 'success')
    })

    socketInstance.on('error', (data) => {
      showNotification(data.message, 'error')
    })

    // Legacy AI chat handler
    socketInstance.on('ai-response', (response) => {
      const receivedMessage = { 
        id: Date.now() + 1,
        text: response, 
        sender: 'bot', 
        timestamp: new Date() 
      }
      setChatHistory(prev => [...prev, receivedMessage])
    })

    return () => {
      socketInstance.disconnect()
    }
  }, [])

  const handleFindMatch = () => {
    if (socket) {
      socket.emit('find-match')
    }
  }

  const handleDisconnect = () => {
    if (socket && isConnected) {
      socket.disconnect()
      setIsConnected(false)
      setPartnerId(null)
      setChatHistory([])
      setIsWaiting(false)
      showNotification('Disconnected from partner', 'info')
      
      // Reconnect socket with all listeners
      setTimeout(() => {
        const socketInstance = io("http://localhost:3000");
        
        socketInstance.on('user-id', (id) => {
          setUserId(id)
        })

        socketInstance.on('matched', (data) => {
          setPartnerId(data.partnerId)
          setIsConnected(true)
          setIsWaiting(false)
          showNotification('Successfully matched with a partner!', 'success')
        })

        socketInstance.on('waiting-for-match', () => {
          setIsWaiting(true)
          setIsConnected(false)
          showNotification('Searching for a match...', 'info')
        })

        socketInstance.on('partner-disconnected', () => {
          setIsConnected(false)
          setPartnerId(null)
          setChatHistory([])
          showNotification('Your partner has disconnected', 'warning')
        })

        socketInstance.on('user-message-sent', (data) => {
          const messageObj = {
            id: data.messageId,
            text: data.text,
            sender: 'user',
            timestamp: new Date(data.timestamp),
            pendingModeration: data.pendingModeration
          }
          setChatHistory(prev => [...prev, messageObj])
        })

        socketInstance.on('user-message-received', (data) => {
          const messageObj = {
            id: data.messageId,
            text: data.text,
            sender: 'partner',
            timestamp: new Date(data.timestamp),
            senderId: data.senderId
          }
          setChatHistory(prev => [...prev, messageObj])
        })

        socketInstance.on('harassment-detected', (data) => {
          setHarassmentWarnings(prev => {
            const newMap = new Map(prev)
            newMap.set(data.messageId, {
              reason: data.reason,
              warning: data.warning
            })
            return newMap
          })
          showNotification('Inappropriate content detected. Please edit your message.', 'error')
          setTimeout(() => {
            setHarassmentWarnings(prev => {
              const newMap = new Map(prev)
              newMap.delete(data.messageId)
              return newMap
            })
          }, 5000)
        })

        socketInstance.on('message-deleted', (data) => {
          setChatHistory(prev => prev.filter(msg => msg.id !== data.messageId))
          setHarassmentWarnings(prev => {
            const newMap = new Map(prev)
            newMap.delete(data.messageId)
            return newMap
          })
          showNotification('Message deleted due to inappropriate content', 'error')
        })

        socketInstance.on('message-edited', (data) => {
          setChatHistory(prev => prev.map(msg => 
            msg.id === data.messageId 
              ? { ...msg, text: data.text, timestamp: new Date(data.timestamp), pendingModeration: false }
              : msg
          ))
          setEditingMessageId(null)
          setEditText('')
          showNotification('Message updated successfully', 'success')
        })

        socketInstance.on('error', (data) => {
          showNotification(data.message, 'error')
        })

        socketInstance.on('ai-response', (response) => {
          const receivedMessage = { 
            id: Date.now() + 1,
            text: response, 
            sender: 'bot', 
            timestamp: new Date() 
          }
          setChatHistory(prev => [...prev, receivedMessage])
        })
        
        setSocket(socketInstance)
      }, 100)
    }
  }

  const handleSend = () => {
    if (message.trim() && socket) {
      if (isConnected && partnerId) {
        // User-to-user chat
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        socket.emit('user-message', {
          text: message,
          messageId
        })
      } else {
        // Legacy AI chat
        socket.emit('ai-message', message)
        const userMessage = { 
          id: Date.now(),
          text: message, 
          sender: 'user', 
          timestamp: new Date() 
        }
        setChatHistory(prev => [...prev, userMessage])
      }
      setMessage('')
    }
  }

  const handleEditMessage = (messageId, currentText) => {
    setEditingMessageId(messageId)
    setEditText(currentText)
  }

  const handleSaveEdit = () => {
    if (editText.trim() && socket && editingMessageId) {
      socket.emit('edit-message', {
        messageId: editingMessageId,
        newText: editText
      })
    }
  }

  const handleCancelEdit = () => {
    setEditingMessageId(null)
    setEditText('')
  }

  const handleTrainingSubmit = async () => {
    if (!trainingMessage.trim()) {
      showNotification('Please enter a message', 'error')
      return
    }

    try {
      const response = await fetch('http://localhost:3000/api/training', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: trainingMessage,
          isHarassment: trainingIsHarassment
        })
      })

      const data = await response.json()
      if (data.success) {
        showNotification('Training data added successfully!', 'success')
        setTrainingMessage('')
        setTrainingIsHarassment(false)
        setShowTrainingModal(false)
      } else {
        showNotification('Error: ' + data.error, 'error')
      }
    } catch (error) {
      showNotification('Error submitting training data: ' + error.message, 'error')
    }
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (editingMessageId) {
        handleSaveEdit()
      } else {
        handleSend()
      }
    }
  }

  const formatTime = (date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  }

  const getAvatarInitial = (sender) => {
    if (sender === 'user') return 'Y'
    if (sender === 'partner') return 'P'
    return 'AI'
  }

  return (
    <div className="h-screen overflow-hidden bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      {/* Notification Toast */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-6 py-3 rounded-lg shadow-2xl flex items-center space-x-3 animate-slide-in ${
          notification.type === 'success' ? 'bg-emerald-600' :
          notification.type === 'error' ? 'bg-red-600' :
          notification.type === 'warning' ? 'bg-amber-600' :
          'bg-blue-600'
        }`}>
          <span className="text-white font-medium">{notification.message}</span>
          <button onClick={() => setNotification(null)} className="text-white hover:text-gray-200">×</button>
        </div>
      )}

      <div className="w-full max-w-4xl h-[90vh] bg-gray-900/80 backdrop-blur-xl rounded-3xl shadow-2xl flex flex-col border border-gray-700/50 overflow-hidden">
        {/* Chat Header */}
        <div className={`px-8 py-5 border-b transition-all duration-300 ${
          isConnected 
            ? 'border-emerald-500/20 bg-gradient-to-r from-emerald-900/20 via-gray-800/50 to-gray-900/50' 
            : 'border-gray-700/50 bg-gradient-to-r from-gray-800/50 to-gray-900/50'
        }`}>
          <div className="flex items-center justify-between gap-6">
            {/* Left Section: Icon + Title */}
            <div className="flex items-center gap-4 flex-1 min-w-0">
              {/* Icon */}
              <div className={`w-11 h-11 rounded-full flex items-center justify-center shadow-lg flex-shrink-0 transition-all duration-300 ${
                isConnected 
                  ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 ring-2 ring-emerald-500/30' 
                  : 'bg-gradient-to-br from-blue-500 to-purple-600'
              }`}>
                {isConnected ? (
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                )}
              </div>
              
              {/* Title Section */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2.5 mb-0.5">
                  <h1 className="text-lg font-bold text-gray-100 tracking-tight truncate">
                    {isConnected ? 'Chat with Partner' : isWaiting ? 'Finding Match...' : 'AI Chatbot'}
                  </h1>
                  {isConnected && (
                    <div className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/30 rounded-full flex-shrink-0">
                      <div className="h-1.5 w-1.5 bg-emerald-400 rounded-full animate-pulse"></div>
                      <span className="text-[10px] font-medium text-emerald-300 leading-none">Live</span>
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-400 leading-relaxed truncate">
                  {isConnected ? 'AI-protected conversation' : isWaiting ? 'Matching you with someone...' : 'Powered by AI'}
                </p>
              </div>
            </div>
            
            {/* Right Section: Action Buttons */}
            <div className="flex items-center gap-3 flex-shrink-0">
              {isConnected && (
                <button
                  onClick={handleDisconnect}
                  className="h-9 px-4 bg-gray-700/50 hover:bg-red-600/20 hover:border-red-500/50 text-gray-300 hover:text-red-300 text-sm font-medium rounded-lg transition-all duration-200 border border-gray-600/50 flex items-center justify-center gap-2 group min-w-[85px]"
                  title="Leave conversation"
                >
                  <svg className="w-4 h-4 group-hover:rotate-90 transition-transform duration-200 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="hidden sm:inline">Leave</span>
                </button>
              )}
              {isWaiting && (
                <div className="h-9 px-4 flex items-center justify-center gap-2 bg-amber-500/20 border border-amber-500/30 rounded-lg">
                  <div className="h-2 w-2 bg-amber-400 rounded-full animate-pulse shadow-lg shadow-amber-400/50 flex-shrink-0"></div>
                  <span className="text-sm font-medium text-amber-300 whitespace-nowrap">Searching...</span>
                </div>
              )}
              {!isConnected && !isWaiting && (
                <button
                  onClick={handleFindMatch}
                  className="h-9 px-5 bg-gradient-to-r from-blue-600 to-purple-600 text-white text-sm font-medium rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 flex items-center justify-center gap-2.5 min-w-[130px]"
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span className="whitespace-nowrap">Find Match</span>
                </button>
              )}
              <button
                onClick={() => setShowTrainingModal(true)}
                className={`h-9 px-4 text-white text-sm font-medium rounded-lg transition-all duration-200 shadow-lg flex items-center justify-center gap-2 min-w-[85px] ${
                  isConnected 
                    ? 'bg-gray-700/50 hover:bg-gray-700 border border-gray-600/50' 
                    : 'bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 shadow-purple-500/25 hover:shadow-purple-500/40'
                }`}
                title="Train AI Moderation"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
                <span className="hidden sm:inline whitespace-nowrap">Train</span>
              </button>
            </div>
          </div>
        </div>

        {/* Chat Messages */}
        <div className={`flex-1 overflow-y-auto px-8 py-6 space-y-4 transition-all duration-300 ${
          isConnected 
            ? 'bg-gradient-to-b from-emerald-900/10 via-gray-900/50 to-gray-900' 
            : 'bg-gradient-to-b from-gray-900/50 to-gray-900'
        }`}>
          {chatHistory.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              {isConnected ? (
                <>
                  <div className="relative mb-6">
                    <div className="w-28 h-28 rounded-full bg-gradient-to-br from-emerald-500/30 to-blue-500/30 flex items-center justify-center border-2 border-emerald-500/30 shadow-xl shadow-emerald-500/20">
                      <svg className="w-14 h-14 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                    </div>
                    <div className="absolute -top-1 -right-1 w-6 h-6 bg-emerald-500 rounded-full flex items-center justify-center border-2 border-gray-900 shadow-lg">
                      <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
                    </div>
                  </div>
                  <h3 className="text-2xl font-bold text-gray-200 mb-3 bg-gradient-to-r from-emerald-400 to-blue-400 bg-clip-text text-transparent">
                    You're Connected!
                  </h3>
                  <p className="text-sm text-gray-400 max-w-md mb-4 leading-relaxed">
                    Start chatting with your partner. All messages are protected by AI-powered moderation to ensure a safe conversation.
                  </p>
                  <div className="flex items-center space-x-2 text-xs text-gray-500">
                    <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <span>End-to-end moderated • Secure</span>
                  </div>
                </>
              ) : isWaiting ? (
                <>
                  <div className="w-24 h-24 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-600/20 flex items-center justify-center mb-4 border border-amber-500/30 animate-pulse">
                    <svg className="w-12 h-12 text-amber-400 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-300 mb-2">Finding someone to chat with...</h3>
                  <p className="text-sm text-gray-500 max-w-md">
                    Please wait while we match you with another user
                  </p>
                </>
              ) : (
                <>
                  <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-500/20 to-purple-600/20 flex items-center justify-center mb-4 border border-gray-700/50">
                    <svg className="w-12 h-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-300 mb-2">Welcome to Safe Chat</h3>
                  <p className="text-sm text-gray-500 max-w-md">
                    Start a conversation with AI or find a match to chat with others
                  </p>
                </>
              )}
            </div>
          )}
          {chatHistory.map((chat, index) => {
            const warning = harassmentWarnings.get(chat.id)
            const isEditing = editingMessageId === chat.id

            return (
              <div key={chat.id || index} className="group">
                {warning && (
                  <div className="mb-3 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-300 text-sm backdrop-blur-sm">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start space-x-2">
                        <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <div className="flex-1">
                          <strong className="font-semibold">Warning:</strong> {warning.warning}
                        </div>
                      </div>
                      {chat.sender === 'user' && !isEditing && (
                        <button
                          onClick={() => handleEditMessage(chat.id, chat.text)}
                          className="ml-3 px-2 py-1 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-xs font-medium transition-colors flex-shrink-0"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div
                  className={`flex ${
                    chat.sender === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div className={`flex items-end space-x-3 max-w-[75%] ${
                    chat.sender === 'user' ? 'flex-row-reverse space-x-reverse' : 'flex-row'
                  }`}>
                    {/* Avatar */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0 shadow-lg ${
                      chat.sender === 'user' 
                        ? 'bg-gradient-to-br from-blue-500 to-blue-600 text-white' 
                        : chat.sender === 'partner'
                        ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 text-white'
                        : 'bg-gradient-to-br from-purple-500 to-purple-600 text-white'
                    }`}>
                      {getAvatarInitial(chat.sender)}
                    </div>
                    
                    {/* Message Bubble */}
                    <div className="flex flex-col space-y-1">
                      {isEditing ? (
                        <div className="rounded-2xl px-4 py-3 bg-gray-800 border-2 border-blue-500 shadow-xl">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyPress={handleKeyPress}
                            className="w-full bg-transparent text-gray-100 text-sm resize-none focus:outline-none min-h-[60px]"
                            rows="3"
                            autoFocus
                          />
                          <div className="flex items-center space-x-2 mt-3">
                            <button
                              onClick={handleSaveEdit}
                              className="h-8 px-4 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center min-w-[70px]"
                            >
                              Save
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="h-8 px-4 bg-gray-600 text-white text-xs font-medium rounded-lg hover:bg-gray-700 transition-colors flex items-center justify-center min-w-[70px]"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`rounded-2xl px-4 py-3 shadow-lg backdrop-blur-sm ${
                            chat.sender === 'user'
                              ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white rounded-br-sm'
                              : chat.sender === 'partner'
                              ? 'bg-gradient-to-br from-emerald-600 to-emerald-700 text-white rounded-bl-sm'
                              : 'bg-gradient-to-br from-gray-700 to-gray-800 text-gray-100 rounded-bl-sm'
                          } ${chat.pendingModeration ? 'opacity-60 animate-pulse' : ''}`}
                        >
                          {chat.pendingModeration && (
                            <div className="flex items-center space-x-1 text-xs mb-2 opacity-75">
                              <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              <span>Checking...</span>
                            </div>
                          )}
                          <p className="text-sm break-words leading-relaxed">{chat.text}</p>
                          <div className={`text-[10px] mt-2 flex items-center space-x-1 ${
                            chat.sender === 'user' ? 'text-blue-200' : 'text-gray-300'
                          }`}>
                            <span>{formatTime(chat.timestamp)}</span>
                            {chat.sender === 'user' && (
                              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Message Input */}
        <div className="px-8 py-5 border-t border-gray-700/50 bg-gray-800/50 backdrop-blur-sm">
          <div className="flex items-end gap-3">
            <div className="flex-1 relative">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={isConnected ? "Type your message..." : "Type your message or find a match..."}
                className="w-full resize-none rounded-xl bg-gray-700/50 border border-gray-600/50 px-4 py-3 pr-12 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 text-sm placeholder-gray-400 text-gray-100 transition-all leading-relaxed"
                rows="1"
                disabled={isWaiting}
                style={{ minHeight: '44px', maxHeight: '120px' }}
              />
              <div className="absolute right-4 bottom-3.5 text-xs text-gray-500 pointer-events-none">
                {message.length > 0 && `${message.length}`}
              </div>
            </div>
            <button
              onClick={handleSend}
              disabled={!message.trim() || isWaiting}
              className="h-11 px-6 bg-gradient-to-r from-blue-600 to-purple-600 text-white text-sm font-medium rounded-xl hover:from-blue-700 hover:to-purple-700 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none flex items-center justify-center gap-2 min-w-[110px] flex-shrink-0"
            >
              <span>Send</span>
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Training Modal */}
      {showTrainingModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-gray-800/95 backdrop-blur-xl rounded-2xl p-6 max-w-md w-full border border-gray-700/50 shadow-2xl animate-scale-in">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </div>
                <h2 className="text-xl font-bold text-gray-100">Train AI Moderation</h2>
              </div>
              <button
                onClick={() => {
                  setShowTrainingModal(false)
                  setTrainingMessage('')
                  setTrainingIsHarassment(false)
                }}
                className="text-gray-400 hover:text-gray-200 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-sm text-gray-400 mb-6">
              Help improve the AI by providing examples of messages and whether they contain harassment.
            </p>
            
            <div className="mb-5">
              <label className="block text-sm font-medium text-gray-300 mb-2">Message:</label>
              <textarea
                value={trainingMessage}
                onChange={(e) => setTrainingMessage(e.target.value)}
                placeholder="Enter a message example..."
                className="w-full bg-gray-700/50 border border-gray-600/50 rounded-xl p-3 text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-all resize-none"
                rows="4"
              />
            </div>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">Is this harassment?</label>
              <div className="flex space-x-4">
                <label className="flex-1 flex items-center justify-center p-3 bg-red-500/10 border-2 border-transparent hover:border-red-500/50 rounded-xl cursor-pointer transition-all">
                  <input
                    type="radio"
                    checked={trainingIsHarassment === true}
                    onChange={() => setTrainingIsHarassment(true)}
                    className="mr-2 accent-red-500"
                  />
                  <span className="text-gray-300 font-medium">Yes</span>
                </label>
                <label className="flex-1 flex items-center justify-center p-3 bg-emerald-500/10 border-2 border-transparent hover:border-emerald-500/50 rounded-xl cursor-pointer transition-all">
                  <input
                    type="radio"
                    checked={trainingIsHarassment === false}
                    onChange={() => setTrainingIsHarassment(false)}
                    className="mr-2 accent-emerald-500"
                  />
                  <span className="text-gray-300 font-medium">No</span>
                </label>
              </div>
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={handleTrainingSubmit}
                className="flex-1 h-11 bg-gradient-to-r from-purple-600 to-pink-600 text-white px-4 rounded-xl hover:from-purple-700 hover:to-pink-700 transition-all duration-200 shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 font-medium flex items-center justify-center"
              >
                Submit
              </button>
              <button
                onClick={() => {
                  setShowTrainingModal(false)
                  setTrainingMessage('')
                  setTrainingIsHarassment(false)
                }}
                className="flex-1 h-11 bg-gray-700/50 text-gray-300 px-4 rounded-xl hover:bg-gray-700 transition-all duration-200 font-medium border border-gray-600/50 flex items-center justify-center"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
