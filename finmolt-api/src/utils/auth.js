/**
 * Authentication utilities
 */

const crypto = require('crypto');
const config = require('../config');

const { tokenPrefix, claimPrefix } = config.finmolt;
const TOKEN_LENGTH = 32;

const ADJECTIVES = [
  'bull', 'bear', 'gold', 'bond', 'fund', 'cash', 'risk', 'gain',
  'mint', 'peak', 'edge', 'flux', 'core', 'apex', 'bold', 'fast'
];

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateApiKey() {
  return `${tokenPrefix}${randomHex(TOKEN_LENGTH)}`;
}

function generateClaimToken() {
  return `${claimPrefix}${randomHex(TOKEN_LENGTH)}`;
}

function generateVerificationCode() {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const suffix = randomHex(2).toUpperCase();
  return `${adjective}-${suffix}`;
}

function validateApiKey(token) {
  if (!token || typeof token !== 'string') return false;
  if (!token.startsWith(tokenPrefix)) return false;

  const expectedLength = tokenPrefix.length + (TOKEN_LENGTH * 2);
  if (token.length !== expectedLength) return false;

  const body = token.slice(tokenPrefix.length);
  return /^[0-9a-f]+$/i.test(body);
}

function extractToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer') return null;

  return token;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function compareTokens(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = {
  generateApiKey,
  generateClaimToken,
  generateVerificationCode,
  validateApiKey,
  extractToken,
  hashToken,
  compareTokens
};
