/**
 * Test DB helpers — shared across all test suites.
 * Uses the real PostgreSQL DB but provides cleanup utilities.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const QUANTBOT_KEY    = 'finmolt_test_quantbot';
const MACROORACLE_KEY = 'finmolt_test_macrooracle';

// Well-known test agents
const TEST_AGENTS = {
  quantbot:    { key: QUANTBOT_KEY,    name: 'quantbot' },
  macrooracle: { key: MACROORACLE_KEY, name: 'macrooracle' },
};

// Active binary market for trading tests
const TEST_MARKET_ID = '1877547';   // Milavsky vs. Ficovich Set 1 - active, binary
const TEST_EVENT_ID  = '346298';    // parent event

/** Run a raw query on the real DB */
async function query(sql, params = []) {
  return pool.query(sql, params);
}

/** Get agent portfolio balance */
async function getBalance(agentName) {
  const { rows } = await pool.query(
    `SELECT ap.balance_usdc
       FROM agent_portfolios ap
       JOIN agents a ON a.id = ap.agent_id
      WHERE a.name = $1`,
    [agentName],
  );
  return rows.length > 0 ? parseFloat(rows[0].balance_usdc) : null;
}

/** Force-set agent portfolio balance (for test isolation) */
async function setBalance(agentName, amount) {
  await pool.query(
    `UPDATE agent_portfolios ap
        SET balance_usdc = $1, updated_at = NOW()
       FROM agents a
      WHERE a.id = ap.agent_id AND a.name = $2`,
    [amount, agentName],
  );
}

/** Remove all open positions for agent on a specific market */
async function clearPositions(agentName, marketId) {
  await pool.query(
    `DELETE FROM agent_positions ap
       USING agents a
       WHERE a.id = ap.agent_id
         AND a.name = $1
         AND ap.market_id = $2`,
    [agentName, marketId],
  );
}

/** Remove test trades for agent on a specific market */
async function clearTrades(agentName, marketId) {
  await pool.query(
    `DELETE FROM agent_trades at2
       USING agents a
       WHERE a.id = at2.agent_id
         AND a.name = $1
         AND at2.market_id = $2`,
    [agentName, marketId],
  );
}

/** Remove all test positions & trades for an agent on a market, then restore balance snapshot */
async function cleanupTrade(agentName, marketId, balanceSnapshot) {
  await clearTrades(agentName, marketId);
  await clearPositions(agentName, marketId);
  if (balanceSnapshot !== undefined) await setBalance(agentName, balanceSnapshot);
}

/** Create a temporary closed test market for settlement tests.
 *  Returns { eventId, marketId } — caller must call deleteTestMarket after test.
 */
async function createTestMarket({
  eventTitle   = 'TEST_EVENT',
  marketQuestion = 'TEST_MARKET_Q',
  outcomes       = ['Yes', 'No'],
  resolvedOutcome = null,
  closed          = false,
  active          = true,
  lastPrice       = 0.6,
}) {
  const eventId  = `test_evt_${Date.now()}`;
  const marketId = `test_mkt_${Date.now()}`;

  await pool.query(
    `INSERT INTO polymarket_events (id, slug, title, description, active, closed, neg_risk, fetched_at)
     VALUES ($1, $1, $2, '', $3, $4, false, NOW())`,
    [eventId, eventTitle, active, closed],
  );

  await pool.query(
    `INSERT INTO polymarket_markets
       (id, event_id, question, outcomes, active, closed, resolved_outcome,
        last_price, best_bid, best_ask, price_updated_at, fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $8, $8, NOW(), NOW())`,
    [
      marketId, eventId, marketQuestion,
      JSON.stringify(outcomes),
      active, closed, resolvedOutcome,
      lastPrice,
    ],
  );

  return { eventId, marketId };
}

/** Delete a temporary test market and its event */
async function deleteTestMarket(eventId, marketId) {
  // positions and trades will cascade delete
  if (marketId) {
    await pool.query('DELETE FROM polymarket_markets WHERE id = $1', [marketId]);
  }
  if (eventId) {
    await pool.query('DELETE FROM polymarket_events WHERE id = $1', [eventId]);
  }
}

/** Create agent positions for settlement tests */
async function createPosition(agentName, marketId, outcomeIdx, shares, avgCost) {
  const { rows: agentRows } = await pool.query(
    'SELECT id FROM agents WHERE name = $1', [agentName],
  );
  if (agentRows.length === 0) throw new Error(`Agent ${agentName} not found`);
  const agentId = agentRows[0].id;

  await pool.query(
    `INSERT INTO agent_positions (agent_id, market_id, outcome_idx, shares, avg_cost)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, market_id, outcome_idx) DO UPDATE
       SET shares = $4, avg_cost = $5, settled_at = NULL, updated_at = NOW()`,
    [agentId, marketId, outcomeIdx, shares, avgCost],
  );

  // Ensure portfolio row exists
  await pool.query(
    `INSERT INTO agent_portfolios (agent_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [agentId],
  );

  return agentId;
}

/** Close the pool (call in afterAll) */
async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  TEST_AGENTS,
  TEST_MARKET_ID,
  TEST_EVENT_ID,
  getBalance,
  setBalance,
  clearPositions,
  clearTrades,
  cleanupTrade,
  createTestMarket,
  deleteTestMarket,
  createPosition,
  closePool,
};
