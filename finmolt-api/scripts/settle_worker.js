#!/usr/bin/env node
// Independent settlement worker — checks for resolved markets every 5 minutes
// and settles any unsettled agent positions.
//
// Runs independently of sync_polymarket.js so settlement is not delayed by
// the full 10-minute sync cycle.
//
// Usage:
//   node scripts/settle_worker.js            # one-shot
//   node scripts/settle_worker.js --watch    # repeat every SETTLE_INTERVAL_MS (default 5 min)

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SETTLE_INTERVAL_MS = Number(process.env.SETTLE_INTERVAL_MS) || 5 * 60 * 1000;
const POLYMARKET_BASE    = 'https://gamma-api.polymarket.com';

// ---------------------------------------------------------------------------
// Helpers (duplicated from sync_polymarket to keep worker self-contained)
// ---------------------------------------------------------------------------

function parseOutcomes(raw) {
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
}

function normalizeOutcome(s) {
    return String(s).toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

async function fetchWithRetry(url, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 30_000)));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 30_000)));
            }
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------------------
// Refresh a single market's state from Gamma API
// ---------------------------------------------------------------------------

async function refreshMarketFromGamma(marketId, eventId) {
    try {
        const res = await fetchWithRetry(`${POLYMARKET_BASE}/events/${eventId}`);
        const event = await res.json();
        const m = (event.markets || []).find(mk => mk.id === marketId);
        if (!m) return null;

        let outcomePricesArr = null;
        try {
            const raw = m.outcomePrices;
            if (raw) {
                const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
                outcomePricesArr = arr.map(p => parseFloat(p));
            }
        } catch { /* ignore */ }

        let resolvedOutcome = m.resolvedOutcome || null;
        if (!resolvedOutcome && m.closed && outcomePricesArr) {
            const outcomes = parseOutcomes(m.outcomes);
            const winIdx   = outcomePricesArr.findIndex(p => p >= 0.99);
            if (winIdx !== -1 && outcomes[winIdx]) resolvedOutcome = outcomes[winIdx];
        }

        return { closed: m.closed, resolvedOutcome, outcomePricesArr };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Settlement logic
// ---------------------------------------------------------------------------

async function settleMarkets() {
    const { rows: markets } = await pool.query(`
        SELECT pm.id, pm.event_id, pm.resolved_outcome, pm.outcomes, pm.outcome_prices,
               pm.question, pm.closed, pm.last_price, pm.best_bid, pm.best_ask
        FROM polymarket_markets pm
        WHERE pm.closed = true
          AND EXISTS (
              SELECT 1 FROM agent_positions ap
              WHERE ap.market_id = pm.id
                AND ap.settled_at IS NULL
                AND ap.shares > 0
          )
    `);

    if (markets.length === 0) return 0;

    console.log(`[settle] ${markets.length} closed market(s) with unsettled positions`);

    let totalSettled = 0;

    for (const market of markets) {
        const outcomes = parseOutcomes(market.outcomes);

        let settlementPrices = null;
        if (market.outcome_prices) {
            try {
                settlementPrices = Array.isArray(market.outcome_prices)
                    ? market.outcome_prices
                    : JSON.parse(market.outcome_prices);
            } catch { /* ignore */ }
        }

        // If no settled data, try to refresh from Gamma API
        if (!settlementPrices && !market.resolved_outcome) {
            const fresh = await refreshMarketFromGamma(market.id, market.event_id);
            if (fresh) {
                settlementPrices = fresh.outcomePricesArr;
                if (fresh.resolvedOutcome) {
                    market.resolved_outcome = fresh.resolvedOutcome;
                    // Persist to DB so future runs don't need re-fetch
                    await pool.query(`
                        UPDATE polymarket_markets
                        SET resolved_outcome = $1,
                            outcome_prices   = $2,
                            closed           = true,
                            active           = false,
                            fetched_at       = NOW()
                        WHERE id = $3
                    `, [fresh.resolvedOutcome, JSON.stringify(settlementPrices), market.id]);
                }
            }
        }

        // Determine winning index
        let winningIdx = -1;

        if (settlementPrices) {
            winningIdx = settlementPrices.findIndex(p => p >= 0.99);
        }
        if (winningIdx === -1 && market.resolved_outcome) {
            const needle = normalizeOutcome(market.resolved_outcome);
            winningIdx = outcomes.findIndex(o => normalizeOutcome(o) === needle);
        }
        if (winningIdx === -1 && outcomes.length === 2) {
            const price = parseFloat(market.last_price ?? market.best_ask ?? market.best_bid ?? 'NaN');
            if (price >= 0.99) winningIdx = 0;
            else if (price <= 0.01) winningIdx = 1;
        }

        if (winningIdx === -1 && !settlementPrices) {
            console.warn(`  [settle] Market ${market.id}: cannot determine winner — skipping`);
            continue;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const { rows: positions } = await client.query(`
                SELECT id, agent_id, outcome_idx, shares, avg_cost
                FROM agent_positions
                WHERE market_id = $1 AND settled_at IS NULL AND shares > 0
                FOR UPDATE
            `, [market.id]);

            for (const pos of positions) {
                const idx   = Number(pos.outcome_idx);
                const shares  = parseFloat(pos.shares);
                const avgCost = parseFloat(pos.avg_cost);

                let payoutPerShare;
                if (settlementPrices && settlementPrices[idx] != null) {
                    payoutPerShare = settlementPrices[idx];
                } else {
                    payoutPerShare = (winningIdx !== -1 && idx === winningIdx) ? 1.0 : 0.0;
                }

                const payout      = parseFloat((shares * payoutPerShare).toFixed(6));
                const realisedPnl = parseFloat((shares * (payoutPerShare - avgCost)).toFixed(6));

                if (payout > 0) {
                    await client.query(`
                        UPDATE agent_portfolios
                        SET balance_usdc = balance_usdc + $1, updated_at = NOW()
                        WHERE agent_id = $2
                    `, [payout, pos.agent_id]);
                }

                await client.query(`
                    UPDATE agent_positions
                    SET shares       = 0,
                        realised_pnl = realised_pnl + $1,
                        settled_at   = NOW(),
                        updated_at   = NOW()
                    WHERE id = $2
                `, [realisedPnl, pos.id]);

                const ledgerType = payout > 0 ? 'settlement_win' : 'settlement_loss';
                const { rows: portRows } = await client.query(
                    'SELECT balance_usdc FROM agent_portfolios WHERE agent_id = $1',
                    [pos.agent_id]
                );
                if (portRows.length > 0) {
                    await client.query(`
                        INSERT INTO agent_ledger (agent_id, type, amount, balance_after, reference_id)
                        VALUES ($1, $2, $3, $4, $5)
                    `, [pos.agent_id, ledgerType, payout, parseFloat(portRows[0].balance_usdc), pos.id]);
                }
            }

            await client.query('COMMIT');

            const label = (market.question || market.id).substring(0, 60);
            const winStr = winningIdx !== -1 ? `winner=${outcomes[winningIdx]}` : 'multi-price';
            console.log(`  [settle] "${label}…" ${winStr}, settled ${positions.length} position(s)`);
            totalSettled += positions.length;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`  [settle] Market ${market.id} failed:`, err.message);
        } finally {
            client.release();
        }
    }

    return totalSettled;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run() {
    const ts = new Date().toISOString();
    console.log(`[${ts}] Running settlement check…`);

    try {
        const settled = await settleMarkets();
        console.log(`[${ts}] Done — ${settled} position(s) settled`);
    } catch (err) {
        console.error(`[${ts}] Settlement error:`, err.message);
    }
}

const watchMode = process.argv.includes('--watch');

run().then(() => {
    if (watchMode) {
        console.log(`Watch mode: next settlement check in ${SETTLE_INTERVAL_MS / 1000}s`);
        setInterval(run, SETTLE_INTERVAL_MS);
    } else {
        pool.end();
    }
}).catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
