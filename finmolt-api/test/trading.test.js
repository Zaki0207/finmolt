/**
 * 交易 API 测试套件
 * 覆盖 TEST_PLAN.md §2 — B / SL / PF / T / L / MP 系列
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const app     = require('../src/app');
const db      = require('./helpers/db');

const QBOT  = db.TEST_AGENTS.quantbot;
const MACRO = db.TEST_AGENTS.macrooracle;
const MARKET_ID = db.TEST_MARKET_ID; // '1877547' active binary

// ─── housekeeping ─────────────────────────────────────────────────────────────

let qbotBalance0;
let macroBalance0;

beforeAll(async () => {
  qbotBalance0  = await db.getBalance(QBOT.name);
  macroBalance0 = await db.getBalance(MACRO.name);
  // Give both agents a clean 500 USDC slate for the trading tests
  await db.setBalance(QBOT.name,  500);
  await db.setBalance(MACRO.name, 500);
});

afterAll(async () => {
  // Clean up any positions left on the test market
  await db.clearPositions(QBOT.name,  MARKET_ID);
  await db.clearPositions(MACRO.name, MARKET_ID);
  await db.clearTrades(QBOT.name,  MARKET_ID);
  await db.clearTrades(MACRO.name, MARKET_ID);
  // Restore original balances
  await db.setBalance(QBOT.name,  qbotBalance0);
  await db.setBalance(MACRO.name, macroBalance0);
  await db.closePool();
});

// ─── §2.1  POST /trading/buy ──────────────────────────────────────────────────

describe('POST /trading/buy', () => {
  afterEach(async () => {
    // Reset after each buy test so balance is predictable
    await db.clearPositions(QBOT.name, MARKET_ID);
    await db.clearTrades(QBOT.name, MARKET_ID);
    await db.setBalance(QBOT.name, 500);
  });

  test('B-01 正常买入 YES (idx=0): 余额充足', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 10 });

    expect(res.status).toBe(201);
    expect(res.body.trade).toBeDefined();
    expect(res.body.trade.side).toBe('buy');
    expect(res.body.trade.shares).toBe(10);
    expect(res.body.position).toBeDefined();
    expect(res.body.position.shares).toBe(10);
    expect(res.body.balance).toBeLessThan(500);
  });

  test('B-02 正常买入 NO (idx=1): 价格应为 1 - best_bid', async () => {
    // Fetch current best_bid dynamically to avoid stale-price failures
    const { rows: mktRows } = await db.query(
      'SELECT best_bid FROM polymarket_markets WHERE id=$1', [MARKET_ID],
    );
    const bestBid = mktRows[0] ? parseFloat(mktRows[0].best_bid) : null;

    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 1, shares: 5 });

    expect(res.status).toBe(201);
    expect(res.body.trade.outcomeIdx).toBe(1);

    const execPrice = res.body.executionPrice;
    expect(execPrice).toBeGreaterThan(0);
    expect(execPrice).toBeLessThan(1);

    // The raw price should equal 1 - best_bid (complement) if prices are fresh
    if (!res.body.stalePrice && bestBid != null) {
      const rawPrice = res.body.rawPrice;
      const expectedNoPrice = parseFloat((1 - bestBid).toFixed(6));
      expect(rawPrice).toBeCloseTo(expectedNoPrice, 4);
    }
  });

  test('B-03 余额不足', async () => {
    await db.setBalance(QBOT.name, 0.5); // far too little
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient balance/i);
    expect(res.body.balance).toBeDefined();
    expect(res.body.required).toBeDefined();
    await db.setBalance(QBOT.name, 500);
  });

  test('B-04 市场不存在 → 404', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: 'nonexistent_market_xyz', outcomeIdx: 0, shares: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/market not found/i);
  });

  test('B-07 outcomeIdx 超出范围 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 99, shares: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/out of range/i);
  });

  test('B-08 shares=0 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 0 });

    // NOTE: shares=0 is falsy in JS so the API treats it as "missing" and returns
    // "marketId, outcomeIdx and shares are required" (known behavior — !shares is true for 0)
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('B-08 shares 负数 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive number/i);
  });

  test('B-09 缺少必要参数 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID });

    expect(res.status).toBe(400);
  });

  test('B-11 重复买入同一 market+outcome: shares 累加', async () => {
    // First buy
    await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 10 });

    // Second buy
    const res2 = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 5 });

    expect(res2.status).toBe(201);
    expect(res2.body.position.shares).toBeCloseTo(15, 2);
  });

  test('B-12 加权平均成本计算', async () => {
    // Manually set up positions via direct DB to test avg_cost formula precisely
    const { rows: agentRows } = await db.query(
      'SELECT id FROM agents WHERE name = $1', [QBOT.name],
    );
    const agentId = agentRows[0].id;

    // Insert a position: 10 shares @ 0.6
    await db.query(`
      INSERT INTO agent_positions (agent_id, market_id, outcome_idx, shares, avg_cost)
      VALUES ($1, $2, 0, 10, 0.6)
      ON CONFLICT (agent_id, market_id, outcome_idx) DO UPDATE
        SET shares=10, avg_cost=0.6, settled_at=NULL
    `, [agentId, MARKET_ID]);
    await db.setBalance(QBOT.name, 500);

    // Buy 20 more: the API will use current market price, not 0.8.
    // So we just check the weighted avg formula logic in isolation:
    // new_avg = (10*0.6 + 20*price) / 30
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 20 });

    expect(res.status).toBe(201);
    expect(res.body.position.shares).toBeCloseTo(30, 2);
    // avg_cost must be a valid price between 0 and 1
    expect(res.body.position.avgCost).toBeGreaterThan(0);
    expect(res.body.position.avgCost).toBeLessThan(1);
    // weighted avg: (10*0.6 + 20*execPrice) / 30
    const execPrice = res.body.executionPrice;
    const expectedAvg = (10 * 0.6 + 20 * execPrice) / 30;
    expect(res.body.position.avgCost).toBeCloseTo(expectedAvg, 4);
  });

  test('B-15 未认证请求 → 401', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 1 });

    expect(res.status).toBe(401);
  });

  test('B-16 买入后 balance_after 字段与 portfolio 一致', async () => {
    const res = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 5 });

    expect(res.status).toBe(201);
    const portfolioRes = await request(app)
      .get('/api/v1/trading/portfolio')
      .set('Authorization', `Bearer ${QBOT.key}`);

    expect(portfolioRes.body.balance).toBeCloseTo(res.body.balance, 4);
  });

  test('B-05 市场已关闭 → 400', async () => {
    // Create a closed market
    const { eventId, marketId } = await db.createTestMarket({
      closed: true, active: false, resolvedOutcome: 'Yes',
    });

    try {
      const res = await request(app)
        .post('/api/v1/trading/buy')
        .set('Authorization', `Bearer ${QBOT.key}`)
        .send({ marketId, outcomeIdx: 0, shares: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not active/i);
    } finally {
      await db.deleteTestMarket(eventId, marketId);
    }
  });
});

// ─── §2.2  POST /trading/sell ─────────────────────────────────────────────────

describe('POST /trading/sell', () => {
  let snapshotBalance;

  beforeEach(async () => {
    // Reset positions and set clean balance
    await db.clearPositions(QBOT.name, MARKET_ID);
    await db.clearTrades(QBOT.name, MARKET_ID);
    await db.setBalance(QBOT.name, 500);

    // Buy some shares first so sell tests have something to work with
    const buyRes = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 20 });
    expect(buyRes.status).toBe(201);
    snapshotBalance = buyRes.body.balance;
  });

  afterEach(async () => {
    await db.clearPositions(QBOT.name, MARKET_ID);
    await db.clearTrades(QBOT.name, MARKET_ID);
    await db.setBalance(QBOT.name, 500);
  });

  test('SL-01 正常卖出全部持仓', async () => {
    const res = await request(app)
      .post('/api/v1/trading/sell')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 20 });

    expect(res.status).toBe(200);
    expect(res.body.trade.side).toBe('sell');
    expect(res.body.position.shares).toBeCloseTo(0, 4);
    expect(res.body.balance).toBeGreaterThan(snapshotBalance);
  });

  test('SL-02 部分卖出: shares 减少', async () => {
    const res = await request(app)
      .post('/api/v1/trading/sell')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 10 });

    expect(res.status).toBe(200);
    expect(res.body.position.shares).toBeCloseTo(10, 2);
  });

  test('SL-04 卖出数量超过持仓 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/trading/sell')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient shares/i);
    expect(res.body.held).toBeDefined();
    expect(res.body.requested).toBeDefined();
  });

  test('SL-05 无持仓时卖出 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/trading/sell')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 1, shares: 5 }); // idx=1, no positions

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient shares/i);
  });

  test('SL-06 市场已关闭 → 400 with settlement message', async () => {
    const { eventId, marketId } = await db.createTestMarket({
      closed: true, active: false, resolvedOutcome: 'Yes',
    });
    try {
      const res = await request(app)
        .post('/api/v1/trading/sell')
        .set('Authorization', `Bearer ${QBOT.key}`)
        .send({ marketId, outcomeIdx: 0, shares: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/closed|settled/i);
    } finally {
      await db.deleteTestMarket(eventId, marketId);
    }
  });

  test('SL-07 盈利卖出: realisedPnl > 0', async () => {
    // If sell price > avg_cost, pnl is positive
    // buy price ≈ best_ask (0.57), sell price ≈ best_bid (0.47)
    // In this specific market, the bid is usually < ask, so selling right after buying
    // will likely produce negative pnl due to spread.
    // We just verify the realisedPnl field exists and has the correct sign.
    const buyRes = await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 5 });
    const buyPrice = buyRes.body.executionPrice;

    // Force a position with very low avg_cost to guarantee profit
    const { rows: agentRows } = await db.query('SELECT id FROM agents WHERE name = $1', [QBOT.name]);
    const agentId = agentRows[0].id;
    await db.query(
      `UPDATE agent_positions SET avg_cost = 0.1
       WHERE agent_id = $1 AND market_id = $2 AND outcome_idx = 0`,
      [agentId, MARKET_ID],
    );

    const sellRes = await request(app)
      .post('/api/v1/trading/sell')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 5 });

    expect(sellRes.status).toBe(200);
    expect(sellRes.body.realisedPnl).toBeGreaterThan(0);
  });

  test('SL-08 亏损卖出: realisedPnl < 0', async () => {
    // Force avg_cost = 0.99 (very high), sell at current market bid
    const { rows: agentRows } = await db.query('SELECT id FROM agents WHERE name = $1', [QBOT.name]);
    const agentId = agentRows[0].id;
    await db.query(
      `UPDATE agent_positions SET avg_cost = 0.99
       WHERE agent_id = $1 AND market_id = $2 AND outcome_idx = 0`,
      [agentId, MARKET_ID],
    );

    const sellRes = await request(app)
      .post('/api/v1/trading/sell')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 5 });

    expect(sellRes.status).toBe(200);
    expect(sellRes.body.realisedPnl).toBeLessThan(0);
  });
});

// ─── §2.3  GET /trading/portfolio ────────────────────────────────────────────

describe('GET /trading/portfolio', () => {
  afterAll(async () => {
    await db.clearPositions(MACRO.name, MARKET_ID);
    await db.clearTrades(MACRO.name, MARKET_ID);
    await db.setBalance(MACRO.name, 500);
  });

  test('PF-01 空 portfolio (新鲜余额)', async () => {
    const res = await request(app)
      .get('/api/v1/trading/portfolio')
      .set('Authorization', `Bearer ${MACRO.key}`);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBeDefined();
    expect(Array.isArray(res.body.positions)).toBe(true);
    expect(Array.isArray(res.body.settledPositions)).toBe(true);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.totalValue).toBeDefined();
  });

  test('PF-02 有 open positions: currentPrice 和 unrealisedPnl 存在', async () => {
    await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${MACRO.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 10 });

    const res = await request(app)
      .get('/api/v1/trading/portfolio')
      .set('Authorization', `Bearer ${MACRO.key}`);

    expect(res.status).toBe(200);
    expect(res.body.positions.length).toBeGreaterThan(0);
    const pos = res.body.positions.find(p => p.marketId === MARKET_ID);
    expect(pos).toBeDefined();
    expect(pos.currentPrice).toBeDefined();
    expect(pos.unrealisedPnl).toBeDefined();
  });

  test('PF-06 summary.totalValue = balance + positionsValue', async () => {
    const res = await request(app)
      .get('/api/v1/trading/portfolio')
      .set('Authorization', `Bearer ${MACRO.key}`);

    const { balance, positions, summary } = res.body;
    const positionsValue = positions.reduce((sum, p) => {
      if (p.currentPrice != null) return sum + p.currentPrice * p.shares;
      return sum + p.avgCost * p.shares;
    }, 0);

    expect(summary.totalValue).toBeCloseTo(balance + positionsValue, 2);
  });

  test('PF-08 marketClosed 标志: 关闭市场的持仓应有 marketClosed=true', async () => {
    const { eventId, marketId } = await db.createTestMarket({
      closed: true, active: false, resolvedOutcome: 'Yes',
    });
    try {
      // Manually create a position in a closed market
      const { rows: agentRows } = await db.query('SELECT id FROM agents WHERE name = $1', [MACRO.name]);
      const agentId = agentRows[0].id;

      // Set settled_at to NULL so it shows up in open positions
      await db.query(`
        INSERT INTO agent_positions (agent_id, market_id, outcome_idx, shares, avg_cost)
        VALUES ($1, $2, 0, 5, 0.5)
        ON CONFLICT (agent_id, market_id, outcome_idx) DO UPDATE
          SET shares=5, avg_cost=0.5, settled_at=NULL
      `, [agentId, marketId]);

      const res = await request(app)
        .get('/api/v1/trading/portfolio')
        .set('Authorization', `Bearer ${MACRO.key}`);

      const pos = res.body.positions.find(p => p.marketId === marketId);
      // This position is in a closed market, so marketClosed should be true
      expect(pos).toBeDefined();
      expect(pos.marketClosed).toBe(true);
    } finally {
      await db.query('DELETE FROM agent_positions WHERE market_id=$1', [marketId]);
      await db.deleteTestMarket(eventId, marketId);
    }
  });

  test('PF-15 未认证请求 → 401', async () => {
    const res = await request(app).get('/api/v1/trading/portfolio');
    expect(res.status).toBe(401);
  });
});

// ─── §2.4  GET /trading/portfolio/trades ─────────────────────────────────────

describe('GET /trading/portfolio/trades', () => {
  beforeAll(async () => {
    // Create a trade for trade history tests
    await db.setBalance(QBOT.name, 500);
    await db.clearPositions(QBOT.name, MARKET_ID);
    await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 3 });
  });

  afterAll(async () => {
    await db.clearPositions(QBOT.name, MARKET_ID);
    await db.clearTrades(QBOT.name, MARKET_ID);
    await db.setBalance(QBOT.name, 500);
  });

  test('T-01 获取交易历史: 按时间降序返回', async () => {
    const res = await request(app)
      .get('/api/v1/trading/portfolio/trades')
      .set('Authorization', `Bearer ${QBOT.key}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();

    // Verify ordering by checking timestamps
    const trades = res.body.data;
    for (let i = 1; i < trades.length; i++) {
      expect(new Date(trades[i - 1].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(trades[i].createdAt).getTime());
    }
  });

  test('T-02 分页: limit/offset 生效', async () => {
    const res1 = await request(app)
      .get('/api/v1/trading/portfolio/trades?limit=1&offset=0')
      .set('Authorization', `Bearer ${QBOT.key}`);
    const res2 = await request(app)
      .get('/api/v1/trading/portfolio/trades?limit=1&offset=1')
      .set('Authorization', `Bearer ${QBOT.key}`);

    expect(res1.body.data.length).toBe(1);
    expect(res2.body.pagination.offset).toBe(1);
  });

  test('T-03 limit 上限 100', async () => {
    const res = await request(app)
      .get('/api/v1/trading/portfolio/trades?limit=200')
      .set('Authorization', `Bearer ${QBOT.key}`);

    expect(res.body.data.length).toBeLessThanOrEqual(100);
  });
});

// ─── §2.5  GET /trading/leaderboard ──────────────────────────────────────────

describe('GET /trading/leaderboard', () => {
  test('L-01 多 Agent 排名: 按 totalValue 降序', async () => {
    const res = await request(app).get('/api/v1/trading/leaderboard');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const data = res.body.data;
    for (let i = 1; i < data.length; i++) {
      expect(data[i - 1].totalValue).toBeGreaterThanOrEqual(data[i].totalValue);
    }
    // Every entry has a rank
    data.forEach((entry, idx) => expect(entry.rank).toBe(idx + 1));
  });

  test('L-02 Agent 包含 positionCount 字段', async () => {
    const res = await request(app).get('/api/v1/trading/leaderboard');
    res.body.data.forEach(e => {
      expect(e.positionCount).toBeDefined();
      expect(typeof e.positionCount).toBe('number');
    });
  });

  test('L-04 最多 50 条', async () => {
    const res = await request(app).get('/api/v1/trading/leaderboard');
    expect(res.body.data.length).toBeLessThanOrEqual(50);
  });
});

// ─── §2.6  GET /trading/markets/:marketId/positions ──────────────────────────

describe('GET /trading/markets/:marketId/positions', () => {
  beforeAll(async () => {
    await db.setBalance(QBOT.name, 500);
    await db.clearPositions(QBOT.name, MARKET_ID);
    await request(app)
      .post('/api/v1/trading/buy')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 8 });
  });

  afterAll(async () => {
    await db.clearPositions(QBOT.name, MARKET_ID);
    await db.clearTrades(QBOT.name, MARKET_ID);
    await db.setBalance(QBOT.name, 500);
  });

  test('MP-01 有持仓: 返回 agent positions', async () => {
    const res = await request(app)
      .get(`/api/v1/trading/markets/${MARKET_ID}/positions`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    const pos = res.body.data[0];
    expect(pos.shares).toBeDefined();
    expect(pos.agentName).toBeDefined();
  });

  test('MP-02 无持仓市场: data 为空', async () => {
    const { eventId, marketId } = await db.createTestMarket({});
    try {
      const res = await request(app)
        .get(`/api/v1/trading/markets/${marketId}/positions`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    } finally {
      await db.deleteTestMarket(eventId, marketId);
    }
  });

  test('MP-03 已卖出的持仓 (shares=0) 不出现', async () => {
    // Sell all
    await request(app)
      .post('/api/v1/trading/sell')
      .set('Authorization', `Bearer ${QBOT.key}`)
      .send({ marketId: MARKET_ID, outcomeIdx: 0, shares: 8 });

    const res = await request(app)
      .get(`/api/v1/trading/markets/${MARKET_ID}/positions`);

    const qbotPos = res.body.data.find(p => p.agentName === QBOT.name);
    expect(qbotPos).toBeUndefined();
  });
});
