import { useState, useRef, useEffect, useCallback } from 'react'
import { ToastContainer, toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'
import './App.css'
import { io } from "socket.io-client";

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000'
/** Fallback if API omits expiresInSeconds (matches backend default) */
const DEFAULT_SESSION_SEC = 600
/** v2 keys: invalidates stale sessionStorage from older 60s sessions */
const SS_TOKEN = 'ask_session_token_v2'
const SS_EXP = 'ask_session_exp_ms_v2'
const SS_NAME = 'ask_display_name_v2'
/** Must match server.js harassment window (ms). */
const MODERATION_EDIT_WINDOW_MS = 5000
/** Dark abstract background for sign-in hero (blend-friendly). */
const HERO_BG_IMAGE =
  'https://images.unsplash.com/photo-1557682250-33bd709cbe85?auto=format&fit=crop&w=1920&q=80'

function App() {
  const [message, setMessage] = useState('')
  const [socket, setSocket] = useState(null)
  const [chatHistory, setChatHistory] = useState([])
  const [userId, setUserId] = useState(null)
  const [partnerId, setPartnerId] = useState(null)
  const [partnerDisplayName, setPartnerDisplayName] = useState(null)
  /** Socket room for current human match — used to scope training examples until disconnect. */
  const [matchRoomId, setMatchRoomId] = useState(null)
  const [displayNameInput, setDisplayNameInput] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [otpInput, setOtpInput] = useState('')
  const [authStep, setAuthStep] = useState('email')
  const [myDisplayName, setMyDisplayName] = useState('')
  const [sessionToken, setSessionToken] = useState(null)
  const [sessionExpiresAtMs, setSessionExpiresAtMs] = useState(0)
  const [sessionNow, setSessionNow] = useState(() => Date.now())
  const expiryNoticeRef = useRef(false)
  const [consentRole, setConsentRole] = useState(null) // null | 'requester' | 'responder'
  const [consentPeerName, setConsentPeerName] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isWaiting, setIsWaiting] = useState(false)
  const [showTrainingModal, setShowTrainingModal] = useState(false)
  const [trainingMessage, setTrainingMessage] = useState('')
  const [trainingIsHarassment, setTrainingIsHarassment] = useState(false)
  /** @type {null | { source: 'manual' | 'partner_message' | 'flagged_own', sourceMessageId?: string, partnerDisplayName?: string, roomId?: string | null }} */
  const [trainingMeta, setTrainingMeta] = useState(null)
  const [editingMessageId, setEditingMessageId] = useState(null)
  const [editText, setEditText] = useState('')
  const [harassmentWarnings, setHarassmentWarnings] = useState(new Map())
  /** Ticks while any moderation banner is visible (countdown). */
  const [moderationNow, setModerationNow] = useState(() => Date.now())
  const messagesEndRef = useRef(null)
  const approvedMessageIdsRef = useRef(new Set())
  const [socketVersion, setSocketVersion] = useState(0)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  const showNotification = (message, type = 'info') => {
    const options = { position: 'top-right', autoClose: 4000, hideProgressBar: false, closeOnClick: true, pauseOnHover: true, draggable: true, style: { padding: '14px 18px', borderRadius: '10px', minWidth: '280px' } }
    if (type === 'success') toast.success(message, options)
    else if (type === 'error') toast.error(message, options)
    else if (type === 'warning') toast.warning(message, options)
    else toast.info(message, options)
  }

  const resetAuthState = useCallback(({ manual = false } = {}) => {
    if (manual) expiryNoticeRef.current = false
    sessionStorage.removeItem(SS_TOKEN)
    sessionStorage.removeItem(SS_EXP)
    sessionStorage.removeItem(SS_NAME)
    setSessionExpiresAtMs(0)
    setAuthStep('email')
    setOtpInput('')
    setEmailInput('')
    setDisplayNameInput('')
    setMyDisplayName('')
    setPartnerId(null)
    setPartnerDisplayName(null)
    setMatchRoomId(null)
    setIsConnected(false)
    setIsWaiting(false)
    setConsentRole(null)
    setConsentPeerName('')
    setChatHistory([])
    approvedMessageIdsRef.current.clear()
    setUserId(null)
    setSessionToken(null)
  }, [])

  function showSessionExpiryNotice(message) {
    if (expiryNoticeRef.current) return
    expiryNoticeRef.current = true
    showNotification(message, 'warning')
  }

  function setupSocketListeners(socketInstance, { onSessionExpired } = {}) {
    socketInstance.on('user-id', (id) => {
      setUserId(id)
    })

    socketInstance.on('matched', (data) => {
      setPartnerId(data.partnerId)
      setPartnerDisplayName(data.partnerName || null)
      setMatchRoomId(data.roomId ?? null)
      setIsConnected(true)
      setIsWaiting(false)
      setConsentRole(null)
      setConsentPeerName('')
      showNotification(
        data.partnerName
          ? `You're chatting with ${data.partnerName}`
          : 'Successfully matched with a partner!',
        'success'
      )
    })

    socketInstance.on('waiting-for-match', () => {
      setIsWaiting(true)
      setIsConnected(false)
      setMatchRoomId(null)
      setConsentRole(null)
      setConsentPeerName('')
      showNotification('Searching for a match...', 'info')
    })

    socketInstance.on('search-cancelled', () => {
      setIsWaiting(false)
    })

    socketInstance.on('match-request', (data) => {
      setIsWaiting(false)
      setConsentRole('responder')
      setConsentPeerName(data.partnerName || 'Someone')
    })

    socketInstance.on('match-pending', (data) => {
      setIsWaiting(false)
      setConsentRole('requester')
      setConsentPeerName(data.partnerName || 'Someone')
      showNotification(`Waiting for ${data.partnerName || 'your match'} to accept…`, 'info')
    })

    socketInstance.on('match-declined', (data) => {
      setConsentRole(null)
      setConsentPeerName('')
      setMatchRoomId(null)
      if (data?.reason === 'peer-declined') {
        showNotification('The other person declined the chat.', 'warning')
      }
    })

    socketInstance.on('match-cancelled', () => {
      setConsentRole(null)
      setConsentPeerName('')
      setMatchRoomId(null)
      showNotification('Chat request was cancelled.', 'info')
    })

    socketInstance.on('partner-disconnected', () => {
      setIsConnected(false)
      setPartnerId(null)
      setPartnerDisplayName(null)
      setMatchRoomId(null)
      setChatHistory([])
      approvedMessageIdsRef.current.clear()
      showNotification('Your partner has disconnected', 'warning')
    })

    socketInstance.on('user-message-sent', (data) => {
      const alreadyApproved = approvedMessageIdsRef.current.has(data.messageId)
      if (alreadyApproved) approvedMessageIdsRef.current.delete(data.messageId)
      const messageObj = {
        id: data.messageId,
        text: data.text,
        sender: 'user',
        timestamp: new Date(data.timestamp),
        pendingModeration: alreadyApproved ? false : data.pendingModeration
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
          reason: data.reason || 'Matched safety rules',
          warning: data.warning,
          flaggedAt: Date.now(),
          expanded: true
        })
        return newMap
      })

      showNotification('Your message was held for review — you can edit it briefly.', 'warning')
    })

    socketInstance.on('message-deleted', (data) => {
      setChatHistory(prev => prev.filter(msg => msg.id !== data.messageId))
      setHarassmentWarnings(prev => {
        const newMap = new Map(prev)
        newMap.delete(data.messageId)
        return newMap
      })
      showNotification('That message was removed after the edit window.', 'info')
    })

    socketInstance.on('message-approved', (data) => {
      approvedMessageIdsRef.current.add(data.messageId)
      setChatHistory(prev => prev.map(msg =>
        msg.id === data.messageId ? { ...msg, pendingModeration: false } : msg
      ))
    })

    socketInstance.on('message-edited', (data) => {
      setChatHistory(prev => prev.map(msg =>
        msg.id === data.messageId
          ? { ...msg, text: data.text, timestamp: new Date(data.timestamp), pendingModeration: false }
          : msg
      ))
      setEditingMessageId(null)
      setEditText('')
      setHarassmentWarnings(prev => {
        const next = new Map(prev)
        next.delete(data.messageId)
        return next
      })
      showNotification('Message updated successfully', 'success')
    })

    socketInstance.on('error', (data) => {
      showNotification(data.message, 'error')
    })

    socketInstance.on('session-expired', (data) => {
      showSessionExpiryNotice(data?.message || 'Session ended. Please sign in again.')
      onSessionExpired?.()
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
  }

  useEffect(() => {
    scrollToBottom()
  }, [chatHistory])

  useEffect(() => {
    if (harassmentWarnings.size === 0) return
    const id = setInterval(() => setModerationNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [harassmentWarnings.size])

  useEffect(() => {
    const t = sessionStorage.getItem(SS_TOKEN)
    const exp = parseInt(sessionStorage.getItem(SS_EXP) || '0', 10)
    const name = sessionStorage.getItem(SS_NAME) || ''
    if (t && exp > Date.now()) {
      expiryNoticeRef.current = false
      setSessionToken(t)
      setSessionExpiresAtMs(exp)
      setSessionNow(Date.now())
      if (name) setMyDisplayName(name)
    } else {
      sessionStorage.removeItem(SS_TOKEN)
      sessionStorage.removeItem(SS_EXP)
      sessionStorage.removeItem(SS_NAME)
    }
  }, [])

  useEffect(() => {
    if (!sessionToken) {
      setSocket((prev) => {
        if (prev) {
          prev.removeAllListeners()
          prev.disconnect()
        }
        return null
      })
      return
    }

    const socketInstance = io(API_BASE, {
      auth: { token: sessionToken },
      transports: ['websocket', 'polling'],
      withCredentials: true
    })

    setupSocketListeners(socketInstance, {
      onSessionExpired: () => resetAuthState({ manual: false })
    })

    socketInstance.on('connect_error', (err) => {
      showNotification(err.message || 'Could not connect. Check your session or try again.', 'error')
    })

    setSocket(socketInstance)

    return () => {
      socketInstance.removeAllListeners()
      socketInstance.disconnect()
    }
  }, [sessionToken, socketVersion, resetAuthState])

  useEffect(() => {
    if (!sessionToken || sessionExpiresAtMs <= Date.now()) return
    const id = setInterval(() => {
      const now = Date.now()
      if (now >= sessionExpiresAtMs) {
        showSessionExpiryNotice('Session time limit reached. Sign in again to continue.')
        resetAuthState({ manual: false })
      } else {
        setSessionNow(now)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [sessionToken, sessionExpiresAtMs, resetAuthState])

  const isAuthenticated = Boolean(sessionToken && sessionExpiresAtMs > Date.now())
  const sessionSecondsLeft = isAuthenticated
    ? Math.max(0, Math.ceil((sessionExpiresAtMs - sessionNow) / 1000))
    : 0

  const handleRequestOtp = async () => {
    const displayName = displayNameInput.trim().slice(0, 40)
    const email = emailInput.trim().toLowerCase()
    if (!displayName) {
      showNotification('Please enter your display name.', 'error')
      return
    }
    if (!email || !/^[^\s@]+@gmail\.com$/i.test(email)) {
      showNotification('Enter a valid @gmail.com address.', 'error')
      return
    }
    try {
      const response = await fetch(`${API_BASE}/api/auth/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, displayName })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        showNotification(data.error || 'Could not send code.', 'error')
        return
      }
      showNotification(data.message || 'Check your Gmail for the code.', 'success')
      setAuthStep('otp')
      setOtpInput('')
    } catch (e) {
      showNotification(e.message || 'Network error.', 'error')
    }
  }

  const handleVerifyOtp = async () => {
    const email = emailInput.trim().toLowerCase()
    const otp = otpInput.replace(/\s/g, '')
    if (!email || !otp) {
      showNotification('Enter the code from your email.', 'error')
      return
    }
    try {
      const response = await fetch(`${API_BASE}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        showNotification(data.error || 'Verification failed.', 'error')
        return
      }
      expiryNoticeRef.current = false
      const expMs = Date.now() + (data.expiresInSeconds ?? DEFAULT_SESSION_SEC) * 1000
      sessionStorage.setItem(SS_TOKEN, data.token)
      sessionStorage.setItem(SS_EXP, String(expMs))
      sessionStorage.setItem(SS_NAME, data.displayName || '')
      setMyDisplayName(data.displayName || '')
      setSessionExpiresAtMs(expMs)
      setSessionNow(Date.now())
      setSessionToken(data.token)
      setAuthStep('email')
      setOtpInput('')
      const sec = data.expiresInSeconds ?? DEFAULT_SESSION_SEC
      const mins = Math.floor(sec / 60)
      const human =
        sec >= 60
          ? `${mins} minute${mins === 1 ? '' : 's'}`
          : `${sec} seconds`
      showNotification(`Signed in. Session lasts ${human}.`, 'success')
    } catch (e) {
      showNotification(e.message || 'Network error.', 'error')
    }
  }

  const handleFindMatch = () => {
    if (!isAuthenticated || !socket) {
      showNotification('Please sign in first.', 'error')
      return
    }
    socket.emit('find-match')
  }

  const handleCancelSearch = () => {
    if (!socket) return
    if (isWaiting) {
      setIsWaiting(false)
      showNotification('Search cancelled', 'info')
      socket.emit('cancel-search')
      return
    }
    if (consentRole === 'requester') {
      socket.emit('cancel-search')
      showNotification('Chat request cancelled', 'info')
    }
  }

  const handleAcceptMatch = () => {
    socket?.emit('accept-match')
  }

  const handleDeclineMatch = () => {
    socket?.emit('decline-match')
  }

  const handleDisconnect = () => {
    if (socket && isConnected) {
      socket.disconnect()
      setIsConnected(false)
      setPartnerId(null)
      setPartnerDisplayName(null)
      setMatchRoomId(null)
      setChatHistory([])
      approvedMessageIdsRef.current.clear()
      setIsWaiting(false)
      setConsentRole(null)
      setConsentPeerName('')
      showNotification('Disconnected from partner', 'info')
      if (sessionToken) {
        setSocketVersion((v) => v + 1)
      }
    }
  }

  const handleSend = () => {
    if (!socket?.connected) {
      showNotification('Connecting… try again in a moment.', 'info')
      return
    }
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
    if (harassmentWarnings.has(messageId)) {
      socket?.emit('moderation-edit-pause', { messageId })
      setHarassmentWarnings((prev) => {
        const next = new Map(prev)
        const w = next.get(messageId)
        if (w) next.set(messageId, { ...w, pausedAt: Date.now() })
        return next
      })
    }
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
    const id = editingMessageId
    setEditingMessageId(null)
    setEditText('')
    if (id && harassmentWarnings.has(id)) {
      socket?.emit('moderation-edit-resume', { messageId: id })
      setHarassmentWarnings((prev) => {
        const next = new Map(prev)
        const w = next.get(id)
        if (!w?.pausedAt) return prev
        const elapsedBeforePause = w.pausedAt - w.flaggedAt
        const newFlaggedAt = Date.now() - elapsedBeforePause
        next.set(id, { ...w, flaggedAt: newFlaggedAt, pausedAt: undefined })
        return next
      })
    }
  }

  const getModerationSecondsLeft = (warning) => {
    if (!warning) return 0
    const clock = warning.pausedAt != null ? warning.pausedAt : moderationNow
    const elapsed = clock - warning.flaggedAt
    return Math.max(0, Math.ceil((MODERATION_EDIT_WINDOW_MS - elapsed) / 1000))
  }

  const collapseModerationNotice = (messageId) => {
    setHarassmentWarnings((prev) => {
      const next = new Map(prev)
      const w = next.get(messageId)
      if (!w) return prev
      next.set(messageId, { ...w, expanded: false })
      return next
    })
  }

  const expandModerationNotice = (messageId) => {
    setHarassmentWarnings((prev) => {
      const next = new Map(prev)
      const w = next.get(messageId)
      if (!w) return prev
      next.set(messageId, { ...w, expanded: true })
      return next
    })
  }

  const closeTrainingModal = () => {
    setShowTrainingModal(false)
    setTrainingMessage('')
    setTrainingIsHarassment(false)
    setTrainingMeta(null)
  }

  const openTrainingModalManual = () => {
    setTrainingMeta({
      source: 'manual',
      roomId: isConnected && matchRoomId ? matchRoomId : null
    })
    setTrainingMessage('')
    setTrainingIsHarassment(false)
    setShowTrainingModal(true)
  }

  const openTrainingFromPartnerMessage = (chat) => {
    if (!chat?.text?.trim()) return
    setTrainingMeta({
      source: 'partner_message',
      sourceMessageId: String(chat.id),
      partnerDisplayName: partnerDisplayName || 'Your match',
      roomId: matchRoomId ?? null
    })
    setTrainingMessage(chat.text.trim())
    setTrainingIsHarassment(false)
    setShowTrainingModal(true)
  }

  const openTrainingFromFlaggedOwnMessage = (chat) => {
    if (!chat?.text?.trim()) return
    setTrainingMeta({
      source: 'flagged_own',
      sourceMessageId: String(chat.id),
      partnerDisplayName: partnerDisplayName || 'Your match',
      roomId: matchRoomId ?? null
    })
    setTrainingMessage(chat.text.trim())
    setTrainingIsHarassment(false)
    setShowTrainingModal(true)
  }

  const handleTrainingSubmit = async () => {
    if (!trainingMessage.trim()) {
      showNotification('Please enter a message', 'error')
      return
    }

    try {
      const payload = {
        message: trainingMessage.trim(),
        isHarassment: trainingIsHarassment
      }
      const src = trainingMeta?.source === 'partner_message'
        ? 'partner_message'
        : trainingMeta?.source === 'flagged_own'
          ? 'flagged_own'
          : 'manual'
      payload.source = src
      if (trainingMeta?.sourceMessageId) payload.sourceMessageId = trainingMeta.sourceMessageId
      if (trainingMeta?.partnerDisplayName) payload.partnerDisplayName = trainingMeta.partnerDisplayName
      const sessionRoom = trainingMeta?.roomId ?? (isConnected && matchRoomId ? matchRoomId : null)
      if (sessionRoom) payload.roomId = sessionRoom

      const response = await fetch(`${API_BASE}/api/training`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      const data = await response.json().catch(() => ({}))
      if (data.success) {
        const inSession = Boolean(sessionRoom)
        showNotification(
          inSession
            ? 'Example saved for this chat. It is removed when the conversation ends.'
            : 'Training example saved for AI-only chat.',
          'success'
        )
        closeTrainingModal()
      } else {
        showNotification('Error: ' + (data.error || response.statusText || 'Request failed'), 'error')
      }
    } catch (error) {
      showNotification('Error submitting training data: ' + error.message, 'error')
    }
  }

  const handleMainComposerKeyDown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    handleSend()
  }

  const handleEditComposerKeyDown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    handleSaveEdit()
  }

  const formatTime = (date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  }

  const formatSessionCountdown = (sec) => {
    const s = Math.max(0, sec)
    const m = Math.floor(s / 60)
    const r = s % 60
    return `${m}:${String(r).padStart(2, '0')}`
  }

  const getAvatarInitial = (sender) => {
    if (sender === 'user') return myDisplayName ? myDisplayName.charAt(0).toUpperCase() : 'Y'
    if (sender === 'partner') return partnerDisplayName ? partnerDisplayName.charAt(0).toUpperCase() : 'P'
    return 'AI'
  }

  const showFindMatch = isAuthenticated && !isConnected && !isWaiting && !consentRole
  const showCancelQueue = isWaiting || consentRole === 'requester'

  return (
    <>
      <ToastContainer
        position="top-right"
        autoClose={4000}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="dark"
        style={{ top: '20px', right: '20px' }}
        toastStyle={{ padding: '14px 20px', borderRadius: '12px', minWidth: '300px', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }}
      />

      {!isAuthenticated && (
        <section
          className="relative isolate z-0 min-h-[100dvh] w-full overflow-x-hidden bg-slate-950"
          aria-label="Sign in to APCS  Safe Chat"
        >
          <div
            className="pointer-events-none absolute inset-0 z-0 bg-slate-900 bg-cover bg-center bg-no-repeat"
            style={{ backgroundImage: `url(${HERO_BG_IMAGE})` }}
            aria-hidden
          />
          <div
            className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-slate-900/30 via-slate-950/85 to-slate-950"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_90%_60%_at_50%_-15%,rgba(99,102,241,0.18),transparent_50%)]"
            aria-hidden
          />
          <div className="relative z-20 flex min-h-[100dvh] w-full flex-col items-center justify-center px-6 py-12 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:px-12 lg:px-20">
            <div
              className="hero-surface-in w-full max-w-md"
              role="dialog"
              aria-modal="true"
              aria-labelledby="welcome-title"
            >
              <div className="welcome-card shadow-2xl ring-1 ring-white/[0.06]">
                <p className="welcome-card-eyebrow">AI powered cyber safe chatbot system</p>
                <h2 id="welcome-title" className="welcome-card-title text-2xl sm:text-[1.75rem] md:text-3xl">
                  {authStep === 'email' ? 'Sign in with Gmail' : 'Enter verification code'}
                </h2>
                <p className="welcome-card-body max-w-prose text-pretty">
                  {authStep === 'email' ? (
                    <>
                      We send a <strong className="text-slate-100">one-time code</strong> to your Gmail to reduce abuse.
                      Use a real <strong className="text-slate-100">@gmail.com</strong> address. After login,
                      your chat session lasts <strong className="text-slate-100">about 10 minutes</strong>
                      —then you sign in again.
                    </>
                  ) : (
                    <>
                      We sent a 6-digit code to <strong className="text-slate-100">{emailInput.trim().toLowerCase()}</strong>.
                      Check your inbox (and spam). Code expires in 10 minutes.
                    </>
                  )}
                </p>
                {authStep === 'email' ? (
                  <>
                    <div className="welcome-form-fields">
                      <div className="flex flex-col">
                        <label htmlFor="auth-display-name" className="welcome-label">
                          Display name
                        </label>
                        <input
                          id="auth-display-name"
                          type="text"
                          value={displayNameInput}
                          onChange={(e) => setDisplayNameInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleRequestOtp()}
                          placeholder="Shown when you match"
                          maxLength={40}
                          className="welcome-input"
                          autoComplete="name"
                          autoFocus
                        />
                      </div>
                      <div className="flex flex-col">
                        <label htmlFor="auth-email" className="welcome-label">
                          Gmail address
                        </label>
                        <input
                          id="auth-email"
                          type="email"
                          value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleRequestOtp()}
                          placeholder="you@gmail.com"
                          className="welcome-input"
                          autoComplete="email"
                        />
                      </div>
                    </div>
                    <button type="button" onClick={handleRequestOtp} className="welcome-continue">
                      Send verification code
                    </button>
                  </>
                ) : (
                  <>
                    <div className="mb-5">
                      <label htmlFor="auth-otp" className="welcome-label">
                        6-digit code
                      </label>
                      <input
                        id="auth-otp"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={otpInput}
                        onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        onKeyDown={(e) => e.key === 'Enter' && handleVerifyOtp()}
                        placeholder="000000"
                        maxLength={6}
                        className="welcome-input tracking-widest text-left text-lg font-mono"
                        autoFocus
                      />
                    </div>
                    <button type="button" onClick={handleVerifyOtp} className="welcome-continue mb-3">
                      Verify & continue
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep('email')
                        setOtpInput('')
                      }}
                      className="h-11 w-full rounded-xl text-sm font-medium text-slate-400 transition-colors hover:text-slate-200"
                    >
                      ← Use a different email
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {isAuthenticated && (
      <div className="min-h-screen min-h-[100dvh] overflow-hidden flex items-center justify-center p-5 sm:p-7 md:p-8 pb-[max(1.25rem,env(safe-area-inset-bottom))] bg-[radial-gradient(ellipse_100%_80%_at_50%_-30%,rgba(99,102,241,0.18),transparent_50%)] bg-gradient-to-b from-slate-950 via-slate-900 to-[#0a0d14]">
      {/* Blocking consent: other user must accept or decline before chat connects */}
      {isAuthenticated && consentRole === 'responder' && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center p-4 sm:p-6 consent-overlay animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-dialog-title"
        >
          <div className="consent-modal-card consent-modal-card--spacious w-full max-w-lg animate-scale-in flex flex-col">
            <p className="welcome-card-eyebrow text-emerald-300/90">Connection request</p>
            <h2 id="consent-dialog-title" className="text-2xl font-bold text-slate-50 tracking-tight mb-3">
              Allow this chat?
            </h2>
            <p className="text-slate-300 text-[0.9375rem] leading-relaxed mb-3">
              <span className="font-semibold text-emerald-300">{consentPeerName}</span> wants to start a conversation with you.
            </p>
            <p className="text-slate-400 text-sm leading-relaxed mb-6 sm:mb-8 flex-1">
              Choose <strong className="text-slate-200 font-medium">Accept</strong> only if you agree to connect. You can{' '}
              <strong className="text-slate-200 font-medium">Decline</strong> anytime. After you connect, messages are checked by AI moderation.
            </p>
            <div className="consent-modal-actions">
              <button
                type="button"
                onClick={handleDeclineMatch}
                className="consent-btn-secondary rounded-xl text-slate-100 text-sm font-semibold"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={handleAcceptMatch}
                className="consent-btn-primary rounded-xl text-white text-sm font-semibold"
              >
                Accept connection
              </button>
            </div>
          </div>
        </div>
      )}

      {isAuthenticated && consentRole === 'requester' && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center p-4 sm:p-6 consent-overlay animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-wait-title"
        >
          <div className="consent-modal-card consent-modal-card--spacious w-full max-w-lg animate-scale-in text-center sm:text-left flex flex-col">
            <p className="welcome-card-eyebrow text-sky-300/90 text-center sm:text-left">Waiting for approval</p>
            <h2 id="consent-wait-title" className="text-2xl font-bold text-slate-50 tracking-tight mb-3">
              Waiting on {consentPeerName}
            </h2>
            <p className="text-slate-300 text-[0.9375rem] leading-relaxed mb-6">
              They need to <strong className="text-slate-100">accept or decline</strong> your chat request before you can message each other.
              You can cancel below or use <strong className="text-slate-100">Leave</strong> in the header.
            </p>
            <div className="flex flex-col items-center gap-6 mt-auto">
              <div className="flex justify-center items-center gap-1.5 py-1" aria-live="polite">
                <span className="sr-only">Waiting for their response</span>
                <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse [animation-delay:150ms]" />
                <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse [animation-delay:300ms]" />
              </div>
              <button
                type="button"
                onClick={handleCancelSearch}
                className="consent-btn-cancel-wait w-full sm:w-auto min-w-[12.5rem] min-h-[3rem] px-8 py-3 rounded-xl text-slate-100 text-sm font-semibold"
              >
                Cancel request
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="showcase-shell w-full max-w-4xl h-[90vh] max-h-[920px] bg-gray-900/85 backdrop-blur-xl rounded-[1.75rem] flex flex-col border border-slate-600/35 overflow-hidden">
        {/* Chat Header */}
        <div
          className={`chat-shell-header shrink-0 border-b shadow-[0_1px_0_0_rgba(255,255,255,0.08),inset_0_1px_0_0_rgba(255,255,255,0.04)] backdrop-blur-sm transition-all duration-300 !px-4 !py-4 sm:!px-5 sm:!py-5 md:!px-7 md:!py-5 lg:!px-8 ${
          isConnected 
              ? 'border-emerald-500/30 bg-gradient-to-r from-emerald-950/40 via-slate-900/88 to-slate-950/92'
              : consentRole
                ? 'border-violet-500/25 bg-gradient-to-r from-violet-950/30 via-slate-900/88 to-slate-950/92'
                : isWaiting
                  ? 'border-amber-500/25 bg-gradient-to-r from-amber-950/25 via-slate-900/88 to-slate-950/92'
                  : 'border-slate-500/25 bg-gradient-to-r from-slate-800/70 to-slate-950/93'
          }`}
        >
          <div className="flex w-full min-h-[4.25rem] flex-col items-stretch gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
            {/* Left: logo + title stack */}
            <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4 lg:min-w-[12rem]">
              <div
                className={`flex h-12 w-12 shrink-0 items-center justify-center self-center rounded-2xl shadow-lg transition-all duration-300 ${
                isConnected 
                    ? 'bg-gradient-to-br from-emerald-500 to-teal-600 ring-2 ring-emerald-400/35 shadow-emerald-500/25'
                    : consentRole
                      ? 'bg-gradient-to-br from-violet-500 to-indigo-600 ring-2 ring-violet-400/30'
                      : isWaiting
                        ? 'bg-gradient-to-br from-amber-500 to-orange-600 ring-2 ring-amber-400/25'
                        : 'bg-gradient-to-br from-indigo-500 via-violet-600 to-purple-700 ring-1 ring-white/12 shadow-indigo-950/30'
                }`}
              >
                {isConnected ? (
                  <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                ) : (
                  <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                <h1 className="truncate text-xl font-bold leading-tight tracking-tight text-slate-50 sm:text-2xl">
                  {isConnected
                    ? partnerDisplayName
                      ? `Chat with ${partnerDisplayName}`
                      : 'Chat with Partner'
                    : consentRole === 'responder'
                      ? 'Chat request'
                      : consentRole === 'requester'
                        ? 'Waiting for approval'
                        : isWaiting
                          ? 'Finding Match...'
                          : 'APCS  Chatbot'}
                </h1>
                <p className="line-clamp-2 text-xs leading-snug text-slate-400 sm:text-sm sm:leading-relaxed">
                  {isConnected
                    ? 'AI-protected conversation'
                    : consentRole === 'responder'
                      ? `${consentPeerName} wants to start a chat`
                      : consentRole === 'requester'
                        ? `${consentPeerName} needs to accept before you connect`
                        : isWaiting
                          ? 'Matching you with someone...'
                          : 'Created by CS2513 Group'}
                </p>
              </div>
            </div>

            {/* Center: Live + session timer (grouped) */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 lg:flex-initial lg:justify-center">
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-600/35 bg-slate-950/45 p-1.5 sm:gap-2.5 sm:p-2">
                {isConnected && (
                  <div className="inline-flex h-9 w-20 shrink-0 items-center justify-center gap-2 rounded-full border border-emerald-400/50 bg-emerald-500/20 px-3.5 shadow-[0_0_14px_-4px_rgba(52,211,153,0.55)] sm:h-10 sm:px-4">
                    <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-35" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.7)]" />
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-wide leading-none text-emerald-50 sm:text-xs">
                      Live
                    </span>
                  </div>
                )}
                <div
                  className="inline-flex h-9 min-w-[4.5rem] items-center justify-center gap-2 rounded-full border border-amber-400/45 bg-amber-500/15 px-3 shadow-sm shadow-amber-950/25 sm:h-10 sm:px-3.5"
                  title="Time until session ends — sign in again with OTP after"
                >
                  <svg className="h-3.5 w-3.5 shrink-0 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-xs font-semibold tabular-nums tracking-wide text-amber-50">
                    {formatSessionCountdown(sessionSecondsLeft)}
                  </span>
                </div>
              </div>
            </div>

            {/* Right: actions — tertiary → secondary → primary */}
            <div className="flex flex-wrap items-center gap-2 lg:max-w-[min(100%,28rem)] lg:shrink-0 lg:justify-end">
              {isAuthenticated && (
                <button
                  type="button"
                  onClick={() => {
                    resetAuthState({ manual: true })
                    showNotification('Signed out.', 'info')
                  }}
                  className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl w-20 text-sm font-medium text-slate-400 ring-1 ring-slate-600/40 transition-colors duration-200 hover:bg-slate-800/90 hover:text-slate-100 hover:ring-slate-500/55 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400/50"
                  title="End session and sign out"
                >
                  Sign out
                </button>
              )}
              {isConnected && (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="inline-flex h-10 min-w-[4.5rem] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-slate-500/55 bg-slate-800/80 px-3.5 text-sm font-semibold text-slate-100 shadow-sm transition-all duration-200 hover:border-orange-500/45 hover:bg-slate-700/90 hover:text-white active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-400/45 group"
                  title="Leave conversation"
                >
                  <svg className="h-4 w-4 shrink-0 transition-transform duration-200 group-hover:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="hidden sm:inline">Leave</span>
                </button>
              )}
              {showCancelQueue && (
                <button
                  type="button"
                  onClick={handleCancelSearch}
                  className="inline-flex h-10 shrink-30 items-center justify-center gap-2 rounded-xl border px-5 min-w-30 border-amber-400/45 bg-amber-500/15 px-3.5 text-sm font-semibold text-amber-50 transition-all duration-200 hover:border-amber-400/60 hover:bg-amber-500/25 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400/50"
                  title={consentRole === 'requester' ? 'Cancel chat request' : 'Leave queue and stop searching'}
                >
                  <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  <span className="whitespace-nowrap">Leave queue</span>
                </button>
              )}
              {showFindMatch && (
                <button
                  type="button"
                  onClick={handleFindMatch}
                  disabled={!isAuthenticated}
                  className="inline-flex h-10 min-w-[7.5rem] shrink-0 items-center justify-center gap-2 rounded-xl border border-indigo-400/35 bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-600 px-3.5 text-sm font-semibold text-white shadow-md shadow-indigo-950/40 transition-all duration-200 hover:brightness-110 hover:shadow-lg active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300/60"
                >
                  <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span className="whitespace-nowrap">Find Match</span>
                </button>
              )}
              <button
                type="button"
                onClick={openTrainingModalManual}
                className="inline-flex h-10 min-w-[5.25rem] shrink-0 items-center justify-center gap-2 rounded-xl border border-fuchsia-400/35 bg-gradient-to-r from-fuchsia-500 via-pink-500 to-rose-600 px-3.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-950/35 transition-all duration-200 hover:brightness-110 hover:shadow-xl active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fuchsia-300/60"
                title="Open training — or hover a match’s message and tap Train"
              >
                <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
                <span className="hidden whitespace-nowrap sm:inline">Train</span>
              </button>
            </div>
          </div>
        </div>

        {/* Chat Messages */}
        <div
          className={`chat-shell-body chat-messages-scroll flex flex-1 flex-col gap-5 overflow-y-auto md:gap-6 transition-colors duration-300 min-h-0 ${
          isConnected 
              ? 'bg-gradient-to-b from-emerald-950/15 via-slate-950/50 to-slate-950'
              : 'bg-gradient-to-b from-slate-900/40 to-slate-950'
          }${harassmentWarnings.size > 0 ? ' chat-has-moderation' : ''}`}
        >
          {chatHistory.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center min-h-[240px] text-center px-2">
              {consentRole ? (
                <p className="text-sm text-slate-500 max-w-md">
                  Respond to the connection prompt above to continue.
                </p>
              ) : isConnected ? (
                <div className="empty-panel-stack empty-panel-stack--connected animate-fade-in">
                  <div className="empty-panel-stack__icon">
                    <div className="relative">
                      <div className="w-[5.25rem] h-[5.25rem] rounded-2xl bg-gradient-to-br from-emerald-500/30 to-teal-700/35 flex items-center justify-center border border-emerald-400/40 shadow-lg shadow-emerald-950/40">
                        <svg className="w-11 h-11 text-emerald-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                    </div>
                      <div className="absolute -top-0.5 -right-0.5 w-6 h-6 bg-emerald-500 rounded-lg flex items-center justify-center border-2 border-slate-900 shadow-md">
                        <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                    </div>
                  </div>
                  </div>
                  <h3 className="empty-panel-stack__title text-xl sm:text-2xl font-bold bg-gradient-to-r from-emerald-200 via-teal-100 to-cyan-100 bg-clip-text text-transparent">
                    {partnerDisplayName ? `Connected with ${partnerDisplayName}` : "You're connected"}
                  </h3>
                  <p className="empty-panel-stack__body">
                    Say hello below—every message is scanned by AI moderation to keep the conversation respectful.
                  </p>
                  <div className="empty-panel-stack__footer inline-flex items-center gap-2 text-xs font-medium text-emerald-100/95 bg-emerald-950/50 border border-emerald-400/25 rounded-full px-3.5 py-4">
                    <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <span>AI-moderated · Safer chat</span>
                  </div>
                </div>
              ) : isWaiting ? (
                <div className="empty-panel-stack animate-fade-in">
                  <div className="empty-panel-stack__icon">
                    <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-600/25 flex items-center justify-center border border-amber-400/35 animate-pulse">
                      <svg className="w-10 h-10 text-amber-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                  </div>
                  <h3 className="empty-panel-stack__title text-lg sm:text-xl">Finding someone…</h3>
                  <p className="empty-panel-stack__body text-slate-400">
                    Hang tight—we will connect you with another user. You can leave the queue anytime.
                  </p>
                </div>
              ) : (
                <div className="empty-panel-stack animate-fade-in">
                  <div className="empty-panel-stack__icon">
                    <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500/25 to-violet-700/35 flex items-center justify-center border border-indigo-400/35 shadow-md shadow-indigo-950/30">
                      <svg className="w-10 h-10 text-indigo-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </div>
                  </div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-indigo-300/90">Ready</p>
                  <h3 className="empty-panel-stack__title text-lg sm:text-xl">You are in, {myDisplayName}</h3>
                  <p className="empty-panel-stack__body">
                    Message the AI in the box below, or tap <span className="text-indigo-300 font-semibold">Find Match</span> to meet
                    someone—they must accept before you chat together.
                  </p>
                </div>
              )}
            </div>
          )}
          {chatHistory.map((chat, index) => {
            const warning = harassmentWarnings.get(chat.id)
            const isEditing = editingMessageId === chat.id
            const modSecLeft = warning ? getModerationSecondsLeft(warning) : 0
            const modReason = (warning && (warning.reason || '').trim()) || 'Matched our safety checks.'
            const isModExpanded = warning && warning.expanded !== false

            return (
              <div
                key={chat.id || index}
                ref={index === chatHistory.length - 1 ? messagesEndRef : undefined}
                className="group px-1 sm:px-2"
              >
                {warning && isModExpanded && (
                  <div
                    className="moderation-notice"
                    role="status"
                    aria-live="polite"
                    aria-label={`Moderation notice, ${modSecLeft} seconds left to edit`}
                  >
                    <div className="moderation-notice__inner">
                      <div className="moderation-notice__row">
                        <button
                          type="button"
                          className="moderation-notice__info moderation-tip"
                          aria-label="Why this was flagged"
                          title={modReason}
                        >
                          <span className="moderation-tip__icon-wrap" aria-hidden>
                            <svg className="moderation-tip__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </span>
                          <span className="moderation-tip__bubble" role="tooltip">
                            {modReason}
                          </span>
                        </button>
                        <div className="moderation-notice__body">
                          <p className="moderation-notice__eyebrow">Guidelines</p>
                          <p className="moderation-notice__title">Your message may violate guidelines</p>
                          <p className="moderation-notice__hint">
                            Edit now if this was a mistake — otherwise it may be removed automatically.
                          </p>
                        </div>
                        <span
                          className="moderation-notice__timer tabular-nums"
                          aria-label={`${modSecLeft} seconds remaining`}
                        >
                          {modSecLeft}s
                        </span>
                      </div>
                      <div className="moderation-notice__actions">
                        <button
                          type="button"
                          className="moderation-notice__btn moderation-notice__btn--ghost"
                          onClick={() => collapseModerationNotice(chat.id)}
                        >
                          Dismiss
                        </button>
                        {chat.sender === 'user' && isConnected && (
                          <button
                            type="button"
                            className="moderation-notice__btn moderation-notice__btn--train"
                            onClick={() => openTrainingFromFlaggedOwnMessage(chat)}
                          >
                            Train
                          </button>
                        )}
                        {chat.sender === 'user' && !isEditing && (
                          <button
                            type="button"
                            className="moderation-notice__btn moderation-notice__btn--primary"
                            onClick={() => handleEditMessage(chat.id, chat.text)}
                          >
                            Edit message
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {warning && !isModExpanded && (
                  <div
                    className="moderation-notice moderation-notice--compact"
                    role="status"
                    aria-live="polite"
                  >
                    <button
                      type="button"
                      className="moderation-notice__info moderation-tip moderation-notice--compact__tip"
                      aria-label="Why this was flagged"
                      title={modReason}
                    >
                      <span className="moderation-tip__icon-wrap" aria-hidden>
                        <svg className="moderation-tip__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </span>
                      <span className="moderation-tip__bubble" role="tooltip">
                        {modReason}
                      </span>
                    </button>
                    <p className="moderation-notice--compact__text">
                      Guidelines review
                      <span className="moderation-notice--compact__dot" aria-hidden>
                        ·
                      </span>
                      <span className="tabular-nums">{modSecLeft}s</span>
                    </p>
                    <div className="moderation-notice--compact__actions">
                      {chat.sender === 'user' && isConnected && (
                        <button
                          type="button"
                          className="moderation-notice__btn moderation-notice__btn--train moderation-notice__btn--sm"
                          onClick={() => openTrainingFromFlaggedOwnMessage(chat)}
                        >
                          Train
                        </button>
                      )}
                      {chat.sender === 'user' && !isEditing && (
                        <button
                          type="button"
                          className="moderation-notice__btn moderation-notice__btn--primary moderation-notice__btn--sm"
                          onClick={() => handleEditMessage(chat.id, chat.text)}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        className="moderation-notice__btn moderation-notice__btn--ghost moderation-notice__btn--sm"
                        onClick={() => expandModerationNotice(chat.id)}
                      >
                        Details
                      </button>
                    </div>
                  </div>
                )}
                <div
                  className={`flex ${chat.sender === 'user' ? 'justify-end' : 'justify-start'}${warning ? ' chat-message-row--below-moderation' : ''}`}
                >
                  <div
                    className={`flex items-end gap-3 sm:gap-3.5 max-w-[min(92%,42rem)] min-w-0 ${
                    chat.sender === 'user' ? 'flex-row-reverse' : 'flex-row'
                    }`}
                  >
                    <div
                      className={`msg-avatar w-11 h-11 rounded-2xl flex items-center justify-center text-[0.9375rem] font-bold shrink-0 shadow-lg border border-white/15 ${
                      chat.sender === 'user' 
                          ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white'
                        : chat.sender === 'partner'
                            ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white'
                            : 'bg-gradient-to-br from-violet-500 to-purple-700 text-white'
                      }`}
                      aria-hidden
                    >
                      {getAvatarInitial(chat.sender)}
                    </div>
                    <div className="flex flex-col min-w-0 max-w-full">
                      {isEditing ? (
                        <div className="message-edit-panel max-w-full">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={handleEditComposerKeyDown}
                            className="message-edit-panel__textarea"
                            rows={3}
                            autoFocus
                          />
                          <div className="message-edit-panel__actions">
                            <button
                              type="button"
                              onClick={handleCancelEdit}
                              className="message-edit-panel__btn message-edit-panel__btn--cancel"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={handleSaveEdit}
                              className="message-edit-panel__btn message-edit-panel__btn--save"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="train-bubble-wrap relative w-fit max-w-full">
                        <div
                            className={`msg-bubble shadow-md w-fit max-w-full rounded-2xl ${
                            chat.sender === 'user'
                                ? 'bg-gradient-to-br from-blue-600 to-indigo-700 text-white rounded-br-md'
                              : chat.sender === 'partner'
                                  ? 'bg-gradient-to-br from-emerald-600 to-teal-700 text-white rounded-bl-md'
                                  : 'bg-gradient-to-br from-slate-700 to-slate-800 text-slate-100 rounded-bl-md border border-slate-600/40'
                            } ${chat.pendingModeration ? 'opacity-65 animate-pulse' : ''}`}
                        >
                          {chat.pendingModeration && (
                              <div
                                className="moderation-pending-inline flex items-center gap-2.5 text-xs font-medium text-white/95 bg-white/10 rounded-lg px-3 py-2.5 -mx-0.5 mb-1.5 border border-white/15"
                                title="Message is being checked for safety"
                              >
                                <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              <span>Safety check…</span>
                            </div>
                          )}
                            <p className="msg-bubble__text text-left text-[0.9375rem] sm:text-base break-words leading-relaxed min-w-0">
                              {chat.text}
                            </p>
                            <div
                              className={`msg-bubble__meta text-xs flex items-center gap-1.5 tabular-nums ${
                                chat.sender === 'user'
                                  ? 'text-blue-100/85 justify-end'
                                  : chat.sender === 'partner'
                                    ? 'text-emerald-100/80 justify-start'
                                    : 'text-slate-400 justify-start'
                              }`}
                            >
                              <time dateTime={chat.timestamp instanceof Date ? chat.timestamp.toISOString() : undefined}>
                                {formatTime(chat.timestamp)}
                              </time>
                            {chat.sender === 'user' && (
                                <svg className="w-3.5 h-3.5 shrink-0 opacity-80" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                        </div>
                          {isConnected && chat.sender === 'partner' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                openTrainingFromPartnerMessage(chat)
                              }}
                              className="train-on-message-btn pointer-events-auto absolute -top-2 -right-2 z-10 flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-fuchsia-600 to-pink-600 px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white shadow-lg shadow-fuchsia-950/50 ring-2 ring-slate-900/80 hover:from-fuchsia-500 hover:to-pink-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fuchsia-400"
                              title="Teach moderation using this message from your match"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                              </svg>
                              Train
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Message Input */}
        <div className="shrink-0 border-t border-slate-700/50 bg-slate-900/75 backdrop-blur-md">
          <div className="chat-composer-inner">
            <div className="chat-input-shell relative">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleMainComposerKeyDown}
                placeholder={
                  consentRole
                    ? 'Accept or decline the request to continue…'
                    : isWaiting
                      ? 'Waiting for a match…'
                      : isConnected
                        ? 'Message your partner…'
                        : 'Chat with the AI or find a human match…'
                }
                className="chat-textarea resize-none rounded-xl bg-slate-800/80 border border-slate-600/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/45 focus:border-indigo-400/50 placeholder-slate-500 text-slate-100 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
                rows={1}
                disabled={isWaiting || !!consentRole || !socket?.connected}
              />
              {message.length > 0 && (
                <div
                  className="pointer-events-none absolute right-2.5 bottom-2 text-[11px] tabular-nums font-medium text-slate-500"
                  aria-hidden
                >
                  {message.length}
              </div>
              )}
            </div>
            <button
              onClick={handleSend}
              disabled={!message.trim() || isWaiting || !!consentRole || !socket?.connected}
              className="chat-send-btn px-5 sm:px-6 bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-semibold rounded-xl hover:from-indigo-500 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20 disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:shadow-none inline-flex items-center justify-center gap-2 min-w-[104px] border-0 cursor-pointer"
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
        <div
          className="training-modal-backdrop fixed inset-0 z-[90] flex items-end justify-center overflow-y-auto sm:items-center sm:p-6 md:p-8 animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="training-modal-title"
        >
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md" aria-hidden onClick={closeTrainingModal} />
          <div className="training-modal-card training-modal-card--lg relative z-[1] mt-auto w-full max-h-[min(92vh,640px)] max-w-lg animate-scale-in overflow-y-auto sm:mt-0 sm:max-h-[min(90vh,680px)]">
            <div className="training-modal__stack">
              <header className="training-modal__header flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3.5">
                  <div className="training-modal__icon flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-600 to-pink-600 shadow-lg ring-1 ring-white/10 sm:h-12 sm:w-12 sm:rounded-2xl">
                    <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </div>
                  <div className="min-w-0 pt-0.5">
                    <p className="training-modal__eyebrow text-xs font-semibold uppercase tracking-wider text-violet-200">
                      Moderation
                    </p>
                    <h2 id="training-modal-title" className="text-lg font-bold leading-snug tracking-tight text-white sm:text-xl">
                      Train safety checker
                    </h2>
                  </div>
              </div>
              <button
                  type="button"
                  onClick={closeTrainingModal}
                  className="training-modal__close -mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
                  aria-label="Close"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              </header>

              {trainingMeta?.source === 'partner_message' ? (
                <div className="training-modal__callout training-modal__callout--partner text-sm sm:text-[0.9375rem]">
                  <span className="font-semibold text-fuchsia-100">From your chat with {trainingMeta.partnerDisplayName}.</span>{' '}
                  Your label is saved as a real example so moderation can treat similar lines more consistently.
                </div>
              ) : trainingMeta?.source === 'flagged_own' ? (
                <div className="training-modal__callout training-modal__callout--flagged text-sm sm:text-[0.9375rem]">
                  <span className="font-semibold text-amber-100">Moderation held this message.</span>{' '}
                  Label it (harassment or OK) so similar lines are handled consistently for this chat session only.
                </div>
              ) : (
                <p className="training-modal__lede text-sm leading-relaxed text-slate-200 sm:text-[0.9375rem]">
                  Add a sample message and label it. Examples you submit are added to the live moderation prompt so checks can follow your standards.
                </p>
              )}

              <div className="training-modal__field">
                <label htmlFor="training-example-text" className="training-modal__label">
                  Message text
                </label>
              <textarea
                  id="training-example-text"
                value={trainingMessage}
                onChange={(e) => setTrainingMessage(e.target.value)}
                  placeholder="Paste or type the message to label…"
                  className="training-modal__textarea"
                  rows={5}
              />
            </div>

              <fieldset className="training-modal__fieldset">
                <legend className="training-modal__legend">Does this qualify as harassment or abuse?</legend>
                <div className="training-modal__radio-grid">
                  <label className={`training-choice training-choice--yes${trainingIsHarassment === true ? ' training-choice--selected' : ''}`}>
                  <input
                    type="radio"
                      name="training-harass"
                    checked={trainingIsHarassment === true}
                    onChange={() => setTrainingIsHarassment(true)}
                      className="training-choice__input"
                  />
                    <span className="training-choice__text">Yes — harmful / abusive</span>
                </label>
                  <label className={`training-choice training-choice--no${trainingIsHarassment === false ? ' training-choice--selected' : ''}`}>
                  <input
                    type="radio"
                      name="training-harass"
                    checked={trainingIsHarassment === false}
                    onChange={() => setTrainingIsHarassment(false)}
                      className="training-choice__input"
                  />
                    <span className="training-choice__text">No — acceptable</span>
                </label>
              </div>
              </fieldset>

              <footer className="training-modal__footer">
                <button type="button" onClick={closeTrainingModal} className="training-footer-btn training-footer-btn--secondary">
                Cancel
              </button>
                <button type="button" onClick={handleTrainingSubmit} className="training-footer-btn training-footer-btn--primary">
                  Save example
                </button>
              </footer>
            </div>
          </div>
        </div>
      )}
      </div>
      )}
    </>
  )
}

export default App
