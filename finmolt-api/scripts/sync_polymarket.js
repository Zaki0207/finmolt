#!/usr/bin/env node
// Fetches events + markets from Polymarket and upserts them into
// polymarket_events / polymarket_markets / polymarket_tags / polymarket_event_tags.
//
// Usage:
//   node scripts/sync_polymarket.js            # one-shot
//   node scripts/sync_polymarket.js --watch    # repeat every SYNC_INTERVAL_MS (default 10 min)

require('dotenv').config();
const { Pool } = require('pg');

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

    // Fetch recently closed events (catch resolutions — cap at 500 to keep sync fast)
    const closed = await fetchAllPages(
        { closed: 'true', order: 'id', ascending: 'false' },
        'closed',
        500
    );
    console.log(`Fetched ${closed.length} recently closed events`);

    // Deduplicate by id (active takes precedence)
    const seen = new Set();
    const merged = [];
    for (const e of [...active, ...closed]) {
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

    const updateSet = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
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

async function batchUpsertMarkets(client, allMarkets) {
    const cols = [
        'id', 'event_id', 'question', 'slug', 'description', 'image',
        'outcomes', 'group_item_title', 'neg_risk',
        'active', 'closed', 'resolved_outcome',
        'start_date', 'end_date', 'closed_time', 'fetched_at',
    ];
    const updateCols = [
        'question', 'slug', 'description', 'image',
        'outcomes', 'group_item_title', 'neg_risk',
        'active', 'closed', 'resolved_outcome',
        'start_date', 'end_date', 'closed_time', 'fetched_at',
    ];
    const now = new Date();

    for (let i = 0; i < allMarkets.length; i += BATCH_SIZE) {
        const batch = allMarkets.slice(i, i + BATCH_SIZE);
        const rows = batch.map(m => [
            m.id,
            m._eventId,
            m.question,
            m.slug || null,
            m.description || null,
            m.image || null,
            JSON.stringify(parseOutcomes(m.outcomes)),
            m.groupItemTitle || null,
            !!m.negRisk,
            m.active,
            m.closed,
            m.resolvedOutcome || null,
            m.startDate || null,
            m.endDate || null,
            m.closedTime || null,
            now,
        ]);
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
// Main sync
// ---------------------------------------------------------------------------

async function sync() {
    const start = Date.now();
    console.log(`[${new Date().toISOString()}] Starting Polymarket sync…`);

    let events, activeIds;
    try {
        const result = await fetchAllEvents();
        events = result.events;
        activeIds = result.activeIds;
    } catch (err) {
        console.error('Fetch failed:', err.message);
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

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Done. ${events.length} events, ${allMarkets.length} markets synced in ${elapsed}s`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('DB upsert failed:', err.message);
    } finally {
        client.release();
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
