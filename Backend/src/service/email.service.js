const nodemailer = require('nodemailer');

function getTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

async function sendOtpEmail(toAddress, displayName, code) {
  const transport = getTransport();
  if (!transport) {
    const err = new Error('Email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }

  const from = process.env.GMAIL_USER;
  const subject = 'APCS  Safe Chat — your verification code';
  const text = `Hi ${displayName},

Your one-time code is: ${code}

It expires in 10 minutes. If you did not request this, ignore this email.

— APCS  Chatbot`;

  const html = `
    <p>Hi <strong>${escapeHtml(displayName)}</strong>,</p>
    <p>Your one-time code is:</p>
    <p style="font-size:1.5rem;font-weight:700;letter-spacing:0.2em;">${escapeHtml(code)}</p>
    <p style="color:#555;">It expires in 10 minutes. If you did not request this, ignore this email.</p>
    <p>— APCS  Chatbot</p>
  `;

  await transport.sendMail({
    from: `"APCS  Chat" <${from}>`,
    to: toAddress,
    subject,
    text,
    html
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendOtpEmail, getTransport };
