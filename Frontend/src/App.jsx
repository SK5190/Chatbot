import { useState, useRef, useEffect } from 'react'
import './App.css'
import { io } from "socket.io-client";


function App() {
  const [message, setMessage] = useState('')
  const [socket, setSocket] = useState(null)
  const [chatHistory, setChatHistory] = useState([])
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
   let socketInstance = io("http://localhost:3000");
   setSocket(socketInstance)

   socketInstance.on('ai-response', (response) => {
        const receivedMessage = { 
          id: Date.now() + 1,
          text: response, 
          sender: 'bot', 
          timestamp: new Date() 
        }
        setChatHistory(prev => [...prev, receivedMessage])
   })
  }, [chatHistory])

  const handleSend = () => {
    if (message.trim()) {
      // Add user message
      const userMessage = { id: Date.now(),text: message, sender: 'user', timestamp: new Date() }
      setChatHistory([...chatHistory, userMessage])
      socket.emit('ai-message', message)
      setMessage('')
      
      
      // Simulate received message (you can replace this with actual API call)
      
    }
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const formatTime = (date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  }

  return (
    <div className="h-screen overflow-hidden bg-black flex items-center justify-center">
      <div className="w-full max-w-2xl h-[600px] bg-gray-900 rounded-2xl shadow-2xl flex flex-col border border-gray-800">
        {/* Chat Header */}
        <div className="px-6 py-4 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-gray-100 tracking-tight">Chat Interface</h1>
            <div className="flex items-center space-x-2">
              <div className="h-2.5 w-2.5 bg-emerald-500 rounded-full animate-pulse"></div>
              <span className="text-sm text-gray-400">Online</span>
            </div>
          </div>
        </div>

        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 hover:overflow-y-scroll">
          {chatHistory.map((chat, index) => (
            <div
              key={index}
              className={`flex ${
                chat.sender === 'user' ? 'justify-end' : 'justify-start'
              } animate-fade-in`}
            >
              <div className={`flex items-start space-x-2 ${
                chat.sender === 'user' ? 'flex-row-reverse space-x-reverse' : 'flex-row'
              }`}>
                {/* Avatar */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  chat.sender === 'user' ? 'bg-blue-600' : 'bg-gray-700'
                }`}>
                  <span className="text-xs text-white">
                    {chat.sender === 'user' ? 'You' : 'Bot'}
                  </span>
                </div>
                
                {/* Message Bubble */}
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-2 text-right ${
                    chat.sender === 'user'
                      ? 'bg-blue-600 text-white rounded-tr-none'
                      : 'bg-gray-700 text-gray-100 rounded-tl-none'
                  } shadow-lg`}
                >
                  <p className="text-sm break-words text-left">{chat.text}</p>
                  <div className={`text-[10px] mt-1 ${
                    chat.sender === 'user' ? 'text-blue-200' : 'text-gray-400'
                  }`}>
                    {formatTime(chat.timestamp)}
                  </div>
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Message Input */}
        <div className="px-6 py-4 border-t border-gray-700 bg-gray-800">
          <div className="flex space-x-3">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Type your message..."
              className="flex-1 resize-none rounded-lg bg-gray-700 border-none p-2 focus:outline-none focus:ring-1 focus:ring-blue-500 text-sm placeholder-gray-400 text-gray-100"
              rows="1"
            />
            <button
              onClick={handleSend}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!message.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
