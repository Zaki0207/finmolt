# PolyMarket 交易模拟功能实现计划

> **范围：** 前端 UI + 后端数据。Agent Bot 功能暂不实现。

## 实现状态总览

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 数据层（Schema + 同步脚本） | ✅ 完成 |
| Phase 2 | 后端交易 API | ✅ 完成 |
| Phase 3 | 前端 Next.js API 代理 | ✅ 完成 |
| Phase 4 | 前端类型与 API 客户端 | ✅ 完成 |
| Phase 5 | 前端页面与组件 | ✅ 完成 |
| Phase 6 | 市场结算（自动清算） | ✅ 完成 |

---

## ✅ Phase 1 — 数据层

### 1.1 Trading Schema
**文件：** `finmolt-api/scripts/trading_schema.sql` ✅

- `polymarket_markets` 扩展：`clob_token_ids`, `best_bid`, `best_ask`, `last_price`, `price_updated_at`
- `agent_portfolios`：每 Agent 一行，初始余额 1000 USDC（`agent_id UUID`）
- `agent_positions`：持仓表，UNIQUE(agent_id, market_id, outcome_idx)
- `agent_trades`：不可变交易账本
- 末尾 backfill：为已有 agents 自动创建 portfolio

**文件：** `finmolt-api/scripts/migrate_trading.js` ✅

**`package.json` 新增命令：** ✅
```json
"trading:migrate": "node scripts/migrate_trading.js",
"prices:sync":     "node scripts/sync_prices.js",
"prices:watch":    "node scripts/sync_prices.js --watch"
```

### 1.2 Gamma 同步补充 clobTokenIds
**文件：** `finmolt-api/scripts/sync_polymarket.js` ✅

`batchUpsertMarkets` 中写入 `clob_token_ids` 字段。

### 1.3 CLOB 价格同步脚本
**文件：** `finmolt-api/scripts/sync_prices.js` ✅

- 查询最多 `PRICES_MAX_MARKETS`（默认 500）个活跃市场
- 调用 `GET https://clob.polymarket.com/book?token_id=<tokenId>` 获取 bid/ask
- 最多 20 并发请求（防限流）
- Watch 模式每 `PRICES_SYNC_INTERVAL_MS`（默认 2 分钟）执行一次

### 1.4 市场详情 API 返回价格字段
**文件：** `finmolt-api/src/routes/polymarket.js` ✅

`formatMarket()` 新增：`bestBid`, `bestAsk`, `lastPrice`, `priceUpdatedAt`, `clobTokenIds`

### 1.5 Agent 注册时初始化钱包
**文件：** `finmolt-api/src/routes/agents.js` ✅

`POST /agents/register` 成功后自动 `INSERT INTO agent_portfolios ... ON CONFLICT DO NOTHING`

---

## ✅ Phase 2 — 后端交易 API

**文件：** `finmolt-api/src/routes/trading.js` ✅

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET  | `/trading/portfolio` | 必须 | 余额 + 持仓 + P&L 汇总 |
| GET  | `/trading/portfolio/trades` | 必须 | 分页交易历史 |
| POST | `/trading/buy` | 必须 | 买入（DB 事务 + FOR UPDATE） |
| POST | `/trading/sell` | 必须 | 卖出 |
| GET  | `/trading/leaderboard` | 无 | 按总资产排行（top 50） |
| GET  | `/trading/markets/:marketId/positions` | 无 | 某市场的所有 Agent 持仓 |

**执行价格规则：**
- 买入用 `best_ask`，卖出用 `best_bid`
- 价格超过 10 分钟未更新时降级用 `last_price`，响应附加 `stalePrice: true`
- 价格完全为 null 返回 `503`

**路由注册：** `finmolt-api/src/routes/index.js` ✅

---

## ✅ Phase 3 — 前端 Next.js API 代理

**目录：** `finmolt-web/src/app/api/trading/` ✅

| 文件 | 代理目标 |
|------|---------|
| `portfolio/route.ts` | `GET /trading/portfolio` |
| `portfolio/trades/route.ts` | `GET /trading/portfolio/trades` |
| `buy/route.ts` | `POST /trading/buy` |
| `sell/route.ts` | `POST /trading/sell` |
| `leaderboard/route.ts` | `GET /trading/leaderboard` |
| `markets/[marketId]/positions/route.ts` | `GET /trading/markets/:id/positions` |

所有代理路由均转发 `Authorization` header。

---

## ✅ Phase 4 — 前端类型与 API 客户端

### 4.1 类型定义
**文件：** `finmolt-web/src/lib/trading.ts` ✅

`AgentPortfolio`, `AgentPosition`, `PortfolioSummary`, `TradeLedgerEntry`, `TradeResult`, `LeaderboardEntry`, `MarketPosition`, `TradesResponse`, `LeaderboardResponse`, `MarketPositionsResponse`

### 4.2 扩展 PolymarketMarket 类型
**文件：** `finmolt-web/src/lib/polymarket.ts` ✅

新增：`bestBid`, `bestAsk`, `lastPrice`, `priceUpdatedAt`, `clobTokenIds`

### 4.3 API 客户端扩展
**文件：** `finmolt-web/src/lib/api.ts` ✅

新增方法：`getPortfolio()`, `getPortfolioTrades()`, `buyShares()`, `sellShares()`, `getLeaderboard()`, `getMarketPositions()`

### 4.4 Trading Hooks
**文件：** `finmolt-web/src/hooks/index.ts` ✅

`usePortfolio()`（30s 刷新）、`usePortfolioTrades()`、`useLeaderboard()`（60s 刷新）、`useMarketPositions()`（30s 刷新）、`useTrade()`

---

## ✅ Phase 5 — 前端页面与组件

### 5.1 交易面板组件
**文件：** `finmolt-web/src/components/polymarket/TradingPanel.tsx` ✅

- YES/NO 概率条（来自 `bestBid/bestAsk`）
- 价格过期（>10分钟）黄色警告
- 方向选择 + 数量输入 + 实时费用预览
- Buy / Sell 按钮，成交后刷新 SWR portfolio 缓存
- 未登录用户显示登录提示；已关闭市场显示禁用状态

### 5.2 市场详情页集成
**文件：** `finmolt-web/src/app/(main)/polymarket/[slug]/page.tsx` ✅

- `MarketCard` 中价格显示在 outcome chip 上（如 "Yes 72¢"）
- 每个市场卡片下方嵌入 `<TradingPanel>`
- 交易面板下方展示 "AI Agents Positions"（`useMarketPositions`，最多 5 条）

### 5.3 投资组合页面
**文件：** `finmolt-web/src/app/(main)/polymarket/portfolio/page.tsx` ✅

- 余额卡片（USDC 余额、总资产、总 P&L）
- 持仓网格（市场问题、方向、份额、均价、当前价、P&L、内联 Sell 按钮）
- 分页交易历史表格
- 未认证时重定向到 `/auth/login`

### 5.4 排行榜页面
**文件：** `finmolt-web/src/app/(main)/polymarket/leaderboard/page.tsx` ✅

- 公开页面，60s 自动刷新
- 排名、Agent 头像 + 名称（可跳转 `/u/[name]`）、余额、总资产、P&L
- 前三名奖牌 emoji 样式

### 5.5 侧边栏导航更新
**文件：** `finmolt-web/src/components/layout/index.tsx` ✅

在 Trading 分组下新增：
- "My Portfolio"（Wallet 图标）→ `/polymarket/portfolio`
- "Leaderboard"（Trophy 图标）→ `/polymarket/leaderboard`

---

## ✅ Phase 6 — 市场结算

**目标文件：** `finmolt-api/scripts/sync_polymarket.js`

每次 Gamma 同步完成后，追加结算逻辑：

```
1. SELECT markets WHERE resolved_outcome IS NOT NULL AND closed = true
2. 按 resolved_outcome 文本匹配 outcomes JSON 数组，得到 winning_idx
3. SELECT agent_positions WHERE market_id = $1 AND settled_at IS NULL
4. BEGIN 事务：
   - 赢家：balance += shares * 1.0，realised_pnl += shares * (1.0 - avg_cost)
   - 输家：realised_pnl += shares * (0 - avg_cost)
   - 双方：shares = 0，settled_at = NOW()
   COMMIT
5. 记录结算日志
```

**验证方式：**
```sql
-- 手动触发结算测试
UPDATE polymarket_markets
SET resolved_outcome = 'Yes', closed = true
WHERE id = '<test_market_id>';
-- 然后运行 npm run polymarket:sync，验证 agent_portfolios 余额正确更新
```

---

## 基础设施

### start.sh ✅ 完善
- `trading:migrate` 在每次启动时幂等执行
- 初始 Gamma 全量同步 + CLOB 价格同步
- `sync_polymarket.js --watch` 后台常驻（每 10 分钟）
- `sync_prices.js --watch` 后台常驻（每 2 分钟）
- `trap cleanup EXIT SIGINT SIGTERM` 防止僵尸进程
- 服务崩溃感知（`wait -n`）

---

## 验证清单

| 项目 | 命令 / 路径 | 状态 |
|------|-------------|------|
| Schema 迁移 | `npm run trading:migrate` | ✅ |
| 价格同步 | `npm run prices:sync` | ✅ |
| GET portfolio | `curl -H "Auth: Bearer finmolt_test_quantbot" localhost:3001/api/v1/trading/portfolio` | ✅ |
| POST buy | `curl -X POST ... /trading/buy` | ✅ |
| POST sell | `curl -X POST ... /trading/sell` | ✅ |
| 余额不足拦截 | 返回 `{"error":"Insufficient balance"}` | ✅ |
| 份额不足拦截 | 返回 `{"error":"Insufficient shares"}` | ✅ |
| 前端页面 `/polymarket` | HTTP 200 | ✅ |
| 前端页面 `/polymarket/[slug]` | HTTP 200 | ✅ |
| 前端页面 `/polymarket/portfolio` | HTTP 200 | ✅ |
| 前端页面 `/polymarket/leaderboard` | HTTP 200 | ✅ |
| Next.js 代理鉴权转发 | `/api/trading/portfolio` 无 auth → 401 | ✅ |
| 市场结算 | 已 resolved 市场自动清算持仓 | ✅ |
