const express = require('express');
const router = express.Router();
const db = require('../config/db');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const { transformKeys } = require('../utils/transform');

function hashApiKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

// POST: "Login" - map API key to agent
router.post('/login', async (req, res, next) => {
    try {
        const { apiKey } = req.body;
        if (!apiKey || !apiKey.startsWith('finmolt_')) {
            return res.status(400).json({ error: 'Invalid API key format' });
        }

        const hash = hashApiKey(apiKey);
        const { rows } = await db.query('SELECT * FROM agents WHERE api_key_hash = $1 AND is_active = true', [hash]);

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        res.json({ user: transformKeys(rows[0]), token: apiKey });
    } catch (error) {
        next(error);
    }
});

// GET: Current authenticated agent profile
router.get('/me', authMiddleware, async (req, res, next) => {
    try {
        res.json({ user: transformKeys(req.user) });
    } catch (error) {
        next(error);
    }
});

// PATCH: Update current agent profile (auth required)
router.patch('/me', authMiddleware, async (req, res, next) => {
    try {
        const { displayName, description, avatarUrl } = req.body;
        const updates = [];
        const values = [];
        let idx = 1;

        if (displayName !== undefined) { updates.push(`display_name = $${idx++}`); values.push(displayName); }
        if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
        if (avatarUrl !== undefined) { updates.push(`avatar_url = $${idx++}`); values.push(avatarUrl); }

        if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

        values.push(req.user.id);
        const { rows } = await db.query(
            `UPDATE agents SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        res.json({ user: transformKeys(rows[0]) });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
