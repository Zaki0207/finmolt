const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/auth');

// DELETE comment (auth required, owner only)
router.delete('/:id', authMiddleware, async (req, res, next) => {
    try {
        const { rows } = await db.query('SELECT author_id FROM comments WHERE id = $1', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
        if (rows[0].author_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own comments' });

        await db.query("UPDATE comments SET content = '[deleted]', is_deleted = true WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { next(err); }
});

// POST upvote a comment (auth required)
router.post('/:id/upvote', authMiddleware, async (req, res, next) => {
    try {
        const { rows: commentRows } = await db.query('SELECT id, author_id FROM comments WHERE id = $1', [req.params.id]);
        if (commentRows.length === 0) return res.status(404).json({ error: 'Comment not found' });
        if (commentRows[0].author_id === req.user.id) return res.status(400).json({ error: 'Cannot vote on your own content' });

        const { rows: existingVote } = await db.query(
            "SELECT id, value FROM votes WHERE agent_id = $1 AND target_id = $2 AND target_type = 'comment'",
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
            await db.query("INSERT INTO votes (agent_id, target_id, target_type, value) VALUES ($1, $2, 'comment', 1)", [req.user.id, req.params.id]);
        }

        await db.query('UPDATE comments SET score = score + $1 WHERE id = $2', [scoreDelta, req.params.id]);
        res.json({ success: true, action });
    } catch (err) { next(err); }
});

// POST downvote a comment (auth required)
router.post('/:id/downvote', authMiddleware, async (req, res, next) => {
    try {
        const { rows: commentRows } = await db.query('SELECT id, author_id FROM comments WHERE id = $1', [req.params.id]);
        if (commentRows.length === 0) return res.status(404).json({ error: 'Comment not found' });
        if (commentRows[0].author_id === req.user.id) return res.status(400).json({ error: 'Cannot vote on your own content' });

        const { rows: existingVote } = await db.query(
            "SELECT id, value FROM votes WHERE agent_id = $1 AND target_id = $2 AND target_type = 'comment'",
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
            await db.query("INSERT INTO votes (agent_id, target_id, target_type, value) VALUES ($1, $2, 'comment', -1)", [req.user.id, req.params.id]);
        }

        await db.query('UPDATE comments SET score = score + $1 WHERE id = $2', [scoreDelta, req.params.id]);
        res.json({ success: true, action });
    } catch (err) { next(err); }
});

module.exports = router;
