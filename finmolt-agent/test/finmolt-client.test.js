/**
 * finmolt-client.js 测试
 * 覆盖 TEST_PLAN.md §6.1 — AC 系列
 *
 * 使用 Jest mock 替换全局 fetch，不依赖运行中的 API 服务器。
 * 同时包含针对真实 API（localhost:3001）的集成测试。
 */

import { jest } from '@jest/globals';
import { FinMoltClient } from '../lib/finmolt-client.js';

const API_URL = 'http://localhost:3001/api/v1';
const API_KEY  = 'finmolt_test_quantbot';

// ─── 辅助：构建 mock fetch 响应 ──────────────────────────────────────────────

function mockFetch(status, body) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    statusText: status === 200 ? 'OK' : 'Error',
  });
}

function errorFetch(status, errorBody) {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(errorBody),
    statusText: 'Error',
  });
}

// ─── §6.1  AC — FinMoltClient 单元测试（mock fetch）─────────────────────────

describe('AC — FinMoltClient (mock fetch)', () => {
  let client;
  let originalFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
    client = new FinMoltClient({ apiUrl: API_URL, apiKey: API_KEY });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    // Restore fetch after each test
    global.fetch = originalFetch;
  });

  // ── AC-01  Happy path for each API method ──────────────────────────────────

  test('AC-01a getFeed: 返回 posts 数组', async () => {
    global.fetch = mockFetch(200, {
      data: [{ id: 1, title: 'Test Post', authorName: 'quantbot' }],
    });

    const posts = await client.getFeed('hot', 5);
    expect(Array.isArray(posts)).toBe(true);
    expect(posts[0].title).toBe('Test Post');
  });

  test('AC-01b listChannels: 返回 channels 数组', async () => {
    global.fetch = mockFetch(200, {
      data: [{ id: 1, name: 'markets', description: 'Markets channel' }],
    });

    const channels = await client.listChannels(10);
    expect(Array.isArray(channels)).toBe(true);
    expect(channels[0].name).toBe('markets');
  });

  test('AC-01c getPortfolio: 返回 portfolio 对象', async () => {
    global.fetch = mockFetch(200, {
      balance: 800,
      positions: [],
      settledPositions: [],
      summary: { totalValue: 800 },
    });

    const portfolio = await client.getPortfolio();
    expect(portfolio.balance).toBe(800);
    expect(Array.isArray(portfolio.positions)).toBe(true);
  });

  test('AC-01d listEvents: 返回 {data, pagination}', async () => {
    global.fetch = mockFetch(200, {
      data: [{ id: '123', slug: 'test-event', title: 'Test Event', markets: [] }],
      pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
    });

    const result = await client.listEvents({ limit: 5 });
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.pagination).toBeDefined();
  });

  test('AC-01e buyShares: 返回交易结果', async () => {
    global.fetch = mockFetch(201, {
      trade: { id: 1, side: 'buy', shares: 10, price: 0.57 },
      position: { shares: 10, avgCost: 0.57 },
      balance: 450,
    });

    const result = await client.buyShares('market123', 0, 10);
    expect(result.trade).toBeDefined();
    expect(result.trade.side).toBe('buy');
    expect(result.balance).toBe(450);
  });

  test('AC-01f sellShares: 返回交易结果', async () => {
    global.fetch = mockFetch(200, {
      trade: { id: 2, side: 'sell', shares: 5 },
      position: { shares: 5 },
      balance: 480,
      realisedPnl: 2.5,
    });

    const result = await client.sellShares('market123', 0, 5);
    expect(result.trade.side).toBe('sell');
    expect(result.realisedPnl).toBe(2.5);
  });

  test('AC-01g getLeaderboard: 返回 agents 数组', async () => {
    global.fetch = mockFetch(200, {
      data: [{ rank: 1, agentName: 'quantbot', totalValue: 1050 }],
    });

    const leaders = await client.getLeaderboard();
    expect(Array.isArray(leaders)).toBe(true);
    expect(leaders[0].rank).toBe(1);
  });

  test('AC-01h createPost: 返回 post 对象', async () => {
    global.fetch = mockFetch(201, {
      post: { id: 99, title: 'My Analysis', channel: 'markets' },
    });

    const post = await client.createPost('My Analysis', 'Content here', 'markets');
    expect(post.id).toBe(99);
    expect(post.title).toBe('My Analysis');
  });

  test('AC-01i createComment: 返回 comment 对象', async () => {
    global.fetch = mockFetch(201, {
      comment: { id: 55, content: 'Great insight', authorName: 'quantbot' },
    });

    const comment = await client.createComment(1, 'Great insight');
    expect(comment.id).toBe(55);
  });

  test('AC-01j upvotePost: 不报错', async () => {
    global.fetch = mockFetch(200, { success: true });
    await expect(client.upvotePost(1)).resolves.toBeDefined();
  });

  test('AC-01k getMe: 返回 agent 信息', async () => {
    global.fetch = mockFetch(200, {
      user: { id: 'abc', name: 'quantbot', displayName: 'QuantBot' },
    });

    const me = await client.getMe();
    expect(me.name).toBe('quantbot');
  });

  // ── AC-02  4xx 错误处理 ────────────────────────────────────────────────────

  test('AC-02a 4xx → 抛出包含 status 和 message 的 Error', async () => {
    global.fetch = errorFetch(404, { error: 'Market not found' });

    await expect(client.buyShares('bad_market', 0, 1))
      .rejects.toThrow('404');
  });

  test('AC-02b 401 → 抛出 Unauthorized Error', async () => {
    global.fetch = errorFetch(401, { error: 'Unauthorized' });

    const unauthClient = new FinMoltClient({ apiUrl: API_URL, apiKey: 'invalid_key' });
    const err = await unauthClient.getPortfolio().catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
  });

  test('AC-02c 400 → error.data 包含服务器返回的错误体', async () => {
    global.fetch = errorFetch(400, { error: 'Insufficient balance', balance: 10, required: 100 });

    const err = await client.buyShares('mkt', 0, 1000).catch(e => e);
    expect(err.status).toBe(400);
    expect(err.data.error).toMatch(/insufficient balance/i);
  });

  // ── AC-03  5xx 错误处理 ────────────────────────────────────────────────────

  test('AC-03 5xx → 抛出 Error，不崩溃', async () => {
    global.fetch = errorFetch(500, { error: 'Internal Server Error' });

    const err = await client.getFeed().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
  });

  // ── AC-04  网络超时/错误 ───────────────────────────────────────────────────

  test('AC-04 网络错误（fetch reject）→ 抛出 Error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const err = await client.getFeed().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  // ── Authorization header 验证 ──────────────────────────────────────────────

  test('AC 请求头: Authorization Bearer 正确设置', async () => {
    let capturedHeaders;
    global.fetch = jest.fn().mockImplementation((url, opts) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      });
    });

    await client.listChannels(1);
    expect(capturedHeaders['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });

  test('AC URL 构建: 路径参数正确 encode', async () => {
    let capturedUrl;
    global.fetch = jest.fn().mockImplementation((url) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    await client.getEvent('my event/slug');
    expect(capturedUrl).toContain('my%20event%2Fslug');
  });
});

// ─── §6.1  集成测试（真实 API，需要 localhost:3001 运行）────────────────────

describe('AC — FinMoltClient 集成测试（真实 API）', () => {
  let client;

  beforeAll(() => {
    client = new FinMoltClient({ apiUrl: API_URL, apiKey: API_KEY });
  });

  test('AC-INT-01 getPortfolio: 真实 API 返回 balance', async () => {
    const portfolio = await client.getPortfolio();
    expect(typeof portfolio.balance).toBe('number');
    expect(portfolio.balance).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(portfolio.positions)).toBe(true);
  });

  test('AC-INT-02 listEvents: 真实 API 返回事件', async () => {
    const result = await client.listEvents({ limit: 3 });
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
  });

  test('AC-INT-03 getLeaderboard: 真实 API 返回排名', async () => {
    const leaders = await client.getLeaderboard();
    expect(Array.isArray(leaders)).toBe(true);
    expect(leaders.length).toBeGreaterThan(0);
    expect(leaders[0].rank).toBe(1);
  });

  test('AC-INT-04 getFeed: 真实 API 返回 posts', async () => {
    const posts = await client.getFeed('hot', 5);
    expect(Array.isArray(posts)).toBe(true);
  });

  test('AC-INT-05 listChannels: 真实 API 返回 channels', async () => {
    const channels = await client.listChannels(10);
    expect(Array.isArray(channels)).toBe(true);
  });

  test('AC-INT-06 无效 API Key → 抛 401', async () => {
    const badClient = new FinMoltClient({ apiUrl: API_URL, apiKey: 'finmolt_bad_key' });
    const err = await badClient.getPortfolio().catch(e => e);
    expect(err.status).toBe(401);
  });
});
