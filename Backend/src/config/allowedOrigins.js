'use strict';

/**
 * Origins allowed for Express CORS and Socket.IO.
 * Production: set ALLOWED_ORIGINS (comma-separated) and/or FRONTEND_URL on Render.
 * Trailing slashes are stripped. Local Vite defaults are always included.
 */
function parseOriginsFromEnv() {
  const raw = process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function getAllowedOrigins() {
  const devDefaults = ['http://localhost:5173', 'http://localhost:5174'];
  return Array.from(new Set([...devDefaults, ...parseOriginsFromEnv()]));
}

function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  const normalized = origin.replace(/\/$/, '');
  return getAllowedOrigins().includes(normalized);
}

module.exports = { getAllowedOrigins, isAllowedOrigin };
