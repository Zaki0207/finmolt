const express = require('express');
const router = express.Router();
const db = require('../config/db');

// ── helpers ──────────────────────────────────────────────────────────────────

function parseOutcomes(raw) {
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
}

function formatMarket(m) {
    return {
        id: m.id,
        question: m.question,
        slug: m.slug,
        description: m.description || null,
        image: m.image || null,
        // Always return outcomes as an array (Issue #17: type consistency)
        outcomes: parseOutcomes(m.outcomes),
        groupItemTitle: m.group_item_title,
        negRisk: m.neg_risk,
        active: m.active,
        closed: m.closed,
        resolvedOutcome: m.resolved_outcome,
        startDate: m.start_date,
        endDate: m.end_date,
        closedTime: m.closed_time,
        // CLOB price fields
        clobTokenIds:   m.clob_token_ids   || [],
        bestBid:        m.best_bid         != null ? parseFloat(m.best_bid)        : null,
        bestAsk:        m.best_ask         != null ? parseFloat(m.best_ask)        : null,
        lastPrice:      m.last_price       != null ? parseFloat(m.last_price)      : null,
        priceUpdatedAt: m.price_updated_at || null,
        volume:         m.volume           != null ? parseFloat(m.volume)          : null,
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
        tags: e._tags || [],
        active: e.active,
        closed: e.closed,
        startDate: e.start_date,
        endDate: e.end_date,
        markets,
    };
}

// ── GET /polymarket/events ────────────────────────────────────────────────────
// Query params:
//   status  = active (default) | closed | settled | all
//   tag_id  = filter by tag
//   search  = full-text search
//   limit, offset

router.get('/events', async (req, res, next) => {
    try {
        const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
        const offset = parseInt(req.query.offset) || 0;
        const tagId  = req.query.tag_id;
        const search = req.query.search;
        const status = req.query.status || 'active';

        const params = [];
        const conditions = [];
        let joinClause = '';

        // Status filter (Issue #15: allow viewing closed/settled markets)
        switch (status) {
            case 'closed':
                conditions.push('e.closed = true');
                break;
            case 'settled':
                // Events where at least one market has a resolved_outcome
                conditions.push('e.closed = true');
                conditions.push(`EXISTS (
                    SELECT 1 FROM polymarket_markets pm2
                    WHERE pm2.event_id = e.id AND pm2.resolved_outcome IS NOT NULL
                )`);
                break;
            case 'all':
                // No status filter
                break;
            default: // 'active'
                conditions.push('e.active = true', 'e.closed = false');
        }

        // Tag filter via junction table
        if (tagId) {
            params.push(tagId);
            joinClause = `JOIN polymarket_event_tags et ON et.event_id = e.id AND et.tag_id = $${params.length}`;
        }

        // Full-text search
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

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        // Count query for correct pagination total (Issue #16)
        const countParams = params.slice(); // copy before adding limit/offset
        const { rows: countRows } = await db.query(`
            SELECT COUNT(DISTINCT e.id)::int AS total
            FROM polymarket_events e
            ${joinClause}
            ${where}
        `, countParams);
        const total = countRows[0].total;

        params.push(limit, offset);
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

        if (events.length === 0) {
            return res.json({
                data: [],
                pagination: { total: 0, limit, offset, hasMore: false },
            });
        }

        // Fetch markets for returned events
        const eventIds = events.map(e => e.id);
        const { rows: markets } = await db.query(`
            SELECT id, event_id, question, slug, description, image,
                   outcomes::text AS outcomes, clob_token_ids,
                   best_bid, best_ask, last_price, price_updated_at, volume,
                   group_item_title, neg_risk, active, closed, resolved_outcome,
                   start_date, end_date, closed_time
            FROM polymarket_markets
            WHERE event_id = ANY($1)
            ORDER BY created_at ASC
        `, [eventIds]);

        // Fetch tags for returned events
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
        for (const e of events) {
            e._tags = tagsByEvent[e.id] || [];
        }

        res.json({
            data: events.map(e => formatEvent(e, marketsByEvent[e.id] || [])),
            pagination: { total, limit, offset, hasMore: offset + events.length < total },
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

        const { rows: markets } = await db.query(`
            SELECT id, event_id, question, slug, description, image,
                   outcomes::text AS outcomes, clob_token_ids,
                   best_bid, best_ask, last_price, price_updated_at, volume,
                   group_item_title, neg_risk, active, closed, resolved_outcome,
                   start_date, end_date, closed_time
            FROM polymarket_markets
            WHERE event_id = $1
            ORDER BY created_at ASC
        `, [event.id]);

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

// ── GET /polymarket/markets/:marketId/prices-history ─────────────────────────

const VALID_INTERVALS = new Set(['1h', '6h', '1d', '1w', '1m', 'max']);
const FIDELITY_MAP = { '1h': 1, '6h': 5, '1d': 10, '1w': 60, '1m': 240, 'max': 1440 };

router.get('/markets/:marketId/prices-history', async (req, res, next) => {
    try {
        const { marketId } = req.params;
        const interval = VALID_INTERVALS.has(req.query.interval) ? req.query.interval : '1w';
        const fidelity = FIDELITY_MAP[interval];

        const { rows } = await db.query(
            'SELECT clob_token_ids FROM polymarket_markets WHERE id = $1',
            [marketId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Market not found' });

        const tokenIds = rows[0].clob_token_ids;
        if (!tokenIds || !tokenIds.length) return res.json({ history: [] });

        const tokenId = tokenIds[0];
        const clobUrl = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}&fidelity=${fidelity}`;

        const clobRes = await fetch(clobUrl, { signal: AbortSignal.timeout(10_000) });
        if (!clobRes.ok) return res.json({ history: [] });

        const data = await clobRes.json();
        res.json({ history: data.history || [] });
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

// ── GET /polymarket/health ────────────────────────────────────────────────────
// Issue #24: detailed health check endpoint for monitoring

router.get('/health', async (req, res, next) => {
    try {
        // DB connectivity check
        const { rows: dbRows } = await db.query('SELECT 1');
        const dbOk = dbRows.length > 0;

        // Market counts
        const { rows: countRows } = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE active = true AND closed = false)  AS active_markets,
                COUNT(*) FILTER (WHERE closed = true)                     AS closed_markets,
                COUNT(*)                                                   AS total_markets
            FROM polymarket_markets
        `);
        const counts = countRows[0];

        // Last sync time
        const { rows: syncRows } = await db.query(`
            SELECT MAX(fetched_at) AS last_sync
            FROM polymarket_events
        `);
        const lastSync = syncRows[0]?.last_sync || null;

        // Stale price check (active markets with prices > 30 min old)
        const { rows: staleRows } = await db.query(`
            SELECT COUNT(*) AS stale_count
            FROM polymarket_markets
            WHERE active = true AND closed = false
              AND neg_risk = false
              AND clob_token_ids != '[]'::jsonb
              AND clob_token_ids IS NOT NULL
              AND (price_updated_at IS NULL OR price_updated_at < NOW() - INTERVAL '30 minutes')
        `);
        const staleCount = parseInt(staleRows[0].stale_count);

        const status = !dbOk ? 'error'
            : staleCount > 50 ? 'degraded'
            : 'ok';

        res.json({
            status,
            db: dbOk,
            lastSync,
            activeMarkets:  parseInt(counts.active_markets),
            closedMarkets:  parseInt(counts.closed_markets),
            totalMarkets:   parseInt(counts.total_markets),
            stalePriceCount: staleCount,
        });
    } catch (err) { next(err); }
});

module.exports = router;
