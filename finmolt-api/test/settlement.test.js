/**
 * 结算测试套件
 * 覆盖 TEST_PLAN.md §3 — ST 系列
 *
 * 使用真实 DB：创建临时测试 market / positions，运行 settleMarkets()，验证结果，清理数据。
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const db = require('./helpers/db');

// Import settlement logic directly
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Inline-replicate settleMarkets() so we can call it in tests ──────────────

function parseOutcomes(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function normalizeOutcome(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

async function settleMarket(marketRow) {
  const outcomes = parseOutcomes(marketRow.outcomes);

  let settlementPrices = null;
  if (marketRow.outcome_prices) {
    try {
      settlementPrices = Array.isArray(marketRow.outcome_prices)
        ? marketRow.outcome_prices
        : JSON.parse(marketRow.outcome_prices);
    } catch { /* ignore */ }
  }

  let winningIdx = -1;
  if (settlementPrices) {
    winningIdx = settlementPrices.findIndex(p => p >= 0.99);
  }
  if (winningIdx === -1 && marketRow.resolved_outcome) {
    const needle = normalizeOutcome(marketRow.resolved_outcome);
    winningIdx = outcomes.findIndex(o => normalizeOutcome(o) === needle);
  }
  if (winningIdx === -1 && outcomes.length === 2) {
    const price = parseFloat(marketRow.last_price ?? 'NaN');
    if (price >= 0.99) winningIdx = 0;
    else if (price <= 0.01) winningIdx = 1;
  }

  if (winningIdx === -1 && !settlementPrices) return { settled: 0, winningIdx: -1 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: positions } = await client.query(`
      SELECT id, agent_id, outcome_idx, shares, avg_cost
        FROM agent_positions
       WHERE market_id = $1 AND settled_at IS NULL AND shares > 0
       FOR UPDATE
    `, [marketRow.id]);

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
    }

    await client.query('COMMIT');
    return { settled: positions.length, winningIdx };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getPosition(agentName, marketId, outcomeIdx) {
  const { rows } = await db.query(`
    SELECT ap.shares, ap.avg_cost, ap.realised_pnl, ap.settled_at
      FROM agent_positions ap
      JOIN agents a ON a.id = ap.agent_id
     WHERE a.name = $1 AND ap.market_id = $2 AND ap.outcome_idx = $3
  `, [agentName, marketId, outcomeIdx]);
  return rows[0] || null;
}

async function getBalance(agentName) {
  return db.getBalance(agentName);
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe('settleMarkets() — 结算逻辑', () => {
  let eventId, marketId;
  let qbotId, macroId;
  let qbotBalance0, macroBalance0;

  beforeAll(async () => {
    // Fetch agent IDs
    const { rows: r1 } = await db.query('SELECT id FROM agents WHERE name=$1', ['quantbot']);
    const { rows: r2 } = await db.query('SELECT id FROM agents WHERE name=$1', ['macrooracle']);
    qbotId  = r1[0].id;
    macroId = r2[0].id;
  });

  beforeEach(async () => {
    qbotBalance0  = await getBalance('quantbot');
    macroBalance0 = await getBalance('macrooracle');
  });

  afterEach(async () => {
    // Cleanup test market
    if (marketId) {
      await db.query('DELETE FROM agent_positions WHERE market_id=$1', [marketId]);
      await db.query('DELETE FROM agent_trades   WHERE market_id=$1', [marketId]);
    }
    await db.deleteTestMarket(eventId, marketId);
    eventId = null;
    marketId = null;
    // Restore balances
    await db.setBalance('quantbot',    qbotBalance0);
    await db.setBalance('macrooracle', macroBalance0);
  });

  test('ST-01 二元市场 YES 赢: Agent 持有 YES → payout = shares * 1.0', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'Yes',
      closed: true, active: false,
      lastPrice: 1.0,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 0, 10, 0.6);

    const balBefore = await getBalance('quantbot');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);

    const balAfter = await getBalance('quantbot');
    const pos = await getPosition('quantbot', marketId, 0);

    expect(parseFloat(balAfter) - parseFloat(balBefore)).toBeCloseTo(10, 4); // payout = 10*1.0
    expect(parseFloat(pos.realised_pnl)).toBeCloseTo(10 * (1 - 0.6), 4);   // 4.0
    expect(parseFloat(pos.shares)).toBe(0);
    expect(pos.settled_at).not.toBeNull();
  });

  test('ST-02 二元市场 YES 赢: Agent 持有 NO → payout = 0', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'Yes',
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 1, 10, 0.4); // NO position

    const balBefore = await getBalance('quantbot');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);

    const balAfter = await getBalance('quantbot');
    const pos = await getPosition('quantbot', marketId, 1);

    expect(parseFloat(balAfter)).toBeCloseTo(parseFloat(balBefore), 4); // no payout
    expect(parseFloat(pos.realised_pnl)).toBeCloseTo(-4, 4); // 10*(0 - 0.4)
    expect(parseFloat(pos.shares)).toBe(0);
  });

  test('ST-03 二元市场 NO 赢: 结算方向反转', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'No',
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    // Agent A holds NO (should win), Agent B holds YES (should lose)
    await db.createPosition('quantbot',    marketId, 1, 10, 0.4); // NO
    await db.createPosition('macrooracle', marketId, 0, 10, 0.6); // YES

    const qbotBefore  = await getBalance('quantbot');
    const macroBefore = await getBalance('macrooracle');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);

    const qbotAfter  = await getBalance('quantbot');
    const macroAfter = await getBalance('macrooracle');

    // quantbot (NO) should receive payout
    expect(parseFloat(qbotAfter) - parseFloat(qbotBefore)).toBeCloseTo(10, 3);
    // macrooracle (YES) should receive 0
    expect(parseFloat(macroAfter)).toBeCloseTo(parseFloat(macroBefore), 3);
  });

  test('ST-05 resolved_outcome 大小写不敏感匹配', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'yes', // lowercase
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 0, 5, 0.5);
    const balBefore = await getBalance('quantbot');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);

    const balAfter = await getBalance('quantbot');
    expect(parseFloat(balAfter) - parseFloat(balBefore)).toBeCloseTo(5, 4);
  });

  test('ST-07 resolved_outcome=NULL, closed=true → 不结算', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: null,
      closed: true, active: false,
      lastPrice: 0.5, // ambiguous
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 0, 5, 0.5);
    const balBefore = await getBalance('quantbot');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    const result = await settleMarket(mktRow);
    const balAfter = await getBalance('quantbot');

    // Should not settle — balance unchanged and settled=0
    expect(result.settled).toBe(0);
    expect(parseFloat(balAfter)).toBeCloseTo(parseFloat(balBefore), 4);
  });

  test('ST-08 已结算的 position 不被重复结算', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'Yes',
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    const agentId = await db.createPosition('quantbot', marketId, 0, 5, 0.5);

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    // First settlement
    const r1 = await settleMarket(mktRow);
    const balAfterFirst = await getBalance('quantbot');

    // Second settlement attempt
    const r2 = await settleMarket(mktRow);
    const balAfterSecond = await getBalance('quantbot');

    expect(r1.settled).toBe(1);
    expect(r2.settled).toBe(0); // nothing to settle
    expect(parseFloat(balAfterSecond)).toBeCloseTo(parseFloat(balAfterFirst), 4);
  });

  test('ST-09 结算后 balance_usdc 增加 payout', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'Yes',
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 0, 20, 0.5);
    const balBefore = await getBalance('quantbot');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);
    const balAfter = await getBalance('quantbot');

    expect(parseFloat(balAfter) - parseFloat(balBefore)).toBeCloseTo(20, 4);
  });

  test('ST-10 结算后 position.shares=0, settled_at!=NULL', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'Yes',
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 0, 7, 0.4);

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);

    const pos = await getPosition('quantbot', marketId, 0);
    expect(parseFloat(pos.shares)).toBe(0);
    expect(pos.settled_at).not.toBeNull();
  });

  test('ST-11 多 Agent 在同一市场独立结算', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: 'Yes',
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot',    marketId, 0, 10, 0.6); // YES winner
    await db.createPosition('macrooracle', marketId, 1, 10, 0.4); // NO loser

    const qbotBefore  = await getBalance('quantbot');
    const macroBefore = await getBalance('macrooracle');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    const result = await settleMarket(mktRow);
    expect(result.settled).toBe(2);

    const qbotAfter  = await getBalance('quantbot');
    const macroAfter = await getBalance('macrooracle');

    expect(parseFloat(qbotAfter)  - parseFloat(qbotBefore)).toBeCloseTo(10, 3); // payout
    expect(parseFloat(macroAfter)).toBeCloseTo(parseFloat(macroBefore), 3);     // no payout
  });

  test('ST-04 多选市场 (3+ outcomes): 只有 winningIdx 赢', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Candidate A', 'Candidate B', 'Candidate C'],
      resolvedOutcome: 'Candidate B', // winner
      closed: true, active: false,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot',    marketId, 1, 10, 0.5); // wins
    await db.createPosition('macrooracle', marketId, 0, 10, 0.3); // loses

    const qbotBefore  = await getBalance('quantbot');
    const macroBefore = await getBalance('macrooracle');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);

    const qbotAfter  = await getBalance('quantbot');
    const macroAfter = await getBalance('macrooracle');

    expect(parseFloat(qbotAfter) - parseFloat(qbotBefore)).toBeCloseTo(10, 3);
    expect(parseFloat(macroAfter)).toBeCloseTo(parseFloat(macroBefore), 3);
  });

  test('ST-14 price fallback: last_price≥0.99 → 推断 YES 赢', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: null,
      closed: true, active: false,
      lastPrice: 0.995,
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 0, 5, 0.5); // YES
    const balBefore = await getBalance('quantbot');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    await settleMarket(mktRow);
    const balAfter = await getBalance('quantbot');

    // With last_price ≥ 0.99, fallback infers YES wins → payout
    expect(parseFloat(balAfter) - parseFloat(balBefore)).toBeCloseTo(5, 3);
  });

  test('ST-15 price fallback: last_price=0.5 → 不结算', async () => {
    const mkt = await db.createTestMarket({
      outcomes: ['Yes', 'No'],
      resolvedOutcome: null,
      closed: true, active: false,
      lastPrice: 0.5, // ambiguous
    });
    eventId  = mkt.eventId;
    marketId = mkt.marketId;

    await db.createPosition('quantbot', marketId, 0, 5, 0.5);
    const balBefore = await getBalance('quantbot');

    const mktRow = (await db.query(
      `SELECT id, event_id, resolved_outcome, outcomes::text AS outcomes,
              outcome_prices, last_price, best_bid, best_ask, closed
         FROM polymarket_markets WHERE id=$1`,
      [marketId],
    )).rows[0];

    const result = await settleMarket(mktRow);
    const balAfter = await getBalance('quantbot');

    expect(result.settled).toBe(0);
    expect(parseFloat(balAfter)).toBeCloseTo(parseFloat(balBefore), 4);
  });
});

afterAll(async () => {
  await pool.end();
});
