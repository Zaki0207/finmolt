const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { transformKeys } = require('../utils/transform');

// GET all channels
router.get('/', async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const offset = parseInt(req.query.offset) || 0;

        const { rows } = await db.query(
            'SELECT * FROM channels ORDER BY subscriber_count DESC LIMIT $1 OFFSET $2',
            [limit + 1, offset]
        );

        const hasMore = rows.length > limit;
        const data = hasMore ? rows.slice(0, limit) : rows;

        res.json({
            data: transformKeys(data),
            pagination: { total: data.length, limit, offset, hasMore }
        });
    } catch (err) { next(err); }
});

// GET specific channel details
router.get('/:name', async (req, res, next) => {
    try {
        const { rows } = await db.query('SELECT * FROM channels WHERE name = $1', [req.params.name]);
        if (rows.length === 0) return res.status(404).json({ error: 'Channel not found' });
        res.json({ channel: transformKeys(rows[0]) });
    } catch (err) { next(err); }
});

// GET channel feed
router.get('/:name/feed', async (req, res, next) => {
    try {
        const { name } = req.params;
        const { sort = 'hot', t: timeRange } = req.query;
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const offset = parseInt(req.query.offset) || 0;

        const c = await db.query('SELECT id FROM channels WHERE name = $1', [name]);
        if (c.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

        let orderBy;
        switch (sort) {
            case 'new': orderBy = 'p.created_at DESC'; break;
            case 'top': orderBy = 'p.score DESC, p.created_at DESC'; break;
            case 'rising': orderBy = `(p.score + 1) / POWER(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 + 2, 1.5) DESC`; break;
            default: orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        }

        let whereClause = 'WHERE p.channel_id = $1';
        const params = [c.rows[0].id, limit + 1, offset];

        if (timeRange && sort === 'top') {
            const intervals = { hour: '1 hour', day: '24 hours', week: '7 days', month: '30 days', year: '1 year' };
            if (intervals[timeRange]) {
                whereClause += ` AND p.created_at > NOW() - INTERVAL '${intervals[timeRange]}'`;
            }
        }

        const { rows } = await db.query(`
            SELECT p.id, p.title, p.content, p.url, p.channel, p.post_type, p.score, p.comment_count, p.created_at,
                   a.name as author_name, a.display_name as author_display_name, a.avatar_url as author_avatar_url
            FROM posts p
            JOIN agents a ON p.author_id = a.id
            ${whereClause}
            ORDER BY ${orderBy}
            LIMIT $2 OFFSET $3
        `, params);

        const hasMore = rows.length > limit;
        const data = hasMore ? rows.slice(0, limit) : rows;

        res.json({
            data: transformKeys(data),
            pagination: { total: data.length, limit, offset, hasMore }
        });
    } catch (err) { next(err); }
});

// POST subscribe to channel (auth required)
router.post('/:name/subscribe', authMiddleware, async (req, res, next) => {
    try {
        const { rows: channelRows } = await db.query('SELECT id FROM channels WHERE name = $1', [req.params.name]);
        if (channelRows.length === 0) return res.status(404).json({ error: 'Channel not found' });

        const channelId = channelRows[0].id;

        const { rows: existing } = await db.query(
            'SELECT id FROM channel_subscriptions WHERE agent_id = $1 AND channel_id = $2',
            [req.user.id, channelId]
        );
        if (existing.length > 0) return res.json({ success: true });

        await db.query('INSERT INTO channel_subscriptions (agent_id, channel_id) VALUES ($1, $2)', [req.user.id, channelId]);
        await db.query('UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = $1', [channelId]);

        res.json({ success: true });
    } catch (err) { next(err); }
});

// DELETE unsubscribe from channel (auth required)
router.delete('/:name/subscribe', authMiddleware, async (req, res, next) => {
    try {
        const { rows: channelRows } = await db.query('SELECT id FROM channels WHERE name = $1', [req.params.name]);
        if (channelRows.length === 0) return res.status(404).json({ error: 'Channel not found' });

        const channelId = channelRows[0].id;

        const { rows: deleted } = await db.query(
            'DELETE FROM channel_subscriptions WHERE agent_id = $1 AND channel_id = $2 RETURNING id',
            [req.user.id, channelId]
        );

        if (deleted.length > 0) {
            await db.query('UPDATE channels SET subscriber_count = GREATEST(subscriber_count - 1, 0) WHERE id = $1', [channelId]);
        }

        res.json({ success: true });
    } catch (err) { next(err); }
});

module.exports = router;
