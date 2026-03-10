/**
 * Rate limiting middleware
 */

const config = require('../config');
const { RateLimitError } = require('../utils/errors');

const storage = new Map();

setInterval(() => {
  const now = Date.now();
  const cutoff = now - 3600000;

  for (const [key, entries] of storage.entries()) {
    const filtered = entries.filter(e => e.timestamp >= cutoff);
    if (filtered.length === 0) {
      storage.delete(key);
    } else {
      storage.set(key, filtered);
    }
  }
}, 300000);

function getKey(req, limitType) {
  const identifier = req.token || req.ip || 'anonymous';
  return `rl:${limitType}:${identifier}`;
}

function checkLimit(key, limit) {
  const now = Date.now();
  const windowStart = now - (limit.window * 1000);

  let entries = storage.get(key) || [];
  entries = entries.filter(e => e.timestamp >= windowStart);

  const count = entries.length;
  const allowed = count < limit.max;
  const remaining = Math.max(0, limit.max - count - (allowed ? 1 : 0));

  let resetAt;
  let retryAfter = 0;

  if (entries.length > 0) {
    const oldest = Math.min(...entries.map(e => e.timestamp));
    resetAt = new Date(oldest + (limit.window * 1000));
    retryAfter = Math.ceil((resetAt.getTime() - now) / 1000);
  } else {
    resetAt = new Date(now + (limit.window * 1000));
  }

  if (allowed) {
    entries.push({ timestamp: now });
    storage.set(key, entries);
  }

  return {
    allowed,
    remaining,
    limit: limit.max,
    resetAt,
    retryAfter: allowed ? 0 : retryAfter
  };
}

function rateLimit(limitType = 'requests', options = {}) {
  const limit = config.rateLimits[limitType];

  if (!limit) {
    throw new Error(`Unknown rate limit type: ${limitType}`);
  }

  const {
    skip = () => false,
    keyGenerator = (req) => getKey(req, limitType),
    message = `Rate limit exceeded`
  } = options;

  return async (req, res, next) => {
    try {
      if (await Promise.resolve(skip(req))) {
        return next();
      }

      const key = await Promise.resolve(keyGenerator(req));
      const result = checkLimit(key, limit);

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.floor(result.resetAt.getTime() / 1000));

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter);
        throw new RateLimitError(message, result.retryAfter);
      }

      req.rateLimit = result;

      next();
    } catch (error) {
      next(error);
    }
  };
}

const requestLimiter = rateLimit('requests');
const postLimiter = rateLimit('posts', { message: 'You can only post once every 30 minutes' });
const commentLimiter = rateLimit('comments', { message: 'Too many comments, slow down' });

module.exports = {
  rateLimit,
  requestLimiter,
  postLimiter,
  commentLimiter
};
