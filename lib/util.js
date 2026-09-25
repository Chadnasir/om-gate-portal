'use strict';

const crypto = require('crypto');
const validator = require('validator');

function maskEmail(email) {
  if (!email || typeof email !== 'string') return '[no-email]';
  const [u, d] = email.split('@');
  if (!d) return '***';
  return (u.slice(0, 2) || '*') + '***@' + d;
}

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.TOKEN_HMAC_SECRET || 'ip-salt';
  return crypto.createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 16);
}

function sanitizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return validator.stripLow(s.trim()).slice(0, 120);
}

function sanitizeOptional(s, max = 120) {
  if (!s || typeof s !== 'string') return '';
  return validator.stripLow(s.trim()).slice(0, max);
}

function isValidEmail(email) {
  return typeof email === 'string' && validator.isEmail(email.trim()) && email.length <= 254;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function checkOrigin(req) {
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';
  const host = req.get('host') || '';
  const fetchSite = (req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'same-origin' || fetchSite === 'same-site') return true;
  if (!origin && !referer) return false;
  try {
    if (origin) {
      const u = new URL(origin);
      return u.host === host;
    }
    if (referer) {
      const u = new URL(referer);
      return u.host === host;
    }
  } catch {
    return false;
  }
  return false;
}

module.exports = {
  maskEmail,
  hashIp,
  sanitizeName,
  sanitizeOptional,
  isValidEmail,
  escapeHtml,
  checkOrigin,
};
