'use strict';

const crypto = require('crypto');

function hmacSecret() {
  const s = process.env.TOKEN_HMAC_SECRET;
  if (!s || s.length < 32) throw new Error('TOKEN_HMAC_SECRET must be >= 32 chars');
  return s;
}

function ttlHours() {
  const n = parseInt(process.env.TOKEN_TTL_HOURS || '72', 10);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

function issueToken({ listingId, leadId, email, ttlHoursOverride }) {
  const hours = ttlHoursOverride != null ? ttlHoursOverride : ttlHours();
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = {
    v: 1,
    lid: listingId,
    leadId,
    email: String(email).toLowerCase().trim(),
    exp,
    nonce,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', hmacSecret()).update(body).digest('base64url');
  return { token: `${body}.${sig}`, exp, nonce };
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', hmacSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || !payload.lid || !payload.email || !payload.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = { issueToken, verifyToken, ttlHours };
