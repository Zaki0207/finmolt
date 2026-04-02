#!/usr/bin/env node
// Fetches real-time bid/ask prices from Polymarket CLOB API and writes them
// to polymarket_markets (best_bid, best_ask, last_price, price_updated_at).
//
// Requires trading_schema.sql to have been applied first (migrate_trading.js).
//
// Usage:
//   node scripts/sync_prices.js            # one-shot
//   node scripts/sync_prices.js --watch    # repeat every PRICES_SYNC_INTERVAL_MS (default 2 min)

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CLOB_BASE          = 'https://clob.polymarket.com';
const SYNC_INTERVAL_MS   = Number(process.env.PRICES_SYNC_INTERVAL_MS) || 2 * 60 * 1000;
const CONCURRENCY        = 20;   // max parallel CLOB requests per batch

// ---------------------------------------------------------------------------
// CLOB helpers
// ---------------------------------------------------------------------------

async function fetchBook(tokenId) {
    const url = `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CLOB HTTP ${res.status} for token ${tokenId}`);
    return res.json();
}

function extractBidAsk(book) {
    const bids = Array.isArray(book?.bids) ? book.bids : [];
    const asks = Array.isArray(book?.asks) ? book.asks : [];

    // bids are sorted desc, asks asc — first entry is best
    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;

    // mid-price as last_price fallback when no trade history is available.
    // If spread >= 0.9 the order book is empty/illiquid (e.g. negRisk markets
    // where ask=1.0, bid=0). In that case, keep lastPrice null so we don't
    // overwrite the correct Gamma API price from sync_polymarket.
    let lastPrice = null;
    if (bestBid !== null && bestAsk !== null) {
        const spread = bestAsk - bestBid;
        if (spread < 0.9) {
            lastPrice = parseFloat(((bestBid + bestAsk) / 2).toFixed(6));
        }
    } else if (bestBid !== null) {
        lastPrice = bestBid;
    } else if (bestAsk !== null) {
        lastPrice = bestAsk;
    }

    return { bestBid, bestAsk, lastPrice };
}

// ---------------------------------------------------------------------------
// Concurrency helper — process items in batches of `limit`
// ---------------------------------------------------------------------------

async function mapConcurrent(items, limit, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += limit) {
        const batch = items.slice(i, i + limit);
        const settled = await Promise.allSettled(batch.map(fn));
        results.push(...settled);
    }
    return results;
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

async function sync() {
    const start = Date.now();
    console.log(`[${new Date().toISOString()}] Starting CLOB price sync…`);

    // Fetch active markets that have CLOB token IDs.
    // Limit to PRICES_MAX_MARKETS (default 500) most recently fetched markets
    // to keep each sync cycle fast and avoid rate-limiting.
    const maxMarkets = Number(process.env.PRICES_MAX_MARKETS) || 500;

    const { rows: markets } = await pool.query(`
        SELECT id, clob_token_ids
        FROM polymarket_markets
        WHERE active = true
          AND closed = false
          AND neg_risk = false
          AND clob_token_ids != '[]'::jsonb
          AND clob_token_ids IS NOT NULL
        ORDER BY fetched_at DESC
        LIMIT $1
    `, [maxMarkets]);

    if (markets.length === 0) {
        console.log('No active markets with CLOB token IDs found. Run polymarket:sync first.');
        return;
    }

    console.log(`Fetching prices for ${markets.length} markets…`);

    let updated = 0;
    let failed  = 0;
    const now   = new Date();

    // Build (marketId, tokenId) pairs — use index 0 (YES token) for the book
    const tasks = markets.map(m => {
        const tokenIds = Array.isArray(m.clob_token_ids) ? m.clob_token_ids : [];
        return { marketId: m.id, tokenId: tokenIds[0] || null };
    }).filter(t => t.tokenId);

    const results = await mapConcurrent(tasks, CONCURRENCY, async ({ marketId, tokenId }) => {
        const book = await fetchBook(tokenId);
        return { marketId, ...extractBidAsk(book) };
    });

    // Batch update DB
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let i = 0; i < results.length; i++) {
            const settled = results[i];
            if (settled.status === 'rejected') {
                console.warn(`  Failed ${tasks[i].marketId}: ${settled.reason?.message}`);
                failed++;
                continue;
            }
            const { marketId, bestBid, bestAsk, lastPrice } = settled.value;
            // Only overwrite last_price when the order book is liquid enough
            // to produce a meaningful mid-price. Otherwise preserve the Gamma
            // API price written by sync_polymarket (avoids 0.5 placeholder).
            if (lastPrice !== null) {
                await client.query(
                    `UPDATE polymarket_markets
                     SET best_bid = $1, best_ask = $2, last_price = $3, price_updated_at = $4
                     WHERE id = $5`,
                    [bestBid, bestAsk, lastPrice, now, marketId]
                );
            } else {
                await client.query(
                    `UPDATE polymarket_markets
                     SET best_bid = $1, best_ask = $2, price_updated_at = $3
                     WHERE id = $4`,
                    [bestBid, bestAsk, now, marketId]
                );
            }
            updated++;
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('DB update failed:', err.message);
    } finally {
        client.release();
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Done. ${updated} updated, ${failed} failed in ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const watchMode = process.argv.includes('--watch');

sync().then(() => {
    if (watchMode) {
        console.log(`Watch mode: next price sync in ${SYNC_INTERVAL_MS / 1000}s`);
        setInterval(sync, SYNC_INTERVAL_MS);
    } else {
        pool.end();
    }
}).catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
