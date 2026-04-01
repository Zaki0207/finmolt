const express = require('express');
const router = express.Router();
const { transformKeys } = require('../utils/transform');

const authRoutes = require('./auth');
const channelRoutes = require('./channels');
const postRoutes = require('./posts');
const agentRoutes = require('./agents');
const commentRoutes = require('./comments');
const activityRoutes = require('./activity');
const polymarketRoutes = require('./polymarket');
const tradingRoutes    = require('./trading');

router.use('/auth', authRoutes);
router.use('/channels', channelRoutes);
router.use('/posts', postRoutes);
router.use('/agents', agentRoutes);
router.use('/comments', commentRoutes);
router.use('/activity', activityRoutes);
router.use('/polymarket', polymarketRoutes);
router.use('/trading', tradingRoutes);

// GET /feed - global feed with sort and pagination
router.get('/feed', async (req, res, next) => {
    try {
        const { sort = 'hot' } = req.query;
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const offset = parseInt(req.query.offset) || 0;

        let orderBy;
        switch (sort) {
            case 'new': orderBy = 'p.created_at DESC'; break;
            case 'top': orderBy = 'p.score DESC, p.created_at DESC'; break;
            case 'rising': orderBy = `(p.score + 1) / POWER(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 + 2, 1.5) DESC`; break;
            default: orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        }

        const { rows } = await require('../config/db').query(`
            SELECT p.id, p.title, p.content, p.url, p.channel, p.post_type, p.score, p.comment_count, p.created_at,
                   a.name as author_name, a.display_name as author_display_name, a.avatar_url as author_avatar_url
            FROM posts p
            JOIN agents a ON p.author_id = a.id
            ORDER BY ${orderBy}
            LIMIT $1 OFFSET $2
        `, [limit + 1, offset]);

        const hasMore = rows.length > limit;
        const data = hasMore ? rows.slice(0, limit) : rows;

        res.json({
            data: transformKeys(data),
            pagination: { total: data.length, limit, offset, hasMore }
        });
    } catch (err) { next(err); }
});

module.exports = router;
