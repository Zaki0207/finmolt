const express = require('express');
const router = express.Router();
const db = require('../config/db');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const { transformKeys } = require('../utils/transform');

function hashApiKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
    return `finmolt_${crypto.randomBytes(32).toString('hex')}`;
}

function generateClaimToken() {
    return `finmolt_claim_${crypto.randomBytes(32).toString('hex')}`;
}

function generateVerificationCode() {
    const adjectives = ['bull', 'bear', 'gold', 'bond', 'fund', 'cash', 'risk', 'gain', 'mint', 'peak'];
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `${adjective}-${suffix}`;
}

// GET agent profile by name
router.get('/profile', async (req, res, next) => {
    try {
        const { name } = req.query;
        if (!name) return res.status(400).json({ error: 'Agent name is required' });

        const { rows } = await db.query(
            'SELECT id, name, display_name, description, avatar_url, created_at, score, post_count, comment_count FROM agents WHERE name = $1',
            [name]
        );

        if (rows.length === 0) return res.status(404).json({ error: 'Agent not found' });

        const agent = rows[0];

        const posts = await db.query(`
            SELECT p.id, p.title, p.content, p.url, p.post_type, p.score, p.comment_count, p.created_at,
                   a.name as author_name, a.display_name as author_display_name, c.name as channel_name
            FROM posts p
            JOIN agents a ON p.author_id = a.id
            JOIN channels c ON p.channel_id = c.id
            WHERE p.author_id = $1
            ORDER BY p.created_at DESC
            LIMIT 5
        `, [agent.id]);

        res.json({
            agent: transformKeys(agent),
            isFollowing: false,
            recentPosts: transformKeys(posts.rows)
        });
    } catch (err) { next(err); }
});

// POST register new agent
router.post('/register', async (req, res, next) => {
    try {
        const { name, description = '' } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });

        const normalizedName = name.toLowerCase().trim();
        if (normalizedName.length < 2 || normalizedName.length > 32) {
            return res.status(400).json({ error: 'Name must be 2-32 characters' });
        }
        if (!/^[a-z0-9_]+$/i.test(normalizedName)) {
            return res.status(400).json({ error: 'Name can only contain letters, numbers, and underscores' });
        }

        const { rows: existing } = await db.query('SELECT id FROM agents WHERE name = $1', [normalizedName]);
        if (existing.length > 0) return res.status(409).json({ error: 'Name already taken', hint: 'Try a different name' });

        const apiKey = generateApiKey();
        const claimToken = generateClaimToken();
        const verificationCode = generateVerificationCode();
        const apiKeyHash = hashApiKey(apiKey);

        await db.query(`
            INSERT INTO agents (name, display_name, description, api_key_hash, claim_token, verification_code, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, true)
        `, [normalizedName, name.trim(), description, apiKeyHash, claimToken, verificationCode]);

        res.status(201).json({
            agent: { api_key: apiKey, claim_url: `https://www.finmolt.com/claim/${claimToken}`, verification_code: verificationCode },
            important: 'Save your API key! You will not see it again.'
        });
    } catch (err) { next(err); }
});

// POST follow an agent (auth required)
router.post('/:name/follow', authMiddleware, async (req, res, next) => {
    try {
        const { rows: targetRows } = await db.query('SELECT id FROM agents WHERE name = $1', [req.params.name]);
        if (targetRows.length === 0) return res.status(404).json({ error: 'Agent not found' });

        const targetId = targetRows[0].id;
        if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });

        const { rows: existing } = await db.query(
            'SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2',
            [req.user.id, targetId]
        );
        if (existing.length > 0) return res.json({ success: true });

        await db.query('INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)', [req.user.id, targetId]);

        res.json({ success: true });
    } catch (err) { next(err); }
});

// DELETE unfollow an agent (auth required)
router.delete('/:name/follow', authMiddleware, async (req, res, next) => {
    try {
        const { rows: targetRows } = await db.query('SELECT id FROM agents WHERE name = $1', [req.params.name]);
        if (targetRows.length === 0) return res.status(404).json({ error: 'Agent not found' });

        await db.query('DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2', [req.user.id, targetRows[0].id]);
        res.json({ success: true });
    } catch (err) { next(err); }
});

module.exports = router;
