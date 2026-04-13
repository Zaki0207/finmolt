#!/usr/bin/env node
// Fetches events + markets from Polymarket and upserts them into
// polymarket_events / polymarket_markets / polymarket_tags / polymarket_event_tags.
//
// Usage:
//   node scripts/sync_polymarket.js            # one-shot
//   node scripts/sync_polymarket.js --watch    # repeat every SYNC_INTERVAL_MS (default 10 min)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { validateSync } = require('./validate_sync');

const STATUS_FILE = process.env.SYNC_STATUS_FILE || null;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const POLYMARKET_BASE  = 'https://gamma-api.polymarket.com';
const PAGE_SIZE        = 100;
const BATCH_SIZE       = 500;   // rows per batch upsert
const SYNC_INTERVAL_MS = Number(process.env.POLYMARKET_SYNC_INTERVAL_MS) || 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Retry-aware fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetch with exponential-backoff retry on 429 / 5xx.
 * @param {string} url
 * @param {{ maxRetries?: number, signal?: AbortSignal }} [opts]
 */
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
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchPage(params, offset) {
    const url = new URL(`${POLYMARKET_BASE}/events`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('limit',  String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const res = await fetchWithRetry(url.toString());
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

async function fetchAllPages(params, label, maxEvents = Infinity) {
    const all = [];
    let offset = 0;

    while (all.length < maxEvents) {
        const page = await fetchPage(params, offset);
        all.push(...page);
        if (all.length % 500 < PAGE_SIZE) {
            console.log(`  [${label}] Fetched ${all.length} events (offset=${offset})`);
        }
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    return all.slice(0, maxEvents);
}

/**
 * Fetch closed events incrementally using the last-seen closedTime as cursor.
 * On the very first sync (no closed events in DB) falls back to capped full fetch.
 * On subsequent syncs fetches only events closed after the last watermark.
 */
async function fetchClosedEventsIncremental() {
    // Watermark = last time we successfully synced any closed event.
    // polymarket_events has no closed_time column, so we use fetched_at
    // (updated on every successful upsert) as a proxy for "last sync time".
    const { rows: wmRows } = await pool.query(`
        SELECT MAX(fetched_at) AS watermark
        FROM polymarket_events
        WHERE closed = true
    `);
    const watermark = wmRows[0]?.watermark;

    if (!watermark) {
        // First sync: full fetch capped at 2000 (covers more history than old 500 cap)
        console.log(`  [closed] No watermark — full fetch (cap 2000)`);
        return fetchAllPages(
            { closed: 'true', order: 'closedTime', ascending: 'false' },
            'closed',
            2000
        );
    }

    // Incremental: fetch newest-first (by closedTime from API response),
    // stop when we hit events whose closedTime predates our last sync.
    // Use SYNC_INTERVAL_MS as buffer so events that closed during the last
    // cycle aren't missed due to timing skew.
    const watermarkMs = new Date(watermark).getTime() - SYNC_INTERVAL_MS;
    const newClosed   = [];
    let offset = 0;

    while (true) {
        const page = await fetchPage(
            { closed: 'true', order: 'closedTime', ascending: 'false' },
            offset
        );
        if (page.length === 0) break;

        for (const event of page) {
            // closedTime comes from the API response (not from DB)
            const closedMs = event.closedTime ? new Date(event.closedTime).getTime() : Infinity;
            if (closedMs > watermarkMs) newClosed.push(event);
        }

        // Desc order: last element on the page = oldest closedTime on this page.
        // If it's before the watermark, all following pages will be too — stop.
        const oldest   = page[page.length - 1];
        const oldestMs = oldest?.closedTime ? new Date(oldest.closedTime).getTime() : 0;
        if (oldestMs <= watermarkMs) break;

        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    console.log(`  [closed] Incremental fetch: ${newClosed.length} new closed events`);
    return newClosed;
}

async function fetchAllEvents() {
    // Fetch active + open events
    const active = await fetchAllPages(
        { active: 'true', closed: 'false', order: 'id', ascending: 'false' },
        'active'
    );
    console.log(`Fetched ${active.length} active events`);

    // Fetch recently closed events (incremental cursor-based)
    const closed = await fetchClosedEventsIncremental();
    console.log(`Fetched ${closed.length} recently closed events`);

    // Fetch inactive-but-not-yet-closed events (recurring short-duration markets)
    const inactive = await fetchAllPages(
        { active: 'false', closed: 'false', order: 'id', ascending: 'false' },
        'inactive',
        500
    );
    console.log(`Fetched ${inactive.length} inactive (limbo) events`);

    // Deduplicate by id (active > inactive > closed precedence)
    const seen = new Set();
    const merged = [];
    for (const e of [...active, ...inactive, ...closed]) {
        if (!seen.has(e.id)) {
            seen.add(e.id);
            merged.push(e);
        }
    }
    return { events: merged, activeIds: active.map(e => e.id) };
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

function parseOutcomes(raw) {
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
}

/**
 * Build a multi-row INSERT ... ON CONFLICT DO UPDATE statement.
 */
function buildBatchUpsert(table, cols, rows, updateCols, conflictTarget) {
    const values = [];
    const valueClauses = [];
    let paramIdx = 1;

    for (const row of rows) {
        const placeholders = row.map(() => `$${paramIdx++}`);
        valueClauses.push(`(${placeholders.join(', ')})`);
        values.push(...row);
    }

    const priceProtectedCols = new Set(['last_price', 'price_updated_at', 'best_bid', 'best_ask']);
    const updateSet = updateCols.map(c =>
        priceProtectedCols.has(c)
            ? `${c} = COALESCE(EXCLUDED.${c}, ${table}.${c})`
            : `${c} = EXCLUDED.${c}`
    ).join(', ');
    const onConflict = updateCols.length > 0
        ? `ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateSet}`
        : `ON CONFLICT ${conflictTarget} DO NOTHING`;

    return {
        text: `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valueClauses.join(', ')} ${onConflict}`,
        values,
    };
}

async function batchUpsertEvents(client, events) {
    const cols = [
        'id', 'slug', 'title', 'description', 'image', 'icon',
        'neg_risk', 'active', 'closed', 'start_date', 'end_date', 'fetched_at',
    ];
    const updateCols = [
        'slug', 'title', 'description', 'image', 'icon',
        'neg_risk', 'active', 'closed', 'start_date', 'end_date', 'fetched_at',
    ];
    const now = new Date();

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
        const batch = events.slice(i, i + BATCH_SIZE);
        const rows = batch.map(e => {
            // active=true AND closed=true is valid for recurring events:
            // active = "series still running", closed = "this round ended".
            // Preserve Polymarket's original values without overriding.
            return [
                e.id,
                e.slug,
                e.title,
                e.description || null,
                e.image || null,
                e.icon || null,
                !!e.negRisk,
                e.active,
                e.closed,
                e.startDate || null,
                e.endDate || null,
                now,
            ];
        });
        const q = buildBatchUpsert('polymarket_events', cols, rows, updateCols, '(id)');
        await client.query(q.text, q.values);
    }
}

/**
 * Extract YES outcome price from the gamma API market object.
 */
function extractYesPrice(m) {
    try {
        const raw = m.outcomePrices;
        if (!raw) return null;
        const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
        const price = parseFloat(arr[0]);
        if (!isFinite(price)) return null;
        if (price === 0.5 && m.bestAsk == null && m.bestBid == null) return null;
        return price;
    } catch {
        return null;
    }
}

/**
 * Parse outcomePrices into a numeric array, returning null if unavailable.
 */
function parseOutcomePrices(m) {
    try {
        const raw = m.outcomePrices;
        if (!raw) return null;
        const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
        const prices = arr.map(p => parseFloat(p));
        if (prices.some(p => !isFinite(p))) return null;
        return prices;
    } catch {
        return null;
    }
}

async function batchUpsertMarkets(client, allMarkets) {
    const cols = [
        'id', 'event_id', 'question', 'slug', 'description', 'image',
        'outcomes', 'clob_token_ids', 'group_item_title', 'neg_risk',
        'active', 'closed', 'resolved_outcome',
        'start_date', 'end_date', 'closed_time', 'fetched_at',
        'best_bid', 'best_ask', 'last_price', 'price_updated_at', 'volume',
        'outcome_prices',
    ];
    const updateCols = [
        'question', 'slug', 'description', 'image',
        'outcomes', 'clob_token_ids', 'group_item_title', 'neg_risk',
        'active', 'closed', 'resolved_outcome',
        'start_date', 'end_date', 'closed_time', 'fetched_at',
        'best_bid', 'best_ask', 'last_price', 'price_updated_at', 'volume',
        'outcome_prices',
    ];
    const now = new Date();

    for (let i = 0; i < allMarkets.length; i += BATCH_SIZE) {
        const batch = allMarkets.slice(i, i + BATCH_SIZE);
        const rows = batch.map(m => {
            const yesPrice      = extractYesPrice(m);
            const outcomePricesArr = parseOutcomePrices(m);

            // Preserve Polymarket's active/closed as-is (recurring events use active=true, closed=true legitimately).

            // Derive resolved_outcome: prefer outcomePrices collapse over string matching
            let resolvedOutcome = m.resolvedOutcome || null;
            if (!resolvedOutcome && m.closed && outcomePricesArr) {
                const outcomes = parseOutcomes(m.outcomes);
                const winIdx   = outcomePricesArr.findIndex(p => p >= 0.99);
                if (winIdx !== -1 && outcomes[winIdx]) resolvedOutcome = outcomes[winIdx];
            }

            return [
                m.id,
                m._eventId,
                m.question,
                m.slug || null,
                m.description || null,
                m.image || null,
                JSON.stringify(parseOutcomes(m.outcomes)),
                JSON.stringify(parseOutcomes(m.clobTokenIds)),
                m.groupItemTitle || null,
                !!m.negRisk,
                m.active,
                m.closed,
                resolvedOutcome,
                m.startDate || null,
                m.endDate || null,
                m.closedTime || null,
                now,
                m.bestBid != null ? parseFloat(m.bestBid) : null,
                m.bestAsk != null ? parseFloat(m.bestAsk) : null,
                yesPrice,
                (m.bestBid != null || m.bestAsk != null || yesPrice !== null) ? now : null,
                m.volume   != null ? parseFloat(m.volume) : null,
                outcomePricesArr ? JSON.stringify(outcomePricesArr) : null,
            ];
        });
        const q = buildBatchUpsert('polymarket_markets', cols, rows, updateCols, '(id)');
        await client.query(q.text, q.values);
    }
}

async function batchUpsertTags(client, tagsMap) {
    const tags = Array.from(tagsMap.values());
    if (tags.length === 0) return;

    const cols = ['id', 'label', 'slug'];
    const updateCols = ['label', 'slug'];

    for (let i = 0; i < tags.length; i += BATCH_SIZE) {
        const batch = tags.slice(i, i + BATCH_SIZE);
        const rows = batch.map(t => [t.id, t.label, t.slug]);
        const q = buildBatchUpsert('polymarket_tags', cols, rows, updateCols, '(id)');
        await client.query(q.text, q.values);
    }
}

async function batchUpsertEventTags(client, eventTagPairs) {
    if (eventTagPairs.length === 0) return;

    const cols = ['event_id', 'tag_id'];

    for (let i = 0; i < eventTagPairs.length; i += BATCH_SIZE) {
        const batch = eventTagPairs.slice(i, i + BATCH_SIZE);
        const rows = batch.map(p => [p.eventId, p.tagId]);
        const q = buildBatchUpsert('polymarket_event_tags', cols, rows, [], '(event_id, tag_id)');
        await client.query(q.text, q.values);
    }
}

// ---------------------------------------------------------------------------
// Targeted re-sync: refresh markets that have open positions
// ---------------------------------------------------------------------------

async function refreshPositionMarkets() {
    const { rows } = await pool.query(`
        SELECT DISTINCT pm.event_id, pm.id AS market_id
        FROM agent_positions ap
        JOIN polymarket_markets pm ON pm.id = ap.market_id
        WHERE ap.settled_at IS NULL AND ap.shares > 0
    `);

    if (rows.length === 0) return;

    const eventIds = [...new Set(rows.map(r => r.event_id))];
    console.log(`[refresh] Re-fetching ${eventIds.length} event(s) with open positions…`);

    for (const eventId of eventIds) {
        try {
            const res = await fetchWithRetry(`${POLYMARKET_BASE}/events/${eventId}`);
            const event = await res.json();

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                await client.query(`
                    UPDATE polymarket_events
                    SET active = $1, closed = $2, fetched_at = NOW()
                    WHERE id = $3
                `, [event.active, event.closed, eventId]);

                for (const m of (event.markets || [])) {
                    const outcomePricesArr = parseOutcomePrices(m);

                    let resolvedOutcome = m.resolvedOutcome || null;
                    if (!resolvedOutcome && m.closed) {
                        if (outcomePricesArr) {
                            const outcomes = parseOutcomes(m.outcomes);
                            const winIdx   = outcomePricesArr.findIndex(p => p >= 0.99);
                            if (winIdx !== -1 && outcomes[winIdx]) resolvedOutcome = outcomes[winIdx];
                        }
                        // Legacy fallback: scan for price=1 string
                        if (!resolvedOutcome) {
                            try {
                                const prices  = Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices || '[]');
                                const outcomes = parseOutcomes(m.outcomes);
                                const winIdx  = prices.findIndex(p => parseFloat(p) === 1);
                                if (winIdx !== -1 && outcomes[winIdx]) resolvedOutcome = outcomes[winIdx];
                            } catch { /* ignore */ }
                        }
                    }

                    await client.query(`
                        UPDATE polymarket_markets
                        SET active           = $1,
                            closed           = $2,
                            closed_time      = $3,
                            resolved_outcome = $4,
                            outcome_prices   = $5,
                            fetched_at       = NOW()
                        WHERE id = $6
                    `, [
                        m.active,
                        m.closed,
                        m.closedTime || null,
                        resolvedOutcome,
                        outcomePricesArr ? JSON.stringify(outcomePricesArr) : null,
                        m.id,
                    ]);
                }

                await client.query('COMMIT');
                console.log(`  [refresh] Event ${eventId} (${event.title?.substring(0, 50)}): active=${event.active}, closed=${event.closed}`);
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                console.error(`  [refresh] Event ${eventId} DB update failed:`, err.message);
            } finally {
                client.release();
            }
        } catch (err) {
            console.error(`  [refresh] Event ${eventId} fetch failed:`, err.message);
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 6 — Market settlement
// ---------------------------------------------------------------------------

/**
 * Normalize a string for matching: lowercase, trim, remove punctuation.
 */
function normalizeOutcome(s) {
    return String(s).toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

/**
 * Settle all unsettled positions for resolved & closed markets.
 *
 * Priority for winner determination:
 *   1. outcomePrices[idx] ≥ 0.99 (price collapsed to 1 = winner)
 *   2. Normalized string match against resolved_outcome
 *   3. Binary market: last_price ≥ 0.99 → YES won; ≤ 0.01 → NO won
 *
 * Multi-choice payout: uses outcomePrices[outcomeIdx] so each outcome
 * receives the correct settlement fraction (not just 0 or 1).
 */
async function settleMarkets() {
    const { rows: markets } = await pool.query(`
        SELECT pm.id, pm.resolved_outcome, pm.outcomes, pm.outcome_prices, pm.question,
               pm.last_price, pm.best_bid, pm.best_ask
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
        const outcomes = Array.isArray(market.outcomes)
            ? market.outcomes
            : JSON.parse(market.outcomes || '[]');

        // Parse stored outcome_prices (may be null for older records)
        let settlementPrices = null;
        if (market.outcome_prices) {
            try {
                settlementPrices = Array.isArray(market.outcome_prices)
                    ? market.outcome_prices
                    : JSON.parse(market.outcome_prices);
            } catch { /* ignore */ }
        }

        // ── Determine winning index ───────────────────────────────────────────

        let winningIdx = -1;

        // Priority 1: outcomePrices collapse (price ≥ 0.99 = winner)
        if (settlementPrices) {
            winningIdx = settlementPrices.findIndex(p => p >= 0.99);
        }

        // Priority 2: normalized string match against resolved_outcome
        if (winningIdx === -1 && market.resolved_outcome) {
            const needle = normalizeOutcome(market.resolved_outcome);
            winningIdx = outcomes.findIndex(o => normalizeOutcome(o) === needle);
        }

        // Priority 3: binary market last_price fallback
        if (winningIdx === -1 && outcomes.length === 2) {
            const price = parseFloat(market.last_price ?? market.best_ask ?? market.best_bid ?? 'NaN');
            if (price >= 0.99) winningIdx = 0;       // YES won
            else if (price <= 0.01) winningIdx = 1;  // NO won
        }

        if (winningIdx === -1 && !settlementPrices) {
            console.warn(
                `  [settle] Market ${market.id}: cannot determine winner ` +
                `(resolved_outcome="${market.resolved_outcome}", no outcomePrices) — skipping`
            );
            continue;
        }

        // ── Settle positions ──────────────────────────────────────────────────

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
                const idx = Number(pos.outcome_idx);
                const shares = parseFloat(pos.shares);
                const avgCost = parseFloat(pos.avg_cost);

                // Payout per share:
                // - If outcomePrices available: use the stored settlement price for this outcome
                // - Otherwise: winner-takes-all (1 or 0)
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

                // Audit ledger entry
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

            const label     = (market.question || market.id).substring(0, 60);
            const winnerStr = winningIdx !== -1 ? `winner=${outcomes[winningIdx]}(idx ${winningIdx})` : 'multi-price settlement';
            console.log(`  [settle] "${label}…" ${winnerStr}, settled ${positions.length} position(s)`);
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
    console.log(`[${new Date().toISOString()}] Starting Polymarket sync…`);
    writeStatus({ status: 'syncing', startedAt: new Date().toISOString(), intervalMs: SYNC_INTERVAL_MS });

    let events, activeIds;
    try {
        const result = await fetchAllEvents();
        events   = result.events;
        activeIds = result.activeIds;
    } catch (err) {
        console.error('Fetch failed:', err.message);
        writeStatus({
            status: 'error', error: err.message,
            lastSync: new Date().toISOString(), durationSec: ((Date.now() - start) / 1000).toFixed(1),
            intervalMs: SYNC_INTERVAL_MS, nextSync: new Date(Date.now() + SYNC_INTERVAL_MS).toISOString(),
        });
        return;
    }

    console.log(`Fetched ${events.length} total events. Upserting in chunks…`);

    const allMarkets = [];
    const tagsMap = new Map();
    const eventTagPairs = [];
    const eventIdsWithTags = new Set();

    for (const event of events) {
        for (const market of (event.markets || [])) {
            market._eventId = event.id;
            allMarkets.push(market);
        }
        for (const tag of (event.tags || [])) {
            if (!tag.id) continue;
            tagsMap.set(tag.id, { id: tag.id, label: tag.label, slug: tag.slug });
            eventTagPairs.push({ eventId: event.id, tagId: tag.id });
            eventIdsWithTags.add(event.id);
        }
    }

    const CHUNK  = 1000;
    const client = await pool.connect();

    try {
        // Tags
        await client.query('BEGIN');
        await batchUpsertTags(client, tagsMap);
        await client.query('COMMIT');
        console.log(`Upserted ${tagsMap.size} tags`);

        // Events
        for (let i = 0; i < events.length; i += CHUNK) {
            const chunk = events.slice(i, i + CHUNK);
            await client.query('BEGIN');
            try {
                await batchUpsertEvents(client, chunk);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`Event chunk ${i}-${i + chunk.length} failed:`, err.message);
            }
        }
        console.log(`Upserted ${events.length} events`);

        // Markets
        for (let i = 0; i < allMarkets.length; i += CHUNK) {
            const chunk = allMarkets.slice(i, i + CHUNK);
            await client.query('BEGIN');
            try {
                await batchUpsertMarkets(client, chunk);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`Market chunk ${i}-${i + chunk.length} failed:`, err.message);
            }
        }
        console.log(`Upserted ${allMarkets.length} markets`);

        // Event-tag junction
        await client.query('BEGIN');
        if (eventIdsWithTags.size > 0) {
            await client.query(
                `DELETE FROM polymarket_event_tags WHERE event_id = ANY($1::varchar[])`,
                [Array.from(eventIdsWithTags)]
            );
        }
        await batchUpsertEventTags(client, eventTagPairs);
        await client.query('COMMIT');
        console.log(`Upserted ${eventTagPairs.length} event-tag associations`);

        // Stale event sweep:
        // Only mark events as inactive if they were absent AND currently open (closed=false)
        // AND have no open agent positions.
        // Recurring events with active=true AND closed=true are intentionally excluded:
        // they represent series between rounds and should not be swept to active=false.
        if (activeIds.length > 0) {
            await client.query('BEGIN');
            await client.query(`
                UPDATE polymarket_events
                SET active = false, fetched_at = NOW()
                WHERE active = true
                  AND closed = false
                  AND id != ALL($1::varchar[])
                  AND id NOT IN (
                      SELECT DISTINCT pm.event_id
                      FROM agent_positions ap
                      JOIN polymarket_markets pm ON pm.id = ap.market_id
                      WHERE ap.settled_at IS NULL AND ap.shares > 0
                  )
            `, [activeIds]);
            await client.query('COMMIT');
        }

        // Targeted refresh for markets with open positions
        await refreshPositionMarkets();

        // Settlement
        const settledCount = await settleMarkets();
        if (settledCount > 0) {
            console.log(`Settlement complete: ${settledCount} position(s) settled`);
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Done. ${events.length} events, ${allMarkets.length} markets synced in ${elapsed}s`);
        writeStatus({
            status: 'ok', lastSync: new Date().toISOString(), durationSec: elapsed,
            events: events.length, markets: allMarkets.length, settled: settledCount || 0,
            intervalMs: SYNC_INTERVAL_MS, nextSync: new Date(Date.now() + SYNC_INTERVAL_MS).toISOString(),
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('DB upsert failed:', err.message);
        writeStatus({
            status: 'error', error: err.message,
            lastSync: new Date().toISOString(), durationSec: ((Date.now() - start) / 1000).toFixed(1),
            intervalMs: SYNC_INTERVAL_MS, nextSync: new Date(Date.now() + SYNC_INTERVAL_MS).toISOString(),
        });
    } finally {
        client.release();
    }

    try {
        await validateSync(pool);
    } catch (err) {
        console.error('[validate] Validation failed (non-fatal):', err.message);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const watchMode = process.argv.includes('--watch');

sync().then(() => {
    if (watchMode) {
        console.log(`Watch mode: next sync in ${SYNC_INTERVAL_MS / 1000}s`);
        setInterval(sync, SYNC_INTERVAL_MS);
    } else {
        pool.end();
    }
}).catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
