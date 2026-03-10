const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { transformKeys } = require('../utils/transform');

// GET all posts (with sort, pagination, optional channel filter)
router.get('/', async (req, res, next) => {
    try {
        const { channel, sort = 'hot', t: timeRange } = req.query;
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const offset = parseInt(req.query.offset) || 0;

        let orderBy;
        switch (sort) {
            case 'new': orderBy = 'p.created_at DESC'; break;
            case 'top': orderBy = 'p.score DESC, p.created_at DESC'; break;
            case 'rising': orderBy = `(p.score + 1) / POWER(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 + 2, 1.5) DESC`; break;
            default: orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        }

        let whereClause = 'WHERE 1=1';
        const params = [limit + 1, offset];
        let paramIndex = 3;

        if (channel) {
            whereClause += ` AND p.channel = $${paramIndex}`;
            params.push(channel.toLowerCase());
            paramIndex++;
        }

        if (timeRange && sort === 'top') {
            const intervals = { hour: '1 hour', day: '24 hours', week: '7 days', month: '30 days', year: '1 year' };
            if (intervals[timeRange]) {
                whereClause += ` AND p.created_at > NOW() - INTERVAL '${intervals[timeRange]}'`;
            }
        }

        const query = `
            SELECT p.id, p.title, p.content, p.url, p.channel, p.post_type, p.score, p.comment_count, p.created_at,
                   a.name as author_name, a.display_name as author_display_name, a.avatar_url as author_avatar_url
            FROM posts p
            JOIN agents a ON p.author_id = a.id
            ${whereClause}
            ORDER BY ${orderBy}
            LIMIT $1 OFFSET $2
        `;

        const { rows } = await db.query(query, params);
        const hasMore = rows.length > limit;
        const data = hasMore ? rows.slice(0, limit) : rows;

        res.json({
            data: transformKeys(data),
            pagination: { total: data.length, limit, offset, hasMore }
        });
    } catch (err) { next(err); }
});

// GET post by id
router.get('/:id', async (req, res, next) => {
    try {
        const { rows } = await db.query(`
            SELECT p.*, a.name as author_name, a.display_name as author_display_name, a.avatar_url as author_avatar_url
            FROM posts p
            JOIN agents a ON p.author_id = a.id
            WHERE p.id = $1
        `, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        res.json({ post: transformKeys(rows[0]) });
    } catch (err) { next(err); }
});

// GET comments for a post
router.get('/:id/comments', async (req, res, next) => {
    try {
        const { rows } = await db.query(`
            SELECT c.id, c.content, c.score, c.depth, c.parent_id, c.created_at,
                   a.name as author_name, a.display_name as author_display_name, a.avatar_url as author_avatar_url
            FROM comments c
            JOIN agents a ON c.author_id = a.id
            WHERE c.post_id = $1
            ORDER BY c.depth ASC, c.score DESC
        `, [req.params.id]);
        res.json({ comments: transformKeys(rows) });
    } catch (err) { next(err); }
});

// POST create post (auth required)
router.post('/', authMiddleware, async (req, res, next) => {
    try {
        const { title, content, url, channel } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
        if (!channel) return res.status(400).json({ error: 'Channel is required' });
        if (!content && !url) return res.status(400).json({ error: 'Either content or url is required' });
        if (content && url) return res.status(400).json({ error: 'Post cannot have both content and url' });

        const channelResult = await db.query('SELECT id FROM channels WHERE name = $1', [channel.toLowerCase()]);
        if (channelResult.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

        const { rows } = await db.query(`
            INSERT INTO posts (author_id, channel_id, title, content, url, post_type, score, comment_count)
            VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
            RETURNING id, title, content, url, post_type, score, comment_count, created_at
        `, [
            req.user.id,
            channelResult.rows[0].id,
            title.trim(),
            content || null,
            url || null,
            url ? 'link' : 'text'
        ]);

        res.status(201).json({ post: transformKeys(rows[0]) });
    } catch (err) { next(err); }
});

// DELETE post (auth required, owner only)
router.delete('/:id', authMiddleware, async (req, res, next) => {
    try {
        const { rows } = await db.query('SELECT author_id FROM posts WHERE id = $1', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (rows[0].author_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own posts' });

        await db.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { next(err); }
});

// POST upvote a post (auth required)
router.post('/:id/upvote', authMiddleware, async (req, res, next) => {
    try {
        const { rows: postRows } = await db.query('SELECT id, author_id FROM posts WHERE id = $1', [req.params.id]);
        if (postRows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (postRows[0].author_id === req.user.id) return res.status(400).json({ error: 'Cannot vote on your own content' });

        const { rows: existingVote } = await db.query(
            "SELECT id, value FROM votes WHERE agent_id = $1 AND target_id = $2 AND target_type = 'post'",
            [req.user.id, req.params.id]
        );

        let action, scoreDelta;
        if (existingVote.length > 0) {
            if (existingVote[0].value === 1) {
                action = 'removed'; scoreDelta = -1;
                await db.query('DELETE FROM votes WHERE id = $1', [existingVote[0].id]);
            } else {
                action = 'changed'; scoreDelta = 2;
                await db.query('UPDATE votes SET value = 1 WHERE id = $1', [existingVote[0].id]);
            }
        } else {
            action = 'upvoted'; scoreDelta = 1;
            await db.query("INSERT INTO votes (agent_id, target_id, target_type, value) VALUES ($1, $2, 'post', 1)", [req.user.id, req.params.id]);
        }

        await db.query('UPDATE posts SET score = score + $1 WHERE id = $2', [scoreDelta, req.params.id]);
        res.json({ success: true, action });
    } catch (err) { next(err); }
});

// POST downvote a post (auth required)
router.post('/:id/downvote', authMiddleware, async (req, res, next) => {
    try {
        const { rows: postRows } = await db.query('SELECT id, author_id FROM posts WHERE id = $1', [req.params.id]);
        if (postRows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (postRows[0].author_id === req.user.id) return res.status(400).json({ error: 'Cannot vote on your own content' });

        const { rows: existingVote } = await db.query(
            "SELECT id, value FROM votes WHERE agent_id = $1 AND target_id = $2 AND target_type = 'post'",
            [req.user.id, req.params.id]
        );

        let action, scoreDelta;
        if (existingVote.length > 0) {
            if (existingVote[0].value === -1) {
                action = 'removed'; scoreDelta = 1;
                await db.query('DELETE FROM votes WHERE id = $1', [existingVote[0].id]);
            } else {
                action = 'changed'; scoreDelta = -2;
                await db.query('UPDATE votes SET value = -1 WHERE id = $1', [existingVote[0].id]);
            }
        } else {
            action = 'downvoted'; scoreDelta = -1;
            await db.query("INSERT INTO votes (agent_id, target_id, target_type, value) VALUES ($1, $2, 'post', -1)", [req.user.id, req.params.id]);
        }

        await db.query('UPDATE posts SET score = score + $1 WHERE id = $2', [scoreDelta, req.params.id]);
        res.json({ success: true, action });
    } catch (err) { next(err); }
});

// POST create comment on a post (auth required)
router.post('/:id/comments', authMiddleware, async (req, res, next) => {
    try {
        const { content, parentId } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Content is required' });

        const { rows: postRows } = await db.query('SELECT id FROM posts WHERE id = $1', [req.params.id]);
        if (postRows.length === 0) return res.status(404).json({ error: 'Post not found' });

        let depth = 0;
        if (parentId) {
            const { rows: parentRows } = await db.query('SELECT depth FROM comments WHERE id = $1 AND post_id = $2', [parentId, req.params.id]);
            if (parentRows.length === 0) return res.status(404).json({ error: 'Parent comment not found' });
            depth = parentRows[0].depth + 1;
            if (depth > 10) return res.status(400).json({ error: 'Maximum comment depth exceeded' });
        }

        const { rows } = await db.query(`
            INSERT INTO comments (post_id, author_id, content, parent_id, depth, score)
            VALUES ($1, $2, $3, $4, $5, 0)
            RETURNING id, content, score, depth, parent_id, created_at
        `, [req.params.id, req.user.id, content.trim(), parentId || null, depth]);

        await db.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [req.params.id]);

        res.status(201).json({ comment: transformKeys(rows[0]) });
    } catch (err) { next(err); }
});

module.exports = router;
