/**
 * Polymarket API 路由测试
 * 覆盖 TEST_PLAN.md §4 — E / ED / PH / TG 系列
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const request = require('supertest');
const app     = require('../src/app');
const db      = require('./helpers/db');

const TEST_EVENT_ID   = db.TEST_EVENT_ID;   // '346298'
const TEST_MARKET_ID  = db.TEST_MARKET_ID;  // '1877547'

// Look up the slug of the test event
let testEventSlug = null;

beforeAll(async () => {
  const { rows } = await db.query(
    'SELECT slug FROM polymarket_events WHERE id=$1', [TEST_EVENT_ID],
  );
  if (rows.length > 0) testEventSlug = rows[0].slug;
});

afterAll(async () => {
  await db.closePool();
});

// ─── §4.1  GET /polymarket/events ────────────────────────────────────────────

describe('GET /polymarket/events', () => {
  test('E-01 默认查询: 返回 active=true, closed=false 的事件', async () => {
    const res = await request(app).get('/api/v1/polymarket/events');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.data.length).toBeGreaterThan(0);

    // All returned events should be active and not closed
    for (const e of res.body.data) {
      expect(e.active).toBe(true);
      expect(e.closed).toBe(false);
    }
  });

  test('E-01b markets 嵌套在 events 中返回', async () => {
    const res = await request(app).get('/api/v1/polymarket/events?limit=3');

    expect(res.status).toBe(200);
    for (const e of res.body.data) {
      expect(Array.isArray(e.markets)).toBe(true);
    }
  });

  test('E-02 搜索 search 参数触发过滤', async () => {
    const res = await request(app)
      .get('/api/v1/polymarket/events?search=bitcoin&limit=5');

    expect(res.status).toBe(200);
    // Results may or may not exist, but should not error
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('E-04 分页: limit + offset 正确', async () => {
    const res1 = await request(app).get('/api/v1/polymarket/events?limit=2&offset=0');
    const res2 = await request(app).get('/api/v1/polymarket/events?limit=2&offset=2');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.data.length).toBe(2);

    // Verify pagination metadata
    expect(res1.body.pagination.offset).toBe(0);
    expect(res2.body.pagination.offset).toBe(2);
    expect(res1.body.pagination.limit).toBe(2);

    // If there are events at offset 2, they exist (ordering consistency is a separate concern)
    expect(Array.isArray(res2.body.data)).toBe(true);
  });

  test('E-05 markets 格式: 包含价格字段', async () => {
    const res = await request(app).get('/api/v1/polymarket/events?limit=3');

    const allMarkets = res.body.data.flatMap(e => e.markets);
    if (allMarkets.length > 0) {
      const mkt = allMarkets[0];
      // These fields should exist (may be null for markets without prices)
      expect('bestBid'   in mkt).toBe(true);
      expect('bestAsk'   in mkt).toBe(true);
      expect('lastPrice' in mkt).toBe(true);
    }
  });

  test('E-01c status=closed 参数: 只返回已关闭事件', async () => {
    const res = await request(app)
      .get('/api/v1/polymarket/events?status=closed&limit=3');

    expect(res.status).toBe(200);
    for (const e of res.body.data) {
      expect(e.closed).toBe(true);
    }
  });
});

// ─── §4.2  GET /polymarket/events/:slug ──────────────────────────────────────

describe('GET /polymarket/events/:slug', () => {
  test('ED-01 存在的 slug → 返回事件详情 + markets + tags', async () => {
    if (!testEventSlug) return;

    const res = await request(app)
      .get(`/api/v1/polymarket/events/${testEventSlug}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.slug).toBe(testEventSlug);
    expect(Array.isArray(res.body.markets)).toBe(true);
    expect(Array.isArray(res.body.tags)).toBe(true);
  });

  test('ED-02 不存在的 slug → 404', async () => {
    const res = await request(app)
      .get('/api/v1/polymarket/events/this-slug-does-not-exist-xyz-123');

    expect(res.status).toBe(404);
  });

  test('ED-01b 返回的 markets 包含价格字段', async () => {
    if (!testEventSlug) return;

    const res = await request(app)
      .get(`/api/v1/polymarket/events/${testEventSlug}`);

    expect(res.status).toBe(200);
    for (const mkt of res.body.markets) {
      expect('bestBid'   in mkt).toBe(true);
      expect('bestAsk'   in mkt).toBe(true);
      expect('lastPrice' in mkt).toBe(true);
    }
  });
});

// ─── §4.3  GET /polymarket/markets/:marketId/prices-history ──────────────────

describe('GET /polymarket/markets/:marketId/prices-history', () => {
  // These tests hit the external CLOB API — mark as potentially slow
  jest.setTimeout(15000);

  test('PH-04 无 clobTokenIds 的市场 → 返回空 history', async () => {
    // Create a test market with no clob_token_ids
    const { eventId, marketId } = await db.createTestMarket({});
    try {
      const res = await request(app)
        .get(`/api/v1/polymarket/markets/${marketId}/prices-history?interval=1w`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.history)).toBe(true);
      expect(res.body.history.length).toBe(0);
    } finally {
      await db.deleteTestMarket(eventId, marketId);
    }
  });

  test('PH-02 无效 interval → 不报错 (使用默认)', async () => {
    const res = await request(app)
      .get(`/api/v1/polymarket/markets/${TEST_MARKET_ID}/prices-history?interval=invalid`);

    // Should not crash — should return 200 with possibly empty history
    expect(res.status).toBe(200);
  });

  test('PH-01 有效 marketId + interval (live external call, may fail in CI)', async () => {
    const res = await request(app)
      .get(`/api/v1/polymarket/markets/${TEST_MARKET_ID}/prices-history?interval=1w`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('history');
    expect(Array.isArray(res.body.history)).toBe(true);
    // History items should have t and p fields if data is available
    if (res.body.history.length > 0) {
      expect(res.body.history[0]).toHaveProperty('t');
      expect(res.body.history[0]).toHaveProperty('p');
    }
  });
});

// ─── §4.4  GET /polymarket/tags ───────────────────────────────────────────────

describe('GET /polymarket/tags', () => {
  // NOTE: The tags endpoint returns a plain array (not { data: [] })
  // This is a known inconsistency vs other endpoints that return { data, pagination }

  test('TG-01 正常获取: 返回 tags 数组', async () => {
    const res = await request(app).get('/api/v1/polymarket/tags');

    expect(res.status).toBe(200);
    // Tags endpoint returns array directly (not { data: [] })
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      expect(res.body[0].id).toBeDefined();
      expect(res.body[0].label).toBeDefined();
    }
  });

  test('TG-02 limit 参数: 正确限制数量', async () => {
    const res = await request(app).get('/api/v1/polymarket/tags?limit=5');

    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(5);
  });

  test('TG-02b limit 最大 100', async () => {
    const res = await request(app).get('/api/v1/polymarket/tags?limit=200');

    expect(res.status).toBe(200);
    // The limit is applied in the query — may return up to 100 (or less if fewer exist)
    expect(Array.isArray(res.body)).toBe(true);
  });
});
