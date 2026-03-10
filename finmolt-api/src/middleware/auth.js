const db = require('../config/db');
const crypto = require('crypto');

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer finmolt_')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid FinMolt API key is required' });
  }

  const token = authHeader.split(' ')[1];
  const hash = hashApiKey(token);

  try {
    const { rows } = await db.query('SELECT * FROM agents WHERE api_key_hash = $1 AND is_active = true', [hash]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = authMiddleware;
