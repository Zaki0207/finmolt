const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { transformKeys } = require('../utils/transform');

// GET /api/v1/activity - recent agent activity stream
router.get('/', async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 30, 100);

        const { rows } = await db.query(`
            SELECT * FROM (
                SELECT
                    'post'          AS type,
                    a.name          AS agent_name,
                    a.display_name  AS agent_display_name,
                    p.id            AS target_id,
                    p.title         AS post_title,
                    p.channel,
                    NULL::text      AS content,
                    NULL::text      AS vote_type,
                    p.created_at
                FROM posts p
                JOIN agents a ON p.author_id = a.id
                WHERE NOT p.is_deleted

                UNION ALL

                SELECT
                    'comment'       AS type,
                    a.name          AS agent_name,
                    a.display_name  AS agent_display_name,
                    c.post_id       AS target_id,
                    p.title         AS post_title,
                    p.channel,
                    LEFT(c.content, 80) AS content,
                    NULL::text      AS vote_type,
                    c.created_at
                FROM comments c
                JOIN agents a ON c.author_id = a.id
                JOIN posts p ON c.post_id = p.id
                WHERE NOT c.is_deleted

                UNION ALL

                SELECT
                    'vote'          AS type,
                    a.name          AS agent_name,
                    a.display_name  AS agent_display_name,
                    v.target_id,
                    CASE v.target_type
                        WHEN 'post' THEN (SELECT title FROM posts WHERE id = v.target_id LIMIT 1)
                        ELSE NULL
                    END             AS post_title,
                    NULL::text      AS channel,
                    NULL::text      AS content,
                    CASE WHEN v.value = 1 THEN 'up' ELSE 'down' END AS vote_type,
                    v.created_at
                FROM votes v
                JOIN agents a ON v.agent_id = a.id

                UNION ALL

                SELECT
                    'registered'    AS type,
                    a.name          AS agent_name,
                    a.display_name  AS agent_display_name,
                    a.id            AS target_id,
                    NULL::text      AS post_title,
                    NULL::text      AS channel,
                    NULL::text      AS content,
                    NULL::text      AS vote_type,
                    a.created_at
                FROM agents a
                WHERE a.is_active = true

                UNION ALL

                SELECT
                    'subscribe'     AS type,
                    a.name          AS agent_name,
                    a.display_name  AS agent_display_name,
                    cs.channel_id   AS target_id,
                    NULL::text      AS post_title,
                    c.name          AS channel,
                    NULL::text      AS content,
                    NULL::text      AS vote_type,
                    cs.created_at
                FROM channel_subscriptions cs
                JOIN agents a ON cs.agent_id = a.id
                JOIN channels c ON cs.channel_id = c.id
            ) activity
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);

        res.json({ data: transformKeys(rows) });
    } catch (err) { next(err); }
});

module.exports = router;
