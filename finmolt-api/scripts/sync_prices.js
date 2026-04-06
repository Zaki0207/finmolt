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
const fs = require('fs');
const { Pool } = require('pg');

const STATUS_FILE = process.env.SYNC_STATUS_FILE || null;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CLOB_BASE          = 'https://clob.polymarket.com';
const GAMMA_BASE         = 'https://gamma-api.polymarket.com';
const SYNC_INTERVAL_MS   = Number(process.env.PRICES_SYNC_INTERVAL_MS) || 2 * 60 * 1000;
const CONCURRENCY        = 20;   // max parallel CLOB requests per batch

// ---------------------------------------------------------------------------
// Retry-aware fetch helper
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, { maxRetries = 3, signal } = {}) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, signal ? { signal } : {});
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                const backoff = Math.min(1000 * Math.pow(2, attempt), 30_000);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            lastError = err;
            if (attempt < maxRetries - 1) {
                const backoff = Math.min(1000 * Math.pow(2, attempt), 30_000);
                await new Promise(r => setTimeout(r, backoff));
            }
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------------------
// CLOB helpers
// ---------------------------------------------------------------------------

async function fetchBook(tokenId) {
    const url = `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetchWithRetry(url);
    return res.json();
}

function extractBidAsk(book) {
    const bids = Array.isArray(book?.bids) ? book.bids : [];
    const asks = Array.isArray(book?.asks) ? book.asks : [];

    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;

    // mid-price as last_price fallback.
    // If spread >= 0.9, the order book is illiquid (e.g. negRisk markets
    // where ask=1.0, bid=0). Keep lastPrice null so we can fall back to
    // Gamma API price.
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

/**
 * Fetch YES price for a negRisk market from the Gamma API as fallback.
 * negRisk markets often return illiquid CLOB books (spread ≥ 0.9),
 * but the Gamma API's outcomePrices[0] contains a usable price.
 */
async function fetchNegRiskPriceFromGamma(marketId) {
    try {
        const res = await fetchWithRetry(`${GAMMA_BASE}/markets/${marketId}`);
        const m = await res.json();
        if (!m.outcomePrices) return null;
        const arr = Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices);
        const price = parseFloat(arr[0]);
        if (!isFinite(price)) return null;
        // Skip Polymarket's 0.5 placeholder for markets with no real order book
        if (price === 0.5 && m.bestAsk == null && m.bestBid == null) return null;
        return {
            bestBid:   m.bestBid  != null ? parseFloat(m.bestBid)  : null,
            bestAsk:   m.bestAsk  != null ? parseFloat(m.bestAsk)  : null,
            lastPrice: price,
        };
    } catch {
        return null;
    }
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

function writeStatus(data) {
    if (!STATUS_FILE) return;
    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(data) + '\n');
    } catch { /* ignore */ }
}

async function sync() {
    const start = Date.now();
    console.log(`[${new Date().toISOString()}] Starting CLOB price sync…`);
    writeStatus({ status: 'syncing', startedAt: new Date().toISOString(), intervalMs: SYNC_INTERVAL_MS });

    const maxMarkets = Number(process.env.PRICES_MAX_MARKETS) || 500;

    // Fetch all active markets (including negRisk — we handle them separately below)
    const { rows: markets } = await pool.query(`
        SELECT id, neg_risk, clob_token_ids
        FROM polymarket_markets
        WHERE active = true
          AND closed = false
          AND clob_token_ids != '[]'::jsonb
          AND clob_token_ids IS NOT NULL
        ORDER BY fetched_at DESC
        LIMIT $1
    `, [maxMarkets]);

    if (markets.length === 0) {
        console.log('No active markets with CLOB token IDs found. Run polymarket:sync first.');
        writeStatus({
            status: 'ok', lastSync: new Date().toISOString(), durationSec: '0',
            updated: 0, failed: 0, totalMarkets: 0,
            intervalMs: SYNC_INTERVAL_MS, nextSync: new Date(Date.now() + SYNC_INTERVAL_MS).toISOString(),
        });
        return;
    }

    console.log(`Fetching prices for ${markets.length} markets…`);

    let updated = 0;
    let failed  = 0;
    let negRiskFallbacks = 0;
    const now   = new Date();

    // Separate negRisk from standard markets
    const standardMarkets = markets.filter(m => !m.neg_risk);
    const negRiskMarkets  = markets.filter(m =>  m.neg_risk);

    // ── Standard markets: CLOB order book ─────────────────────────────────────
    const tasks = standardMarkets.map(m => {
        const tokenIds = Array.isArray(m.clob_token_ids) ? m.clob_token_ids : [];
        return { marketId: m.id, tokenId: tokenIds[0] || null, negRisk: false };
    }).filter(t => t.tokenId);

    const results = await mapConcurrent(tasks, CONCURRENCY, async ({ marketId, tokenId }) => {
        const book = await fetchBook(tokenId);
        return { marketId, ...extractBidAsk(book) };
    });

    // ── negRisk markets: CLOB first, Gamma API fallback ───────────────────────
    const negRiskTasks = negRiskMarkets.map(m => {
        const tokenIds = Array.isArray(m.clob_token_ids) ? m.clob_token_ids : [];
        return { marketId: m.id, tokenId: tokenIds[0] || null, negRisk: true };
    });

    const negRiskResults = await mapConcurrent(negRiskTasks, CONCURRENCY, async ({ marketId, tokenId }) => {
        // Try CLOB first
        if (tokenId) {
            try {
                const book = await fetchBook(tokenId);
                const prices = extractBidAsk(book);
                // If book is liquid, use it
                if (prices.lastPrice !== null) return { marketId, ...prices, source: 'clob' };
            } catch { /* fall through to Gamma */ }
        }
        // Gamma API fallback for illiquid negRisk books
        const gammaPrices = await fetchNegRiskPriceFromGamma(marketId);
        if (gammaPrices) return { marketId, ...gammaPrices, source: 'gamma' };
        return { marketId, bestBid: null, bestAsk: null, lastPrice: null, source: 'none' };
    });

    // ── Batch update DB ───────────────────────────────────────────────────────
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const allResults = [...results, ...negRiskResults];
        const allTasks   = [...tasks, ...negRiskTasks];

        for (let i = 0; i < allResults.length; i++) {
            const settled = allResults[i];
            if (settled.status === 'rejected') {
                console.warn(`  Failed ${allTasks[i].marketId}: ${settled.reason?.message}`);
                failed++;
                continue;
            }
            const { marketId, bestBid, bestAsk, lastPrice, source } = settled.value;
            if (source === 'gamma') negRiskFallbacks++;

            if (lastPrice !== null) {
                await client.query(
                    `UPDATE polymarket_markets
                     SET best_bid = $1, best_ask = $2, last_price = $3, price_updated_at = $4
                     WHERE id = $5`,
                    [bestBid, bestAsk, lastPrice, now, marketId]
                );
            } else if (bestBid !== null || bestAsk !== null) {
                await client.query(
                    `UPDATE polymarket_markets
                     SET best_bid = $1, best_ask = $2, price_updated_at = $3
                     WHERE id = $4`,
                    [bestBid, bestAsk, now, marketId]
                );
            } else {
                // No prices at all — skip update to preserve existing data
                continue;
            }
            updated++;
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('DB update failed:', err.message);
        writeStatus({
            status: 'error', error: err.message,
            lastSync: new Date().toISOString(), durationSec: ((Date.now() - start) / 1000).toFixed(1),
            updated: 0, failed: 0, totalMarkets: markets.length,
            intervalMs: SYNC_INTERVAL_MS, nextSync: new Date(Date.now() + SYNC_INTERVAL_MS).toISOString(),
        });
        return;
    } finally {
        client.release();
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Done. ${updated} updated (${negRiskFallbacks} via Gamma fallback), ${failed} failed in ${elapsed}s`);
    writeStatus({
        status: failed > 0 && updated === 0 ? 'error' : 'ok',
        lastSync: new Date().toISOString(), durationSec: elapsed,
        updated, failed, negRiskFallbacks, totalMarkets: markets.length,
        intervalMs: SYNC_INTERVAL_MS, nextSync: new Date(Date.now() + SYNC_INTERVAL_MS).toISOString(),
    });
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
