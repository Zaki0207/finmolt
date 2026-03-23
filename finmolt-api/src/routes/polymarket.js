const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ── helpers ──────────────────────────────────────────────────────────────────

function formatMarket(m) {
    return {
        id: m.id,
        question: m.question,
        slug: m.slug,
        description: m.description || null,
        image: m.image || null,
        outcomes: m.outcomes,          // ::text cast → JSON string for frontend parseOutcomes
        groupItemTitle: m.group_item_title,
        negRisk: m.neg_risk,
        active: m.active,
        closed: m.closed,
        resolvedOutcome: m.resolved_outcome,
        startDate: m.start_date,
        endDate: m.end_date,
        closedTime: m.closed_time,
    };
}

function formatEvent(e, markets) {
    return {
        id: e.id,
        slug: e.slug,
        title: e.title,
        description: e.description,
        image: e.image || null,
        icon: e.icon || null,
        negRisk: e.neg_risk,
        tags: e._tags || [],           // populated from junction table
        active: e.active,
        closed: e.closed,
        startDate: e.start_date,
        endDate: e.end_date,
        markets,
    };
}

// ── GET /polymarket/events ────────────────────────────────────────────────────

router.get('/events', async (req, res, next) => {
    try {
        const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
        const offset = parseInt(req.query.offset) || 0;
        const tagId  = req.query.tag_id;
        const search = req.query.search;

        const params = [];
        const conditions = ['e.active = true', 'e.closed = false'];
        let joinClause = '';

        // Tag filter via junction table
        if (tagId) {
            params.push(tagId);
            joinClause = `JOIN polymarket_event_tags et ON et.event_id = e.id AND et.tag_id = $${params.length}`;
        }

        // Full-text search on events + markets
        if (search) {
            params.push(search);
            const p = params.length;
            conditions.push(`(
                e.search_vector @@ plainto_tsquery('english', $${p})
                OR e.id IN (
                    SELECT event_id FROM polymarket_markets
                    WHERE search_vector @@ plainto_tsquery('english', $${p})
                )
            )`);
        }

        const where = 'WHERE ' + conditions.join(' AND ');

        // Fetch limit+1 for hasMore detection (project convention)
        params.push(limit + 1, offset);
        const limitIdx  = params.length - 1;
        const offsetIdx = params.length;

        const { rows: events } = await db.query(`
            SELECT e.id, e.slug, e.title, e.description, e.image, e.icon,
                   e.neg_risk, e.active, e.closed, e.start_date, e.end_date
            FROM polymarket_events e
            ${joinClause}
            ${where}
            ORDER BY e.created_at DESC
            LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `, params);

        const hasMore = events.length > limit;
        const data = hasMore ? events.slice(0, limit) : events;

        if (data.length === 0) {
            return res.json({
                data: [],
                pagination: { total: 0, limit, offset, hasMore: false },
            });
        }

        // Fetch markets for returned events
        const eventIds = data.map(e => e.id);
        const { rows: markets } = await db.query(`
            SELECT id, event_id, question, slug, description, image,
                   outcomes::text AS outcomes,
                   group_item_title, neg_risk, active, closed, resolved_outcome,
                   start_date, end_date, closed_time
            FROM polymarket_markets
            WHERE event_id = ANY($1)
            ORDER BY created_at ASC
        `, [eventIds]);

        // Fetch tags for returned events via junction table
        const { rows: tagRows } = await db.query(`
            SELECT et.event_id, t.id, t.label, t.slug
            FROM polymarket_event_tags et
            JOIN polymarket_tags t ON t.id = et.tag_id
            WHERE et.event_id = ANY($1)
        `, [eventIds]);

        // Group markets and tags by event
        const marketsByEvent = {};
        for (const m of markets) {
            (marketsByEvent[m.event_id] = marketsByEvent[m.event_id] || []).push(formatMarket(m));
        }
        const tagsByEvent = {};
        for (const r of tagRows) {
            (tagsByEvent[r.event_id] = tagsByEvent[r.event_id] || []).push({
                id: r.id, label: r.label, slug: r.slug,
            });
        }

        // Attach tags to events
        for (const e of data) {
            e._tags = tagsByEvent[e.id] || [];
        }

        res.json({
            data: data.map(e => formatEvent(e, marketsByEvent[e.id] || [])),
            pagination: { total: data.length, limit, offset, hasMore },
        });
    } catch (err) { next(err); }
});

// ── GET /polymarket/events/:slug ──────────────────────────────────────────────

router.get('/events/:slug', async (req, res, next) => {
    try {
        const { rows } = await db.query(`
            SELECT id, slug, title, description, image, icon,
                   neg_risk, active, closed, start_date, end_date
            FROM polymarket_events
            WHERE slug = $1
        `, [req.params.slug]);

        if (rows.length === 0) return res.status(404).json({ error: 'Event not found' });

        const event = rows[0];

        // Fetch markets
        const { rows: markets } = await db.query(`
            SELECT id, event_id, question, slug, description, image,
                   outcomes::text AS outcomes,
                   group_item_title, neg_risk, active, closed, resolved_outcome,
                   start_date, end_date, closed_time
            FROM polymarket_markets
            WHERE event_id = $1
            ORDER BY created_at ASC
        `, [event.id]);

        // Fetch tags
        const { rows: tagRows } = await db.query(`
            SELECT t.id, t.label, t.slug
            FROM polymarket_event_tags et
            JOIN polymarket_tags t ON t.id = et.tag_id
            WHERE et.event_id = $1
        `, [event.id]);

        event._tags = tagRows;
        res.json(formatEvent(event, markets.map(formatMarket)));
    } catch (err) { next(err); }
});

// ── GET /polymarket/tags ──────────────────────────────────────────────────────

router.get('/tags', async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 30, 100);

        const { rows } = await db.query(`
            SELECT t.id, t.label, t.slug, COUNT(et.event_id)::int AS count
            FROM polymarket_tags t
            JOIN polymarket_event_tags et ON et.tag_id = t.id
            JOIN polymarket_events e ON e.id = et.event_id AND e.active = true
            GROUP BY t.id, t.label, t.slug
            ORDER BY count DESC
            LIMIT $1
        `, [limit]);

        res.json(rows);
    } catch (err) { next(err); }
});

module.exports = router;
