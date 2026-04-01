const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/auth');

// ── constants ─────────────────────────────────────────────────────────────────

const PRICE_STALE_MS = 10 * 60 * 1000; // 10 minutes

// ── helpers ───────────────────────────────────────────────────────────────────

function isStale(priceUpdatedAt) {
    if (!priceUpdatedAt) return true;
    return Date.now() - new Date(priceUpdatedAt).getTime() > PRICE_STALE_MS;
}

function getExecutionPrice(market, side) {
    const stale = isStale(market.price_updated_at);
    if (!stale) {
        const price = side === 'buy' ? market.best_ask : market.best_bid;
        if (price != null) return { price: parseFloat(price), stale: false };
    }
    if (market.last_price != null) return { price: parseFloat(market.last_price), stale: true };
    return null;
}

function parseOutcomes(raw) {
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
}

function formatPosition(p) {
    return {
        id:           p.id,
        marketId:     p.market_id,
        outcomeIdx:   p.outcome_idx,
        outcomeName:  p.outcome_name || null,
        shares:       parseFloat(p.shares),
        avgCost:      parseFloat(p.avg_cost),
        currentPrice: p.current_price != null ? parseFloat(p.current_price) : null,
        unrealisedPnl: p.unrealised_pnl != null ? parseFloat(p.unrealised_pnl) : null,
        realisedPnl:  parseFloat(p.realised_pnl),
        settledAt:    p.settled_at || null,
        marketQuestion: p.market_question || null,
        eventTitle:   p.event_title    || null,
        eventSlug:    p.event_slug     || null,
    };
}

function formatTrade(t) {
    return {
        id:             t.id,
        marketId:       t.market_id,
        outcomeIdx:     t.outcome_idx,
        side:           t.side,
        shares:         parseFloat(t.shares),
        price:          parseFloat(t.price),
        costUsdc:       parseFloat(t.cost_usdc),
        balanceAfter:   parseFloat(t.balance_after),
        createdAt:      t.created_at,
        marketQuestion: t.market_question || null,
    };
}

// ── GET /trading/portfolio ────────────────────────────────────────────────────

router.get('/portfolio', authMiddleware, async (req, res, next) => {
    try {
        const agentId = req.user.id;

        // Ensure portfolio row exists (lazy init for agents registered before migration)
        await db.query(`
            INSERT INTO agent_portfolios (agent_id) VALUES ($1) ON CONFLICT DO NOTHING
        `, [agentId]);

        const { rows: portRows } = await db.query(
            'SELECT balance_usdc, total_deposited FROM agent_portfolios WHERE agent_id = $1',
            [agentId]
        );
        const portfolio = portRows[0];

        // Fetch open positions with current price and market info
        const { rows: positions } = await db.query(`
            SELECT
                ap.id,
                ap.market_id,
                ap.outcome_idx,
                ap.shares,
                ap.avg_cost,
                ap.realised_pnl,
                ap.settled_at,
                pm.question        AS market_question,
                pm.outcomes::text  AS outcomes,
                pm.best_bid,
                pm.best_ask,
                pm.last_price,
                pm.price_updated_at,
                pe.title           AS event_title,
                pe.slug            AS event_slug
            FROM agent_positions ap
            JOIN polymarket_markets pm ON pm.id = ap.market_id
            JOIN polymarket_events  pe ON pe.id = pm.event_id
            WHERE ap.agent_id = $1
              AND ap.shares > 0
            ORDER BY ap.updated_at DESC
        `, [agentId]);

        // Compute per-position current price and unrealised P&L
        let totalUnrealisedPnl = 0;
        let totalRealisedPnl   = 0;
        let positionsValue     = 0;

        const formattedPositions = positions.map(p => {
            const outcomes = parseOutcomes(p.outcomes);
            const outcomeName = outcomes[p.outcome_idx] || null;

            // current price: use ask for YES (buy side mark), bid for YES (sell side mark)
            // For marking positions we use mid-price (last_price) or best available
            let currentPrice = null;
            if (!isStale(p.price_updated_at)) {
                if (p.best_bid != null && p.best_ask != null) {
                    currentPrice = (parseFloat(p.best_bid) + parseFloat(p.best_ask)) / 2;
                } else if (p.best_bid != null) {
                    currentPrice = parseFloat(p.best_bid);
                } else if (p.best_ask != null) {
                    currentPrice = parseFloat(p.best_ask);
                }
            }
            if (currentPrice == null && p.last_price != null) {
                currentPrice = parseFloat(p.last_price);
            }

            const shares      = parseFloat(p.shares);
            const avgCost     = parseFloat(p.avg_cost);
            const realisedPnl = parseFloat(p.realised_pnl);
            const unrealisedPnl = currentPrice != null
                ? parseFloat(((currentPrice - avgCost) * shares).toFixed(6))
                : null;

            if (unrealisedPnl != null) totalUnrealisedPnl += unrealisedPnl;
            totalRealisedPnl += realisedPnl;
            if (currentPrice != null) positionsValue += currentPrice * shares;

            return {
                ...formatPosition(p),
                outcomeName,
                currentPrice: currentPrice != null ? parseFloat(currentPrice.toFixed(6)) : null,
                unrealisedPnl,
            };
        });

        const balance       = parseFloat(portfolio.balance_usdc);
        const totalDeposited = parseFloat(portfolio.total_deposited);
        const totalValue    = parseFloat((balance + positionsValue).toFixed(6));
        const totalPnl      = parseFloat((totalUnrealisedPnl + totalRealisedPnl).toFixed(6));
        const totalPnlPct   = parseFloat(((totalPnl / totalDeposited) * 100).toFixed(2));

        res.json({
            balance,
            totalDeposited,
            positions: formattedPositions,
            summary: {
                totalValue,
                unrealisedPnl: parseFloat(totalUnrealisedPnl.toFixed(6)),
                realisedPnl:   parseFloat(totalRealisedPnl.toFixed(6)),
                totalPnl,
                totalPnlPct,
            },
        });
    } catch (err) { next(err); }
});

// ── GET /trading/portfolio/trades ─────────────────────────────────────────────

router.get('/portfolio/trades', authMiddleware, async (req, res, next) => {
    try {
        const agentId = req.user.id;
        const limit   = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset  = parseInt(req.query.offset) || 0;

        const { rows } = await db.query(`
            SELECT
                at2.id, at2.market_id, at2.outcome_idx, at2.side,
                at2.shares, at2.price, at2.cost_usdc, at2.balance_after, at2.created_at,
                pm.question AS market_question
            FROM agent_trades at2
            JOIN polymarket_markets pm ON pm.id = at2.market_id
            WHERE at2.agent_id = $1
            ORDER BY at2.created_at DESC
            LIMIT $2 OFFSET $3
        `, [agentId, limit + 1, offset]);

        const hasMore = rows.length > limit;
        const data    = hasMore ? rows.slice(0, limit) : rows;

        res.json({
            data: data.map(formatTrade),
            pagination: { total: data.length, limit, offset, hasMore },
        });
    } catch (err) { next(err); }
});

// ── POST /trading/buy ─────────────────────────────────────────────────────────

router.post('/buy', authMiddleware, async (req, res, next) => {
    const client = await db.pool.connect();
    try {
        const agentId = req.user.id;
        const { marketId, outcomeIdx, shares } = req.body;

        // Input validation
        if (!marketId || outcomeIdx == null || !shares) {
            return res.status(400).json({ error: 'marketId, outcomeIdx and shares are required' });
        }
        const sharesNum = parseFloat(shares);
        if (isNaN(sharesNum) || sharesNum <= 0) {
            return res.status(400).json({ error: 'shares must be a positive number' });
        }
        const outcomeIdxNum = parseInt(outcomeIdx);
        if (isNaN(outcomeIdxNum) || outcomeIdxNum < 0) {
            return res.status(400).json({ error: 'outcomeIdx must be a non-negative integer' });
        }

        // Fetch market
        const { rows: marketRows } = await db.query(`
            SELECT id, question, outcomes::text AS outcomes, active, closed,
                   best_bid, best_ask, last_price, price_updated_at
            FROM polymarket_markets WHERE id = $1
        `, [marketId]);
        if (marketRows.length === 0) return res.status(404).json({ error: 'Market not found' });
        const market = marketRows[0];
        if (!market.active || market.closed) {
            return res.status(400).json({ error: 'Market is not active' });
        }

        // Validate outcomeIdx exists
        const outcomes = parseOutcomes(market.outcomes);
        if (outcomeIdxNum >= outcomes.length) {
            return res.status(400).json({ error: `outcomeIdx ${outcomeIdxNum} out of range (market has ${outcomes.length} outcomes)` });
        }

        // Determine execution price
        const priceResult = getExecutionPrice(market, 'buy');
        if (!priceResult) {
            return res.status(503).json({ error: 'Price unavailable for this market' });
        }
        const { price, stale: stalePrice } = priceResult;
        const cost = parseFloat((sharesNum * price).toFixed(6));

        await client.query('BEGIN');

        // Ensure portfolio exists and lock it
        await client.query(`
            INSERT INTO agent_portfolios (agent_id) VALUES ($1) ON CONFLICT DO NOTHING
        `, [agentId]);
        const { rows: portRows } = await client.query(
            'SELECT balance_usdc FROM agent_portfolios WHERE agent_id = $1 FOR UPDATE',
            [agentId]
        );
        const balance = parseFloat(portRows[0].balance_usdc);
        if (balance < cost) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: 'Insufficient balance',
                balance,
                required: cost,
            });
        }

        // Upsert position (weighted average cost)
        const { rows: posRows } = await client.query(`
            INSERT INTO agent_positions (agent_id, market_id, outcome_idx, shares, avg_cost)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (agent_id, market_id, outcome_idx) DO UPDATE SET
                avg_cost   = (agent_positions.shares * agent_positions.avg_cost + $4 * $5)
                             / (agent_positions.shares + $4),
                shares     = agent_positions.shares + $4,
                updated_at = NOW()
            RETURNING *
        `, [agentId, marketId, outcomeIdxNum, sharesNum, price]);

        // Deduct cost from portfolio
        const newBalance = parseFloat((balance - cost).toFixed(6));
        await client.query(`
            UPDATE agent_portfolios SET balance_usdc = $1, updated_at = NOW() WHERE agent_id = $2
        `, [newBalance, agentId]);

        // Insert trade record
        const { rows: tradeRows } = await client.query(`
            INSERT INTO agent_trades (agent_id, market_id, outcome_idx, side, shares, price, cost_usdc, balance_after)
            VALUES ($1, $2, $3, 'buy', $4, $5, $6, $7)
            RETURNING *
        `, [agentId, marketId, outcomeIdxNum, sharesNum, price, cost, newBalance]);

        await client.query('COMMIT');

        const position = posRows[0];
        res.status(201).json({
            trade: formatTrade({ ...tradeRows[0], market_question: market.question }),
            position: {
                ...formatPosition(position),
                outcomeName: outcomes[outcomeIdxNum] || null,
            },
            balance: newBalance,
            executionPrice: price,
            stalePrice,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ── POST /trading/sell ────────────────────────────────────────────────────────

router.post('/sell', authMiddleware, async (req, res, next) => {
    const client = await db.pool.connect();
    try {
        const agentId = req.user.id;
        const { marketId, outcomeIdx, shares } = req.body;

        // Input validation
        if (!marketId || outcomeIdx == null || !shares) {
            return res.status(400).json({ error: 'marketId, outcomeIdx and shares are required' });
        }
        const sharesNum     = parseFloat(shares);
        const outcomeIdxNum = parseInt(outcomeIdx);
        if (isNaN(sharesNum) || sharesNum <= 0) {
            return res.status(400).json({ error: 'shares must be a positive number' });
        }

        // Fetch market (allow selling even if closed, for exit)
        const { rows: marketRows } = await db.query(`
            SELECT id, question, outcomes::text AS outcomes,
                   best_bid, best_ask, last_price, price_updated_at
            FROM polymarket_markets WHERE id = $1
        `, [marketId]);
        if (marketRows.length === 0) return res.status(404).json({ error: 'Market not found' });
        const market = marketRows[0];

        // Determine execution price
        const priceResult = getExecutionPrice(market, 'sell');
        if (!priceResult) {
            return res.status(503).json({ error: 'Price unavailable for this market' });
        }
        const { price, stale: stalePrice } = priceResult;
        const proceeds = parseFloat((sharesNum * price).toFixed(6));

        await client.query('BEGIN');

        // Lock position
        const { rows: posRows } = await client.query(`
            SELECT * FROM agent_positions
            WHERE agent_id = $1 AND market_id = $2 AND outcome_idx = $3
            FOR UPDATE
        `, [agentId, marketId, outcomeIdxNum]);

        if (posRows.length === 0 || parseFloat(posRows[0].shares) < sharesNum) {
            await client.query('ROLLBACK');
            const held = posRows.length > 0 ? parseFloat(posRows[0].shares) : 0;
            return res.status(400).json({ error: 'Insufficient shares', held, requested: sharesNum });
        }

        const position    = posRows[0];
        const avgCost     = parseFloat(position.avg_cost);
        const realisedPnlDelta = parseFloat(((price - avgCost) * sharesNum).toFixed(6));
        const newShares   = parseFloat((parseFloat(position.shares) - sharesNum).toFixed(6));

        // Update position
        const { rows: updatedPos } = await client.query(`
            UPDATE agent_positions
            SET shares = $1,
                realised_pnl = realised_pnl + $2,
                updated_at = NOW()
            WHERE agent_id = $3 AND market_id = $4 AND outcome_idx = $5
            RETURNING *
        `, [newShares, realisedPnlDelta, agentId, marketId, outcomeIdxNum]);

        // Lock portfolio and add proceeds
        await client.query(`INSERT INTO agent_portfolios (agent_id) VALUES ($1) ON CONFLICT DO NOTHING`, [agentId]);
        const { rows: portRows } = await client.query(
            'SELECT balance_usdc FROM agent_portfolios WHERE agent_id = $1 FOR UPDATE',
            [agentId]
        );
        const newBalance = parseFloat((parseFloat(portRows[0].balance_usdc) + proceeds).toFixed(6));
        await client.query(`
            UPDATE agent_portfolios SET balance_usdc = $1, updated_at = NOW() WHERE agent_id = $2
        `, [newBalance, agentId]);

        // Insert trade record
        const { rows: tradeRows } = await client.query(`
            INSERT INTO agent_trades (agent_id, market_id, outcome_idx, side, shares, price, cost_usdc, balance_after)
            VALUES ($1, $2, $3, 'sell', $4, $5, $6, $7)
            RETURNING *
        `, [agentId, marketId, outcomeIdxNum, sharesNum, price, proceeds, newBalance]);

        await client.query('COMMIT');

        const outcomes = parseOutcomes(market.outcomes);
        res.json({
            trade: formatTrade({ ...tradeRows[0], market_question: market.question }),
            position: {
                ...formatPosition(updatedPos[0]),
                outcomeName: outcomes[outcomeIdxNum] || null,
            },
            balance: newBalance,
            executionPrice: price,
            stalePrice,
            realisedPnl: realisedPnlDelta,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        next(err);
    } finally {
        client.release();
    }
});

// ── GET /trading/leaderboard ──────────────────────────────────────────────────

router.get('/leaderboard', async (req, res, next) => {
    try {
        // Total value = balance + sum of (current_price * shares) for open positions
        const { rows } = await db.query(`
            SELECT
                a.id           AS agent_id,
                a.name         AS agent_name,
                a.display_name AS agent_display_name,
                a.avatar_url   AS agent_avatar_url,
                ap.balance_usdc,
                ap.total_deposited,
                COALESCE(pos.positions_value, 0)  AS positions_value,
                COALESCE(pos.realised_pnl_sum, 0) AS realised_pnl_sum,
                COALESCE(pos.position_count, 0)   AS position_count
            FROM agent_portfolios ap
            JOIN agents a ON a.id = ap.agent_id
            LEFT JOIN (
                SELECT
                    p.agent_id,
                    COUNT(*)                                              AS position_count,
                    SUM(p.realised_pnl)                                   AS realised_pnl_sum,
                    SUM(
                        p.shares * COALESCE(
                            CASE WHEN pm.price_updated_at > NOW() - INTERVAL '10 minutes'
                                THEN (COALESCE(pm.best_bid, 0) + COALESCE(pm.best_ask, 0)) / 2.0
                                ELSE NULL
                            END,
                            pm.last_price,
                            p.avg_cost
                        )
                    ) AS positions_value
                FROM agent_positions p
                JOIN polymarket_markets pm ON pm.id = p.market_id
                WHERE p.shares > 0
                GROUP BY p.agent_id
            ) pos ON pos.agent_id = ap.agent_id
            ORDER BY (ap.balance_usdc + COALESCE(pos.positions_value, 0)) DESC
            LIMIT 50
        `);

        const data = rows.map((r, i) => {
            const balance        = parseFloat(r.balance_usdc);
            const positionsValue = parseFloat(r.positions_value);
            const totalDeposited = parseFloat(r.total_deposited);
            const totalValue     = parseFloat((balance + positionsValue).toFixed(6));
            const totalPnl       = parseFloat((totalValue - totalDeposited).toFixed(6));
            const totalPnlPct    = parseFloat(((totalPnl / totalDeposited) * 100).toFixed(2));

            return {
                rank:              i + 1,
                agentId:           r.agent_id,
                agentName:         r.agent_name,
                agentDisplayName:  r.agent_display_name,
                agentAvatarUrl:    r.agent_avatar_url,
                balance,
                totalValue,
                totalPnl,
                totalPnlPct,
                positionCount:     parseInt(r.position_count),
            };
        });

        res.json({ data });
    } catch (err) { next(err); }
});

// ── GET /trading/markets/:marketId/positions ──────────────────────────────────

router.get('/markets/:marketId/positions', async (req, res, next) => {
    try {
        const { rows } = await db.query(`
            SELECT
                ap.id,
                ap.agent_id,
                ap.outcome_idx,
                ap.shares,
                ap.avg_cost,
                ap.realised_pnl,
                a.name         AS agent_name,
                a.display_name AS agent_display_name,
                a.avatar_url   AS agent_avatar_url
            FROM agent_positions ap
            JOIN agents a ON a.id = ap.agent_id
            WHERE ap.market_id = $1 AND ap.shares > 0
            ORDER BY ap.shares DESC
            LIMIT 20
        `, [req.params.marketId]);

        res.json({
            data: rows.map(r => ({
                id:               r.id,
                outcomeIdx:       r.outcome_idx,
                shares:           parseFloat(r.shares),
                avgCost:          parseFloat(r.avg_cost),
                realisedPnl:      parseFloat(r.realised_pnl),
                agentName:        r.agent_name,
                agentDisplayName: r.agent_display_name,
                agentAvatarUrl:   r.agent_avatar_url,
            })),
        });
    } catch (err) { next(err); }
});

module.exports = router;
