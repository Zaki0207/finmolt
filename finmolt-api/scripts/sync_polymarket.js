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

const POLYMARKET_BASE   = 'https://gamma-api.polymarket.com';
const PAGE_SIZE         = 100;
const BATCH_SIZE        = 500;   // rows per batch upsert
const SYNC_INTERVAL_MS  = Number(process.env.POLYMARKET_SYNC_INTERVAL_MS) || 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchPage(params, offset) {
    const url = new URL(`${POLYMARKET_BASE}/events`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('limit',  String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Polymarket HTTP ${res.status} at offset ${offset}`);
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

async function fetchAllEvents() {
    // Fetch active + open events (the bulk — same as original filter)
    const active = await fetchAllPages(
        { active: 'true', closed: 'false', order: 'id', ascending: 'false' },
        'active'
    );
    console.log(`Fetched ${active.length} active events`);

    // Fetch recently closed events (catch resolutions — cap at 500 to keep sync fast).
    // Sort by closedTime desc so the most recently closed events are always captured
    // within the cap, regardless of how many total closed events exist.
    const closed = await fetchAllPages(
        { closed: 'true', order: 'closedTime', ascending: 'false' },
        'closed',
        500
    );
    console.log(`Fetched ${closed.length} recently closed events`);

    // Fetch inactive-but-not-yet-closed events (e.g. recurring 5-min markets that
    // have expired: event.active=false, event.closed=false). These fall through both
    // queries above but their individual markets may have closed=true on the API.
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
 * @param {string} table
 * @param {string[]} cols - column names
 * @param {Array<Array>} rows - array of value arrays (one per row)
 * @param {string[]} updateCols - columns to update on conflict
 * @param {string} conflictTarget - e.g. '(id)' or '(event_id, tag_id)'
 * @returns {{ text: string, values: any[] }}
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

    const updateSet = updateCols.map(c =>
        // Use COALESCE so a null from EXCLUDED never overwrites an existing value.
        // This prevents sync_polymarket from wiping prices written by sync_prices.
        // Must qualify the fallback column with the table name to avoid ambiguity.
        c === 'last_price' || c === 'price_updated_at' || c === 'best_bid' || c === 'best_ask'
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
        const rows = batch.map(e => [
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
        ]);
        const q = buildBatchUpsert('polymarket_events', cols, rows, updateCols, '(id)');
        await client.query(q.text, q.values);
    }
}

/**
 * Extract YES outcome price from the gamma API market object.
 * The gamma API returns outcomePrices as a JSON string like '["0.54","0.46"]'
 * or already as an array. Index 0 = YES token price (≈ best_ask).
 */
function extractYesPrice(m) {
    try {
        const raw = m.outcomePrices;
        if (!raw) return null;
        const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
        const price = parseFloat(arr[0]);
        if (!isFinite(price)) return null;
        // 0.5 is Polymarket's default placeholder for markets with no real trades.
        // Only accept it if bestAsk or bestBid confirm there's a real order book.
        if (price === 0.5 && m.bestAsk == null && m.bestBid == null) return null;
        return price;
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
    ];
    const updateCols = [
        'question', 'slug', 'description', 'image',
        'outcomes', 'clob_token_ids', 'group_item_title', 'neg_risk',
        'active', 'closed', 'resolved_outcome',
        'start_date', 'end_date', 'closed_time', 'fetched_at',
        'best_bid', 'best_ask', 'last_price', 'price_updated_at', 'volume',
    ];
    const now = new Date();

    for (let i = 0; i < allMarkets.length; i += BATCH_SIZE) {
        const batch = allMarkets.slice(i, i + BATCH_SIZE);
        const rows = batch.map(m => {
            const yesPrice = extractYesPrice(m);
            // Derive resolved_outcome from outcomePrices collapse (0/1) when not explicit
            let resolvedOutcome = m.resolvedOutcome || null;
            if (!resolvedOutcome && m.closed) {
                try {
                    const prices   = Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices || '[]');
                    const outcomes = parseOutcomes(m.outcomes);
                    const winIdx   = prices.findIndex(p => parseFloat(p) === 1);
                    if (winIdx !== -1 && outcomes[winIdx]) resolvedOutcome = outcomes[winIdx];
                } catch { /* ignore */ }
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
                m.volume   != null ? parseFloat(m.volume)   : null,
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

/**
 * For every market that has unsettled agent positions, fetch the current
 * status directly from the Gamma API (/events/:id) and update the DB.
 * This is necessary because the Polymarket list API caps at 500 results,
 * which is not enough to cover the volume of recurring short-duration markets.
 */
async function refreshPositionMarkets() {
    // Find distinct event IDs that have unsettled positions
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
            const res = await fetch(`${POLYMARKET_BASE}/events/${eventId}`);
            if (!res.ok) {
                console.warn(`  [refresh] Event ${eventId}: HTTP ${res.status}`);
                continue;
            }
            const event = await res.json();

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Update event row
                await client.query(`
                    UPDATE polymarket_events
                    SET active = $1, closed = $2, fetched_at = NOW()
                    WHERE id = $3
                `, [event.active, event.closed, eventId]);

                // Update each market nested in the event
                for (const m of (event.markets || [])) {
                    // Derive resolved_outcome from outcomePrices if not explicitly set.
                    // Polymarket recurring markets collapse prices to "0"/"1" on resolution
                    // instead of writing resolvedOutcome. Price "1" = winning outcome.
                    let resolvedOutcome = m.resolvedOutcome || null;
                    if (!resolvedOutcome && m.closed) {
                        try {
                            const prices  = Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices || '[]');
                            const outcomes = parseOutcomes(m.outcomes);
                            const winIdx  = prices.findIndex(p => parseFloat(p) === 1);
                            if (winIdx !== -1 && outcomes[winIdx]) {
                                resolvedOutcome = outcomes[winIdx];
                            }
                        } catch { /* ignore parse errors */ }
                    }

                    await client.query(`
                        UPDATE polymarket_markets
                        SET active           = $1,
                            closed           = $2,
                            closed_time      = $3,
                            resolved_outcome = $4,
                            fetched_at       = NOW()
                        WHERE id = $5
                    `, [
                        m.active,
                        m.closed,
                        m.closedTime || null,
                        resolvedOutcome,
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
 * Settle all unsettled positions for resolved & closed markets.
 * One transaction per market so row-level locks stay short.
 * Returns total number of positions settled.
 */
async function settleMarkets() {
    const { rows: markets } = await pool.query(`
        SELECT pm.id, pm.resolved_outcome, pm.outcomes, pm.question,
               pm.last_price, pm.best_bid, pm.best_ask
        FROM polymarket_markets pm
        WHERE pm.resolved_outcome IS NOT NULL
          AND pm.closed = true
          AND EXISTS (
              SELECT 1 FROM agent_positions ap
              WHERE ap.market_id = pm.id
                AND ap.settled_at IS NULL
                AND ap.shares > 0
          )
    `);

    if (markets.length === 0) return 0;

    console.log(`[settle] ${markets.length} resolved market(s) with unsettled positions`);

    let totalSettled = 0;

    for (const market of markets) {
        const outcomes = Array.isArray(market.outcomes)
            ? market.outcomes
            : JSON.parse(market.outcomes || '[]');

        let winningIdx = outcomes.findIndex(o =>
            String(o).toLowerCase().trim() === String(market.resolved_outcome).toLowerCase().trim()
        );

        // Fallback: for binary markets, infer winner from stored price (last_price ≈ 1.0 → YES won)
        if (winningIdx === -1 && outcomes.length === 2) {
            const price = parseFloat(market.last_price ?? market.best_ask ?? market.best_bid ?? 'NaN');
            if (price >= 0.99) winningIdx = 0;        // YES won
            else if (price <= 0.01) winningIdx = 1;   // NO won
        }

        if (winningIdx === -1) {
            console.warn(
                `  [settle] Market ${market.id}: resolved_outcome "${market.resolved_outcome}" ` +
                `not found in ${JSON.stringify(outcomes)} — skipping`
            );
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
                const isWinner     = Number(pos.outcome_idx) === winningIdx;
                const payout       = parseFloat(pos.shares) * (isWinner ? 1.0 : 0.0);
                const realisedPnl  = parseFloat(pos.shares) * ((isWinner ? 1.0 : 0.0) - parseFloat(pos.avg_cost));

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
            }

            await client.query('COMMIT');

            const label = (market.question || market.id).substring(0, 60);
            console.log(
                `  [settle] "${label}…" winner=${outcomes[winningIdx]}(idx ${winningIdx}),` +
                ` settled ${positions.length} position(s)`
            );
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
        events = result.events;
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

    // Collect all markets, tags, and event-tag pairs
    const allMarkets = [];
    const tagsMap = new Map();       // tag.id → { id, label, slug }
    const eventTagPairs = [];        // { eventId, tagId }
    const eventIdsWithTags = new Set();

    for (const event of events) {
        // Markets
        for (const market of (event.markets || [])) {
            market._eventId = event.id;
            allMarkets.push(market);
        }
        // Tags
        for (const tag of (event.tags || [])) {
            if (!tag.id) continue;
            tagsMap.set(tag.id, { id: tag.id, label: tag.label, slug: tag.slug });
            eventTagPairs.push({ eventId: event.id, tagId: tag.id });
            eventIdsWithTags.add(event.id);
        }
    }

    // Process in chunked transactions
    const CHUNK = 1000;
    const client = await pool.connect();

    try {
        // --- Transaction 1: Upsert tags (small, fast) ---
        await client.query('BEGIN');
        await batchUpsertTags(client, tagsMap);
        await client.query('COMMIT');
        console.log(`Upserted ${tagsMap.size} tags`);

        // --- Transaction 2: Upsert events in chunks ---
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

        // --- Transaction 3: Upsert markets in chunks ---
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

        // --- Transaction 4: Upsert event-tag junction ---
        await client.query('BEGIN');
        // Delete old associations for events we're updating, then re-insert
        if (eventIdsWithTags.size > 0) {
            await client.query(
                `DELETE FROM polymarket_event_tags WHERE event_id = ANY($1::varchar[])`,
                [Array.from(eventIdsWithTags)]
            );
        }
        await batchUpsertEventTags(client, eventTagPairs);
        await client.query('COMMIT');
        console.log(`Upserted ${eventTagPairs.length} event-tag associations`);

        // --- Transaction 5: Mark stale events ---
        if (activeIds.length > 0) {
            await client.query('BEGIN');
            await client.query(`
                UPDATE polymarket_events
                SET active = false, fetched_at = NOW()
                WHERE active = true
                  AND id != ALL($1::varchar[])
            `, [activeIds]);
            await client.query('COMMIT');
        }

        // --- Targeted refresh: re-fetch markets with open positions to get latest status ---
        await refreshPositionMarkets();

        // --- Settlement: resolve positions for closed/resolved markets ---
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

    // Post-sync validation: check for data anomalies, auto-correct where safe,
    // and write a sync health report to sync-health.json.
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
