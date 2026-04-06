const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/auth');

// ── constants ─────────────────────────────────────────────────────────────────

const PRICE_STALE_MS           = 10 * 60 * 1000; // 10 minutes
const SLIPPAGE_THRESHOLD       = 100;             // shares; below this: no slippage
const SLIPPAGE_RATE            = 0.005;           // 0.5% per 100 shares over threshold
const MAX_POSITION_COST_PCT    = parseFloat(process.env.MAX_POSITION_COST_PCT    || '0.3');
const MAX_TOTAL_EXPOSURE_PCT   = parseFloat(process.env.MAX_TOTAL_EXPOSURE_PCT   || '0.8');
const SERIALIZABLE_MAX_RETRIES = 3;

// ── helpers ───────────────────────────────────────────────────────────────────

function isStale(priceUpdatedAt) {
    if (!priceUpdatedAt) return true;
    return Date.now() - new Date(priceUpdatedAt).getTime() > PRICE_STALE_MS;
}

/**
 * Determine execution price for a given side (buy/sell) and outcomeIdx.
 *
 * For binary markets (2 outcomes), outcomeIdx=1 is the NO token.
 * The CLOB only has an order book for the YES (index-0) token.
 * Since YES + NO = 1 in a binary market:
 *   buy  NO  → pay NO ask  = 1 − YES bid
 *   sell NO  → receive NO bid = 1 − YES ask
 *
 * For multi-outcome markets (>2 outcomes), each token has its own price and
 * there is no complementary relationship, so we use the YES price as-is.
 */
function getExecutionPrice(market, side, outcomeIdx) {
    const outcomes = parseOutcomes(market.outcomes);
    const isBinary   = outcomes.length === 2;
    const isNoOutcome = isBinary && outcomeIdx === 1;

    const stale = isStale(market.price_updated_at);

    if (!stale) {
        if (isNoOutcome) {
            // buy NO  = 1 − YES_bid;  sell NO = 1 − YES_ask
            const yesRef = side === 'buy' ? market.best_bid : market.best_ask;
            if (yesRef != null) {
                const noPrice = parseFloat((1 - parseFloat(yesRef)).toFixed(6));
                if (noPrice > 0 && noPrice < 1) return { price: noPrice, stale: false };
            }
        } else {
            const price = side === 'buy' ? market.best_ask : market.best_bid;
            if (price != null) return { price: parseFloat(price), stale: false };
        }
    }

    // Fall back to last_price (stale)
    if (market.last_price != null) {
        if (isNoOutcome) {
            const noPrice = parseFloat((1 - parseFloat(market.last_price)).toFixed(6));
            if (noPrice > 0 && noPrice < 1) return { price: noPrice, stale: true };
        }
        return { price: parseFloat(market.last_price), stale: true };
    }

    return null;
}

/**
 * Apply linear slippage for large orders.
 * Orders > SLIPPAGE_THRESHOLD shares incur 0.5% per extra 100 shares.
 */
function applySlippage(price, shares, side) {
    if (shares <= SLIPPAGE_THRESHOLD) return price;
    const excess      = shares - SLIPPAGE_THRESHOLD;
    const slippagePct = SLIPPAGE_RATE * (excess / 100);
    const adjusted    = side === 'buy' ? price * (1 + slippagePct) : price * (1 - slippagePct);
    return parseFloat(Math.min(Math.max(adjusted, 0.001), 0.999).toFixed(6));
}

/**
 * Re-verify market is still open inside a transaction.
 * Uses FOR SHARE so concurrent updates wait without blocking reads.
 * Returns true if market is open; false otherwise.
 */
async function verifyMarketOpen(client, marketId) {
    const { rows } = await client.query(
        `SELECT pm.active, pm.closed, pm.closed_time,
                pe.closed AS event_closed, pe.active AS event_active
         FROM polymarket_markets pm
         JOIN polymarket_events pe ON pe.id = pm.event_id
         WHERE pm.id = $1 FOR SHARE`,
        [marketId]
    );
    if (rows.length === 0) return false;
    const m = rows[0];
    return m.active && !m.closed && !m.closed_time && !m.event_closed && m.event_active;
}

function parseOutcomes(raw) {
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
}

function formatPosition(p) {
    const marketClosed = !!(
        p.market_closed ||
        p.market_closed_time ||
        !p.market_active ||
        p.event_closed ||
        !p.event_active
    );
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
        marketClosed,
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

/**
 * Execute a database operation with SERIALIZABLE isolation and automatic
 * retry on serialization failures (pg error code 40001).
 */
async function withSerializableRetry(fn) {
    for (let attempt = 0; attempt < SERIALIZABLE_MAX_RETRIES; attempt++) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (err.code === '40001' && attempt < SERIALIZABLE_MAX_RETRIES - 1) {
                // Serialization failure — back off and retry
                await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
                continue;
            }
            throw err;
        } finally {
            client.release();
        }
    }
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
                pm.closed          AS market_closed,
                pm.active          AS market_active,
                pm.closed_time     AS market_closed_time,
                pe.title           AS event_title,
                pe.slug            AS event_slug,
                pe.closed          AS event_closed,
                pe.active          AS event_active
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
            const outcomes    = parseOutcomes(p.outcomes);
            const outcomeName = outcomes[p.outcome_idx] || null;

            // For binary markets, NO position price = 1 - YES mid-price
            const isBinary    = outcomes.length === 2;
            const isNoOutcome = isBinary && p.outcome_idx === 1;

            let currentPrice = null;
            if (!isStale(p.price_updated_at)) {
                if (p.best_bid != null && p.best_ask != null) {
                    const mid = (parseFloat(p.best_bid) + parseFloat(p.best_ask)) / 2;
                    currentPrice = isNoOutcome ? 1 - mid : mid;
                } else if (p.best_bid != null) {
                    currentPrice = isNoOutcome ? 1 - parseFloat(p.best_bid) : parseFloat(p.best_bid);
                } else if (p.best_ask != null) {
                    currentPrice = isNoOutcome ? 1 - parseFloat(p.best_ask) : parseFloat(p.best_ask);
                }
            }
            if (currentPrice == null && p.last_price != null) {
                const lp = parseFloat(p.last_price);
                currentPrice = isNoOutcome ? 1 - lp : lp;
            }
            if (currentPrice != null) {
                currentPrice = Math.max(0, Math.min(1, currentPrice));
            }

            const shares        = parseFloat(p.shares);
            const avgCost       = parseFloat(p.avg_cost);
            const realisedPnl   = parseFloat(p.realised_pnl);
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

        const balance        = parseFloat(portfolio.balance_usdc);
        const totalDeposited = parseFloat(portfolio.total_deposited);
        const totalValue     = parseFloat((balance + positionsValue).toFixed(6));
        const totalPnl       = parseFloat((totalUnrealisedPnl + totalRealisedPnl).toFixed(6));
        const totalPnlPct    = parseFloat(((totalPnl / totalDeposited) * 100).toFixed(2));

        // Fetch recently settled positions (last 20)
        const { rows: settledRows } = await db.query(`
            SELECT
                ap.id, ap.market_id, ap.outcome_idx, ap.shares,
                ap.avg_cost, ap.realised_pnl, ap.settled_at,
                pm.question        AS market_question,
                pm.outcomes::text  AS outcomes,
                pm.resolved_outcome,
                pm.closed          AS market_closed,
                pm.active          AS market_active,
                pm.closed_time     AS market_closed_time,
                pe.title           AS event_title,
                pe.slug            AS event_slug,
                pe.closed          AS event_closed,
                pe.active          AS event_active
            FROM agent_positions ap
            JOIN polymarket_markets pm ON pm.id = ap.market_id
            JOIN polymarket_events  pe ON pe.id = pm.event_id
            WHERE ap.agent_id = $1
              AND ap.settled_at IS NOT NULL
            ORDER BY ap.settled_at DESC
            LIMIT 20
        `, [agentId]);

        const settledPositions = settledRows.map(p => {
            const outcomes = parseOutcomes(p.outcomes);
            return {
                ...formatPosition(p),
                outcomeName:     outcomes[p.outcome_idx] || null,
                resolvedOutcome: p.resolved_outcome || null,
                currentPrice:    null,
                unrealisedPnl:   null,
            };
        });

        // Include settled realised P&L in totals
        const totalSettledPnl  = settledPositions.reduce((sum, p) => sum + p.realisedPnl, 0);
        const grandTotalPnl    = parseFloat((totalUnrealisedPnl + totalRealisedPnl + totalSettledPnl).toFixed(6));
        const grandTotalPnlPct = parseFloat(((grandTotalPnl / totalDeposited) * 100).toFixed(2));

        res.json({
            balance,
            totalDeposited,
            positions: formattedPositions,
            settledPositions,
            summary: {
                totalValue,
                unrealisedPnl: parseFloat(totalUnrealisedPnl.toFixed(6)),
                realisedPnl:   parseFloat((totalRealisedPnl + totalSettledPnl).toFixed(6)),
                totalPnl:      grandTotalPnl,
                totalPnlPct:   grandTotalPnlPct,
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

        // Fetch market (outside transaction for read performance)
        const { rows: marketRows } = await db.query(`
            SELECT pm.id, pm.question, pm.outcomes::text AS outcomes,
                   pm.active, pm.closed, pm.closed_time,
                   pm.best_bid, pm.best_ask, pm.last_price, pm.price_updated_at,
                   pe.closed AS event_closed, pe.active AS event_active
            FROM polymarket_markets pm
            JOIN polymarket_events pe ON pe.id = pm.event_id
            WHERE pm.id = $1
        `, [marketId]);
        if (marketRows.length === 0) return res.status(404).json({ error: 'Market not found' });
        const market = marketRows[0];
        if (!market.active || market.closed || market.closed_time || market.event_closed || !market.event_active) {
            return res.status(400).json({ error: 'Market is not active' });
        }

        // Validate outcomeIdx
        const outcomes = parseOutcomes(market.outcomes);
        if (outcomeIdxNum >= outcomes.length) {
            return res.status(400).json({ error: `outcomeIdx ${outcomeIdxNum} out of range (market has ${outcomes.length} outcomes)` });
        }

        // Determine execution price (with slippage for large orders)
        const priceResult = getExecutionPrice(market, 'buy', outcomeIdxNum);
        if (!priceResult) {
            return res.status(503).json({ error: 'Price unavailable for this market' });
        }
        const { price: rawPrice, stale: stalePrice } = priceResult;
        const price = applySlippage(rawPrice, sharesNum, 'buy');
        const cost  = parseFloat((sharesNum * price).toFixed(6));

        // Execute inside SERIALIZABLE transaction with retry
        const result = await withSerializableRetry(async (client) => {
            // Re-verify market is still open (race condition guard)
            const open = await verifyMarketOpen(client, marketId);
            if (!open) {
                const err = new Error('Market is not active');
                err.statusCode = 400;
                throw err;
            }

            // Ensure portfolio exists and lock it
            await client.query(`
                INSERT INTO agent_portfolios (agent_id) VALUES ($1) ON CONFLICT DO NOTHING
            `, [agentId]);
            const { rows: portRows } = await client.query(
                'SELECT balance_usdc, total_deposited FROM agent_portfolios WHERE agent_id = $1 FOR UPDATE',
                [agentId]
            );
            const balance        = parseFloat(portRows[0].balance_usdc);
            const totalDeposited = parseFloat(portRows[0].total_deposited);

            if (balance < cost) {
                const err = new Error('Insufficient balance');
                err.statusCode = 400;
                err.details = { balance, required: cost };
                throw err;
            }

            // Check single-position cost limit
            if (cost > totalDeposited * MAX_POSITION_COST_PCT) {
                const err = new Error(`Trade exceeds single-position limit (max ${(MAX_POSITION_COST_PCT * 100).toFixed(0)}% of initial balance)`);
                err.statusCode = 400;
                err.details = { limit: parseFloat((totalDeposited * MAX_POSITION_COST_PCT).toFixed(6)), required: cost };
                throw err;
            }

            // Check total exposure limit
            const { rows: expRows } = await client.query(`
                SELECT COALESCE(SUM(p.shares * COALESCE(pm.last_price, p.avg_cost)), 0) AS total_exposure
                FROM agent_positions p
                JOIN polymarket_markets pm ON pm.id = p.market_id
                WHERE p.agent_id = $1 AND p.shares > 0 AND p.settled_at IS NULL
            `, [agentId]);
            const totalExposure = parseFloat(expRows[0].total_exposure);
            if (totalExposure + cost > totalDeposited * MAX_TOTAL_EXPOSURE_PCT) {
                const err = new Error(`Trade would exceed total exposure limit (max ${(MAX_TOTAL_EXPOSURE_PCT * 100).toFixed(0)}% of initial balance)`);
                err.statusCode = 400;
                err.details = { limit: parseFloat((totalDeposited * MAX_TOTAL_EXPOSURE_PCT).toFixed(6)), currentExposure: totalExposure, required: cost };
                throw err;
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

            // Deduct cost from portfolio (SQL arithmetic to avoid float drift)
            const { rows: newPortRows } = await client.query(`
                UPDATE agent_portfolios
                SET balance_usdc = balance_usdc - $1, updated_at = NOW()
                WHERE agent_id = $2
                RETURNING balance_usdc
            `, [cost, agentId]);
            const newBalance = parseFloat(newPortRows[0].balance_usdc);

            // Insert trade record
            const { rows: tradeRows } = await client.query(`
                INSERT INTO agent_trades (agent_id, market_id, outcome_idx, side, shares, price, cost_usdc, balance_after)
                VALUES ($1, $2, $3, 'buy', $4, $5, $6, $7)
                RETURNING *
            `, [agentId, marketId, outcomeIdxNum, sharesNum, price, cost, newBalance]);

            // Write ledger entry
            await client.query(`
                INSERT INTO agent_ledger (agent_id, type, amount, balance_after, reference_id)
                VALUES ($1, 'buy', $2, $3, $4)
            `, [agentId, -cost, newBalance, tradeRows[0].id]);

            return { posRows, tradeRows, newBalance };
        });

        const position = result.posRows[0];
        res.status(201).json({
            trade: formatTrade({ ...result.tradeRows[0], market_question: market.question }),
            position: {
                ...formatPosition(position),
                outcomeName: outcomes[outcomeIdxNum] || null,
            },
            balance:        result.newBalance,
            executionPrice: price,
            rawPrice,
            stalePrice,
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message, ...(err.details || {}) });
        }
        next(err);
    }
});

// ── POST /trading/sell ────────────────────────────────────────────────────────

router.post('/sell', authMiddleware, async (req, res, next) => {
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

        const { rows: marketRows } = await db.query(`
            SELECT pm.id, pm.question, pm.outcomes::text AS outcomes,
                   pm.active, pm.closed, pm.closed_time,
                   pm.best_bid, pm.best_ask, pm.last_price, pm.price_updated_at,
                   pe.closed AS event_closed, pe.active AS event_active
            FROM polymarket_markets pm
            JOIN polymarket_events pe ON pe.id = pm.event_id
            WHERE pm.id = $1
        `, [marketId]);
        if (marketRows.length === 0) return res.status(404).json({ error: 'Market not found' });
        const market = marketRows[0];
        if (!market.active || market.closed || market.closed_time || market.event_closed || !market.event_active) {
            return res.status(400).json({ error: 'Market is closed — positions will be settled automatically' });
        }

        // Determine execution price (with slippage for large orders)
        const priceResult = getExecutionPrice(market, 'sell', outcomeIdxNum);
        if (!priceResult) {
            return res.status(503).json({ error: 'Price unavailable for this market' });
        }
        const { price: rawPrice, stale: stalePrice } = priceResult;
        const price    = applySlippage(rawPrice, sharesNum, 'sell');
        const proceeds = parseFloat((sharesNum * price).toFixed(6));

        const result = await withSerializableRetry(async (client) => {
            // Lock position
            const { rows: posRows } = await client.query(`
                SELECT * FROM agent_positions
                WHERE agent_id = $1 AND market_id = $2 AND outcome_idx = $3
                FOR UPDATE
            `, [agentId, marketId, outcomeIdxNum]);

            if (posRows.length === 0 || parseFloat(posRows[0].shares) < sharesNum) {
                const held = posRows.length > 0 ? parseFloat(posRows[0].shares) : 0;
                const err = new Error('Insufficient shares');
                err.statusCode = 400;
                err.details = { held, requested: sharesNum };
                throw err;
            }

            // Re-verify market is still open (race condition guard)
            const open = await verifyMarketOpen(client, marketId);
            if (!open) {
                const err = new Error('Market is closed — positions will be settled automatically');
                err.statusCode = 400;
                throw err;
            }

            const position        = posRows[0];
            const avgCost         = parseFloat(position.avg_cost);
            const realisedPnlDelta = parseFloat(((price - avgCost) * sharesNum).toFixed(6));
            const newShares        = parseFloat((parseFloat(position.shares) - sharesNum).toFixed(6));

            // Update position
            const { rows: updatedPos } = await client.query(`
                UPDATE agent_positions
                SET shares       = $1,
                    realised_pnl = realised_pnl + $2,
                    updated_at   = NOW()
                WHERE agent_id = $3 AND market_id = $4 AND outcome_idx = $5
                RETURNING *
            `, [newShares, realisedPnlDelta, agentId, marketId, outcomeIdxNum]);

            // Lock portfolio and add proceeds (SQL arithmetic)
            await client.query(`INSERT INTO agent_portfolios (agent_id) VALUES ($1) ON CONFLICT DO NOTHING`, [agentId]);
            const { rows: newPortRows } = await client.query(`
                UPDATE agent_portfolios
                SET balance_usdc = balance_usdc + $1, updated_at = NOW()
                WHERE agent_id = $2
                RETURNING balance_usdc
            `, [proceeds, agentId]);
            const newBalance = parseFloat(newPortRows[0].balance_usdc);

            // Insert trade record
            const { rows: tradeRows } = await client.query(`
                INSERT INTO agent_trades (agent_id, market_id, outcome_idx, side, shares, price, cost_usdc, balance_after)
                VALUES ($1, $2, $3, 'sell', $4, $5, $6, $7)
                RETURNING *
            `, [agentId, marketId, outcomeIdxNum, sharesNum, price, proceeds, newBalance]);

            // Write ledger entry
            await client.query(`
                INSERT INTO agent_ledger (agent_id, type, amount, balance_after, reference_id)
                VALUES ($1, 'sell', $2, $3, $4)
            `, [agentId, proceeds, newBalance, tradeRows[0].id]);

            return { updatedPos, tradeRows, newBalance, realisedPnlDelta };
        });

        const outcomes = parseOutcomes(market.outcomes);
        res.json({
            trade: formatTrade({ ...result.tradeRows[0], market_question: market.question }),
            position: {
                ...formatPosition(result.updatedPos[0]),
                outcomeName: outcomes[outcomeIdxNum] || null,
            },
            balance:        result.newBalance,
            executionPrice: price,
            rawPrice,
            stalePrice,
            realisedPnl:    result.realisedPnlDelta,
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message, ...(err.details || {}) });
        }
        next(err);
    }
});

// ── GET /trading/leaderboard ──────────────────────────────────────────────────

router.get('/leaderboard', async (req, res, next) => {
    try {
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
