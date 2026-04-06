#!/usr/bin/env node
/**
 * Post-sync data integrity validator for Polymarket data.
 *
 * Checks for known anomalies, logs warnings with specifics,
 * auto-corrects where safe, and writes a sync health report.
 *
 * Known bug patterns this module guards against:
 *   1. negRisk price nullification  — negRisk markets excluded from CLOB sync,
 *      can end up with all price fields null if Gamma API also returns nothing.
 *   2. Pagination cap dropping markets — closed/inactive fetches capped at 500;
 *      markets beyond the cap keep stale active/closed status in DB.
 *   3. Closed events still marked active — stale-event sweep sets active=false
 *      but not closed=true; contradictory event/market states can persist.
 *   4. Settlement fields in wrong keys — resolvedOutcome may be missing or
 *      under a different key; price-collapse fallback only works for binary markets.
 *
 * Usage:
 *   node scripts/validate_sync.js          # standalone
 *   const { validateSync } = require('./validate_sync');
 *   await validateSync(pool);              # called from sync_polymarket.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const POLYMARKET_BASE  = 'https://gamma-api.polymarket.com';
// Issue #25: write report to /tmp so it doesn't pollute the repo,
// or override via SYNC_HEALTH_FILE env var.
const REPORT_PATH      = process.env.SYNC_HEALTH_FILE || path.join('/tmp', 'finmolt-sync-health.json');
const MAX_AUTOCORRECT  = 30;  // max markets to re-fetch per run

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * BUG: negRisk price nullification
 * negRisk markets are excluded from CLOB price sync (sync_prices.js line 90).
 * They rely on Gamma API's bestBid/bestAsk/outcomePrices. If those are also
 * absent (common for negRisk markets), all price fields stay null permanently.
 */
async function checkNegRiskNullPrices(db) {
    const { rows } = await db.query(`
        SELECT id, event_id, question, active, closed, fetched_at
        FROM polymarket_markets
        WHERE neg_risk = true
          AND active   = true
          AND closed   = false
          AND best_bid   IS NULL
          AND best_ask   IS NULL
          AND last_price IS NULL
        ORDER BY fetched_at DESC
        LIMIT 100
    `);
    return {
        name: 'negrisk_null_prices',
        severity: rows.length > 0 ? 'warn' : 'ok',
        count: rows.length,
        markets: rows,
        description: 'Active negRisk markets with all price fields null ' +
            '(excluded from CLOB sync; Gamma API also returned no price)',
    };
}

/**
 * BUG: closed events still marked active (contradictory market state)
 * active=true AND closed=true is logically invalid. This happens when
 * the stale-event sweep runs but a race between queries leaves the market
 * row inconsistent.
 */
async function checkContradictoryMarketState(db) {
    const { rows } = await db.query(`
        SELECT id, event_id, question, active, closed
        FROM polymarket_markets
        WHERE active = true AND closed = true
        LIMIT 100
    `);
    return {
        name: 'contradictory_market_state',
        severity: rows.length > 0 ? 'warn' : 'ok',
        count: rows.length,
        markets: rows,
        description: 'Markets with active=true AND closed=true simultaneously (contradictory)',
    };
}

/**
 * BUG: closed events still marked active (at the event level)
 */
async function checkContradictoryEventState(db) {
    const { rows } = await db.query(`
        SELECT id, slug, title, active, closed
        FROM polymarket_events
        WHERE active = true AND closed = true
        LIMIT 100
    `);
    return {
        name: 'contradictory_event_state',
        severity: rows.length > 0 ? 'warn' : 'ok',
        count: rows.length,
        events: rows,
        description: 'Events with active=true AND closed=true simultaneously',
    };
}

/**
 * BUG: pagination limits dropping markets
 * Markets with open positions that are in "limbo" (active=false, closed=false)
 * — these may have slipped through the 500-cap on inactive/closed fetches.
 */
async function checkLimboMarketsWithPositions(db) {
    const { rows } = await db.query(`
        SELECT DISTINCT pm.id, pm.event_id, pm.question, pm.active, pm.closed
        FROM polymarket_markets pm
        JOIN agent_positions ap ON ap.market_id = pm.id
        WHERE pm.active    = false
          AND pm.closed    = false
          AND ap.settled_at IS NULL
          AND ap.shares     > 0
        LIMIT 100
    `);
    return {
        name: 'limbo_markets_with_positions',
        severity: rows.length > 0 ? 'warn' : 'ok',
        count: rows.length,
        markets: rows,
        description: 'Markets in limbo (active=false, closed=false) with unsettled agent positions ' +
            '— may have been dropped by pagination cap',
    };
}

/**
 * BUG: settlement fields in wrong response keys
 * resolved_outcome is set but closed=false means the settlement key was read
 * before the market actually finalized, or the closed flag was never updated.
 */
async function checkResolvedButNotClosed(db) {
    const { rows } = await db.query(`
        SELECT id, event_id, question, resolved_outcome, closed, active
        FROM polymarket_markets
        WHERE resolved_outcome IS NOT NULL
          AND closed = false
        LIMIT 100
    `);
    return {
        name: 'resolved_not_closed',
        severity: rows.length > 0 ? 'warn' : 'ok',
        count: rows.length,
        markets: rows,
        description: 'Markets with resolved_outcome set but closed=false ' +
            '— settlement key may have been read prematurely or closed flag lagging',
    };
}

/**
 * Markets with open positions that have resolved_outcome=NULL and closed=true
 * — settlement data may be missing due to wrong API key mapping.
 */
async function checkClosedWithPositionsNoOutcome(db) {
    const { rows } = await db.query(`
        SELECT DISTINCT pm.id, pm.event_id, pm.question, pm.resolved_outcome,
               pm.outcomes, pm.closed, pm.active
        FROM polymarket_markets pm
        JOIN agent_positions ap ON ap.market_id = pm.id
        WHERE pm.closed           = true
          AND pm.resolved_outcome IS NULL
          AND ap.settled_at       IS NULL
          AND ap.shares           > 0
        LIMIT 50
    `);
    return {
        name: 'closed_positions_no_outcome',
        severity: rows.length > 0 ? 'warn' : 'ok',
        count: rows.length,
        markets: rows,
        description: 'Closed markets with unsettled positions but no resolved_outcome ' +
            '— settlement key likely missing or wrong (BUG: settlement fields in wrong response keys)',
    };
}

/**
 * Stale prices: active non-negRisk markets with price data > 30 min old.
 * Indicates CLOB sync may have failed or rate-limited.
 */
async function checkStalePrices(db) {
    const { rows } = await db.query(`
        SELECT id, question, price_updated_at, neg_risk, active
        FROM polymarket_markets
        WHERE active     = true
          AND closed     = false
          AND neg_risk   = false
          AND clob_token_ids != '[]'::jsonb
          AND clob_token_ids IS NOT NULL
          AND (price_updated_at IS NULL
               OR price_updated_at < NOW() - INTERVAL '30 minutes')
        ORDER BY price_updated_at ASC NULLS FIRST
        LIMIT 50
    `);
    return {
        name: 'stale_prices',
        severity: rows.length > 10 ? 'warn' : rows.length > 0 ? 'info' : 'ok',
        count: rows.length,
        // Only include minimal sample in report to keep it readable
        sample: rows.slice(0, 5).map(r => ({
            id: r.id,
            question: (r.question || '').substring(0, 80),
            price_updated_at: r.price_updated_at,
        })),
        description: 'Active non-negRisk markets with CLOB price data older than 30 minutes',
    };
}

/**
 * BUG: pagination limits dropping markets
 * If closed event count approaches 500, the next sync will miss some.
 */
async function checkPaginationRisk(db) {
    const { rows: [row] } = await db.query(
        `SELECT COUNT(*) AS count FROM polymarket_events WHERE closed = true`
    );
    const count = parseInt(row.count, 10);
    return {
        name: 'pagination_risk_closed_events',
        severity: count > 400 ? 'warn' : 'ok',
        count,
        description: `${count} closed events in DB (sync fetch cap = 500). ` +
            'When total closed > 500, recently-closed events may be missed.',
    };
}

// ---------------------------------------------------------------------------
// Auto-corrections (safe only)
// ---------------------------------------------------------------------------

async function fixContradictoryMarkets(db, markets) {
    if (markets.length === 0) return 0;
    const ids = markets.map(m => m.id);
    const { rowCount } = await db.query(`
        UPDATE polymarket_markets
        SET active = false, fetched_at = NOW()
        WHERE id = ANY($1::varchar[])
          AND active = true AND closed = true
    `, [ids]);
    return rowCount || 0;
}

async function fixContradictoryEvents(db, events) {
    if (events.length === 0) return 0;
    const ids = events.map(e => e.id);
    const { rowCount } = await db.query(`
        UPDATE polymarket_events
        SET active = false, fetched_at = NOW()
        WHERE id = ANY($1::varchar[])
          AND active = true AND closed = true
    `, [ids]);
    return rowCount || 0;
}

/**
 * Re-fetch negRisk markets with null prices from Gamma API.
 * Safe: read-only from API, only updates rows that currently have null prices.
 */
async function refetchNegRiskPrices(db, markets) {
    if (markets.length === 0) return 0;

    // Group by event_id to minimise API calls
    const byEvent = {};
    for (const m of markets) {
        (byEvent[m.event_id] = byEvent[m.event_id] || []).push(m.id);
    }

    const targetIds = new Set(markets.map(m => m.id));
    let fixed = 0;

    for (const [eventId, _marketIds] of Object.entries(byEvent)) {
        try {
            const res = await fetch(`${POLYMARKET_BASE}/events/${eventId}`);
            if (!res.ok) {
                console.warn(`  [validate][refetch] Event ${eventId}: HTTP ${res.status}`);
                continue;
            }
            const event = await res.json();

            for (const m of (event.markets || [])) {
                if (!targetIds.has(m.id)) continue;

                // Extract YES price from outcomePrices
                let yesPrice = null;
                try {
                    const raw = m.outcomePrices;
                    if (raw) {
                        const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
                        const p = parseFloat(arr[0]);
                        // Skip Polymarket placeholder 0.5 with no real order book
                        if (isFinite(p) && !(p === 0.5 && m.bestAsk == null && m.bestBid == null)) {
                            yesPrice = p;
                        }
                    }
                } catch { /* ignore */ }

                const bestBid = m.bestBid != null ? parseFloat(m.bestBid) : null;
                const bestAsk = m.bestAsk != null ? parseFloat(m.bestAsk) : null;

                if (bestBid !== null || bestAsk !== null || yesPrice !== null) {
                    await db.query(`
                        UPDATE polymarket_markets
                        SET best_bid   = COALESCE($1, best_bid),
                            best_ask   = COALESCE($2, best_ask),
                            last_price = COALESCE($3, last_price),
                            fetched_at = NOW()
                        WHERE id = $4
                          AND best_bid IS NULL AND best_ask IS NULL AND last_price IS NULL
                    `, [bestBid, bestAsk, yesPrice, m.id]);
                    fixed++;
                }
            }
        } catch (err) {
            console.warn(`  [validate][refetch] Event ${eventId} failed: ${err.message}`);
        }
    }

    return fixed;
}

/**
 * Re-fetch closed markets with positions but no resolved_outcome.
 * Attempts to resolve the settlement outcome from the fresh Gamma API response.
 */
async function refetchClosedOutcomes(db, markets) {
    if (markets.length === 0) return 0;

    const byEvent = {};
    for (const m of markets) {
        (byEvent[m.event_id] = byEvent[m.event_id] || []).push(m.id);
    }

    const targetIds = new Set(markets.map(m => m.id));
    let fixed = 0;

    for (const [eventId] of Object.entries(byEvent)) {
        try {
            const res = await fetch(`${POLYMARKET_BASE}/events/${eventId}`);
            if (!res.ok) continue;
            const event = await res.json();

            for (const m of (event.markets || [])) {
                if (!targetIds.has(m.id)) continue;

                // Try explicit resolvedOutcome first
                let resolvedOutcome = m.resolvedOutcome || null;

                // Fallback: collapse from outcomePrices (price = 1.0 → winner)
                if (!resolvedOutcome && m.closed) {
                    try {
                        const prices   = Array.isArray(m.outcomePrices)
                            ? m.outcomePrices
                            : JSON.parse(m.outcomePrices || '[]');
                        const outcomes = Array.isArray(m.outcomes)
                            ? m.outcomes
                            : JSON.parse(m.outcomes || '[]');
                        const winIdx = prices.findIndex(p => parseFloat(p) === 1);
                        if (winIdx !== -1 && outcomes[winIdx]) {
                            resolvedOutcome = outcomes[winIdx];
                        }
                    } catch { /* ignore */ }
                }

                if (resolvedOutcome) {
                    await db.query(`
                        UPDATE polymarket_markets
                        SET resolved_outcome = $1,
                            closed           = true,
                            active           = false,
                            fetched_at       = NOW()
                        WHERE id = $2
                          AND resolved_outcome IS NULL
                    `, [resolvedOutcome, m.id]);
                    fixed++;
                }
            }
        } catch (err) {
            console.warn(`  [validate][refetch-outcome] Event ${eventId} failed: ${err.message}`);
        }
    }

    return fixed;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run all checks, log warnings, apply safe auto-corrections, write health report.
 *
 * @param {import('pg').Pool} [poolArg]  Pass the caller's pool to reuse connections.
 * @returns {Promise<object>}            The health report object.
 */
async function validateSync(poolArg) {
    const db        = poolArg || new Pool({ connectionString: process.env.DATABASE_URL });
    const ownPool   = !poolArg;
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] [validate] Running post-sync data integrity checks…`);

    // Run all checks in parallel
    let checks;
    try {
        checks = await Promise.all([
            checkNegRiskNullPrices(db),
            checkContradictoryMarketState(db),
            checkContradictoryEventState(db),
            checkLimboMarketsWithPositions(db),
            checkResolvedButNotClosed(db),
            checkClosedWithPositionsNoOutcome(db),
            checkStalePrices(db),
            checkPaginationRisk(db),
        ]);
    } catch (err) {
        console.error(`  [validate] Check queries failed: ${err.message}`);
        if (ownPool) await db.end().catch(() => {});
        return null;
    }

    const warnings        = [];
    const autocorrections = [];
    const checkSummary    = {};

    for (const c of checks) {
        const { name, severity, count, description } = c;
        checkSummary[name] = { severity, count, description };

        if (severity === 'warn') {
            // Build a concise sample string for the warning line
            const sample = c.markets
                ? c.markets.slice(0, 3).map(m => m.id).join(', ')
                : c.events
                    ? c.events.slice(0, 3).map(e => e.id).join(', ')
                    : '';
            const sampleStr = sample ? ` (sample: ${sample})` : '';
            console.warn(`  [validate][WARN] ${description}: ${count}${sampleStr}`);
            warnings.push({ check: name, count, description });
        } else if (severity === 'info') {
            console.log(`  [validate][INFO] ${description}: ${count}`);
        }
    }

    // Destructure for use in auto-corrections
    const [
        negRiskNull,
        contradictoryMarkets,
        contradictoryEvents,
        _limbo,
        _resolvedNotClosed,
        closedNoOutcome,
    ] = checks;

    // Auto-correction 1: markets with active=true AND closed=true → set active=false
    if (contradictoryMarkets.count > 0) {
        try {
            const n = await fixContradictoryMarkets(db, contradictoryMarkets.markets);
            if (n > 0) {
                console.log(`  [validate][FIX] Set active=false for ${n} markets with contradictory state`);
                autocorrections.push({ type: 'contradictory_markets_fixed', count: n });
            }
        } catch (err) {
            console.error(`  [validate][FIX-ERR] Market contradictory fix failed: ${err.message}`);
        }
    }

    // Auto-correction 2: events with active=true AND closed=true → set active=false
    if (contradictoryEvents.count > 0) {
        try {
            const n = await fixContradictoryEvents(db, contradictoryEvents.events);
            if (n > 0) {
                console.log(`  [validate][FIX] Set active=false for ${n} events with contradictory state`);
                autocorrections.push({ type: 'contradictory_events_fixed', count: n });
            }
        } catch (err) {
            console.error(`  [validate][FIX-ERR] Event contradictory fix failed: ${err.message}`);
        }
    }

    // Auto-correction 3: re-fetch negRisk markets with null prices from Gamma API
    const toRefetch = negRiskNull.markets.slice(0, MAX_AUTOCORRECT);
    if (toRefetch.length > 0) {
        console.log(`  [validate] Re-fetching ${toRefetch.length} negRisk markets with null prices…`);
        try {
            const n = await refetchNegRiskPrices(db, toRefetch);
            if (n > 0) {
                console.log(`  [validate][FIX] Recovered prices for ${n} negRisk markets`);
                autocorrections.push({ type: 'negrisk_prices_recovered', count: n });
            } else {
                console.log(`  [validate] Re-fetch complete — Gamma API also returned no prices for these markets`);
            }
        } catch (err) {
            console.error(`  [validate][FIX-ERR] negRisk refetch failed: ${err.message}`);
        }
    }

    // Auto-correction 4: re-fetch closed markets missing resolved_outcome
    const toResolve = closedNoOutcome.markets.slice(0, MAX_AUTOCORRECT);
    if (toResolve.length > 0) {
        console.log(`  [validate] Re-fetching resolved_outcome for ${toResolve.length} closed markets with positions…`);
        try {
            const n = await refetchClosedOutcomes(db, toResolve);
            if (n > 0) {
                console.log(`  [validate][FIX] Resolved outcome recovered for ${n} markets`);
                autocorrections.push({ type: 'resolved_outcome_recovered', count: n });
            }
        } catch (err) {
            console.error(`  [validate][FIX-ERR] Outcome refetch failed: ${err.message}`);
        }
    }

    // Build and write health report
    const elapsed = Date.now() - startTime;
    const report = {
        timestamp,
        elapsed_ms:    elapsed,
        status:        warnings.length === 0 ? 'healthy' : 'warnings',
        warning_count: warnings.length,
        autocorrection_count: autocorrections.length,
        warnings,
        autocorrections,
        checks: checkSummary,
    };

    try {
        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    } catch (err) {
        console.error(`  [validate] Could not write health report: ${err.message}`);
    }

    const statusLabel = warnings.length === 0
        ? 'healthy'
        : `${warnings.length} warning(s)`;
    const fixLabel = autocorrections.length > 0
        ? `, ${autocorrections.length} auto-correction(s) applied`
        : '';
    console.log(`  [validate] Done in ${elapsed}ms — ${statusLabel}${fixLabel}. Report: ${REPORT_PATH}`);

    if (ownPool) await db.end().catch(() => {});

    return report;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
    validateSync()
        .then(report => {
            if (!report) process.exit(1);
            console.log('\nSync Health Summary');
            console.log(`  Status      : ${report.status}`);
            console.log(`  Warnings    : ${report.warning_count}`);
            console.log(`  Auto-fixes  : ${report.autocorrection_count}`);
            console.log(`  Report path : ${REPORT_PATH}`);
        })
        .catch(err => {
            console.error('Fatal:', err.message);
            process.exit(1);
        });
}

module.exports = { validateSync };
