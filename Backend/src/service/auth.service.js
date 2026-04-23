const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendOtpEmail } = require('./email.service');

const SESSION_TTL_SECONDS = Math.min(3600, Math.max(30, parseInt(process.env.SESSION_TTL_SECONDS || '600', 10)));
const OTP_TTL_MS = parseInt(process.env.OTP_TTL_MS || String(10 * 60 * 1000), 10);
const OTP_COOLDOWN_MS = parseInt(process.env.OTP_COOLDOWN_MS || String(60 * 1000), 10);
const MAX_OTP_SENDS_PER_EMAIL_WINDOW = parseInt(process.env.OTP_MAX_SENDS || '5', 10);
const WINDOW_MS = parseInt(process.env.OTP_WINDOW_MS || String(15 * 60 * 1000), 10);

/** @type {Map<string, { code: string, expiresAt: number, displayName: string }>} */
const otpByEmail = new Map();
/** @type {Map<string, number[]>} timestamps of OTP send */
const sendHistoryByEmail = new Map();

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to a strong string (16+ chars) in .env');
  }
  return 'dev-insecure-jwt-secret-min-16-chars';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isGmailAddress(email) {
  return /^[^\s@]+@gmail\.com$/i.test(email);
}

function cleanupExpiredOtps() {
  const now = Date.now();
  for (const [key, v] of otpByEmail) {
    if (v.expiresAt <= now) otpByEmail.delete(key);
  }
}

function pruneSendHistory(email) {
  const now = Date.now();
  const arr = sendHistoryByEmail.get(email) || [];
  const fresh = arr.filter((t) => now - t < WINDOW_MS);
  sendHistoryByEmail.set(email, fresh);
  return fresh;
}

async function requestOtp(emailRaw, displayNameRaw) {
  cleanupExpiredOtps();

  const email = normalizeEmail(emailRaw);
  const displayName = String(displayNameRaw || '').trim().slice(0, 40);

  if (!email || !displayName) {
    return { ok: false, status: 400, error: 'Gmail address and display name are required.' };
  }
  if (!isGmailAddress(email)) {
    return { ok: false, status: 400, error: 'Please use a valid @gmail.com address.' };
  }

  const history = pruneSendHistory(email);
  if (history.length >= MAX_OTP_SENDS_PER_EMAIL_WINDOW) {
    return { ok: false, status: 429, error: 'Too many verification emails. Try again later.' };
  }
  const last = history[history.length - 1];
  if (last && Date.now() - last < OTP_COOLDOWN_MS) {
    return { ok: false, status: 429, error: 'Please wait a minute before requesting another code.' };
  }

  const code = String(crypto.randomInt(100000, 999999));
  otpByEmail.set(email, {
    code,
    expiresAt: Date.now() + OTP_TTL_MS,
    displayName
  });
  history.push(Date.now());
  sendHistoryByEmail.set(email, history);

  try {
    await sendOtpEmail(email, displayName, code);
  } catch (e) {
    otpByEmail.delete(email);
    if (e.code === 'EMAIL_NOT_CONFIGURED') {
      return { ok: false, status: 503, error: e.message };
    }
    console.error('sendOtpEmail', e);
    return { ok: false, status: 500, error: 'Could not send email. Try again later.' };
  }

  return {
    ok: true,
    message: 'Verification code sent to your Gmail.',
    emailHint: email.replace(/(^.).*(@.*$)/, '$1***$2')
  };
}

function verifyOtpAndIssueToken(emailRaw, otpRaw) {
  cleanupExpiredOtps();
  const email = normalizeEmail(emailRaw);
  const otp = String(otpRaw || '').replace(/\s/g, '');

  if (!email || !otp) {
    return { ok: false, status: 400, error: 'Email and code are required.' };
  }

  const entry = otpByEmail.get(email);
  if (!entry || entry.expiresAt < Date.now()) {
    return { ok: false, status: 401, error: 'Invalid or expired code. Request a new one.' };
  }
  if (entry.code !== otp) {
    return { ok: false, status: 401, error: 'Incorrect code. Try again.' };
  }

  otpByEmail.delete(email);

  const secret = getJwtSecret();
  const token = jwt.sign(
    { name: entry.displayName },
    secret,
    {
      subject: email,
      expiresIn: SESSION_TTL_SECONDS
    }
  );

  return {
    ok: true,
    token,
    displayName: entry.displayName,
    email,
    expiresInSeconds: SESSION_TTL_SECONDS
  };
}

function verifySocketToken(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Missing token' };
  }
  try {
    const secret = getJwtSecret();
    const payload = jwt.verify(token, secret);
    if (typeof payload.name !== 'string' || !payload.sub) {
      return { ok: false, error: 'Invalid token payload' };
    }
    return {
      ok: true,
      email: payload.sub,
      displayName: payload.name.slice(0, 40),
      exp: payload.exp
    };
  } catch (e) {
    return { ok: false, error: e.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token' };
  }
}

module.exports = {
  requestOtp,
  verifyOtpAndIssueToken,
  verifySocketToken,
  SESSION_TTL_SECONDS
};
