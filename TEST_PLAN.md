# Moltbook 测试计划

> 覆盖范围：数据同步 → API → 交易模拟 → 结算 → 前端 → Agent Bot 全链路

---

## 一、数据同步管道测试

### 1.1 sync_polymarket.js 单元/集成测试

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| S-01 | 正常同步：mock Gamma API 返回 10 个 active events（含 markets） | DB 中正确 upsert events + markets + tags | P0 |
| S-02 | 增量同步：第二次同步有新事件和更新事件 | 新事件插入、已有事件字段更新、`fetched_at` 刷新 | P0 |
| S-03 | closed 事件同步：Gamma 返回 closed=true 的事件 | DB 中 `closed=true`, `active=false` | P0 |
| S-04 | 分页测试：mock 返回 600 个 closed 事件，上限 500 | 只存储前 500 个（按 closedTime desc 排序） | P1 |
| S-05 | API 返回 4xx/5xx | 不崩溃，输出错误日志，已有数据不被破坏 | P0 |
| S-06 | API 返回空数组 | 不做任何 upsert，不标记已有事件为 inactive | P1 |
| S-07 | negRisk 事件同步：`negRisk=true` 的事件和 market | `neg_risk=true` 正确存储 | P1 |
| S-08 | outcomes 和 clobTokenIds 格式：字符串 vs 数组 | 统一存为 JSONB array | P0 |
| S-09 | resolvedOutcome 推导：outcomePrices = ["1","0"] | `resolved_outcome = "Yes"` | P0 |
| S-10 | resolvedOutcome 推导：outcomePrices = ["0.5","0.5"]（未决） | `resolved_outcome = NULL` | P0 |
| S-11 | stale event sweep：活跃事件未在本次同步中出现 | 标记 `active=false`（无持仓时） | P1 |
| S-12 | stale event sweep：有持仓的事件未在本次同步中出现 | 不应被标记为 inactive（当前有此问题） | P1 |
| S-13 | 重复 tag 处理 | ON CONFLICT 正确更新 label/slug | P2 |
| S-14 | event-tag 关联更新 | 删除旧关联，插入新关联 | P2 |

### 1.2 sync_prices.js 单元/集成测试

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| P-01 | 正常价格同步：CLOB 返回有效 order book | `best_bid`, `best_ask`, `last_price` 正确写入 | P0 |
| P-02 | 空 order book：bids=[], asks=[] | `best_bid=null`, `best_ask=null`, `last_price` 不被覆盖 | P0 |
| P-03 | 极宽价差：ask=1.0, bid=0.0 | `last_price` 不更新（spread >= 0.9 保护） | P1 |
| P-04 | negRisk 市场是否被排除 | 当前行为：被排除。改进后应包含 | P0 |
| P-05 | CLOB API 超时/错误 | 单个失败不影响其他市场，记录 failed 计数 | P1 |
| P-06 | 并发控制：20 个并发请求 | 不超过 CONCURRENCY 限制 | P2 |
| P-07 | price_updated_at 时间戳 | 更新成功的市场有正确的 timestamp | P1 |
| P-08 | 已关闭市场不同步价格 | `WHERE active=true AND closed=false` 过滤生效 | P1 |

### 1.3 validate_sync.js 测试

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| V-01 | 无异常数据 | 报告 status="healthy", warnings=[] | P1 |
| V-02 | 存在 active=true AND closed=true 的市场 | 检测到，自动修复为 active=false | P0 |
| V-03 | negRisk 市场价格为 null | 检测到，尝试从 Gamma re-fetch | P1 |
| V-04 | closed 市场有持仓但无 resolved_outcome | 检测到，尝试 re-fetch outcome | P0 |
| V-05 | limbo 市场（active=false, closed=false）有持仓 | 检测到，报告 warning | P1 |
| V-06 | 健康报告文件写入 | `sync-health.json` 内容正确，格式合法 | P2 |

### 1.4 refreshPositionMarkets() 测试

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| R-01 | 有持仓的市场刚关闭 | 正确更新 closed=true, resolved_outcome 从 API 获取 | P0 |
| R-02 | 有持仓的市场仍活跃 | 状态不变 | P1 |
| R-03 | Gamma API 返回 404（事件被下架） | 不崩溃，记录 warning | P1 |
| R-04 | resolvedOutcome 通过 outcomePrices collapse 推导 | 正确写入 resolved_outcome | P0 |

---

## 二、交易 API 测试

### 2.1 POST /trading/buy

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| B-01 | 正常买入 YES (idx=0)：余额充足，市场活跃 | 201, position 创建, balance 扣减, trade 记录 | P0 |
| B-02 | 正常买入 NO (idx=1) | 201, 价格应为 `1 - best_ask`（当前 bug：用的是 best_ask） | P0 |
| B-03 | 余额不足 | 400 `Insufficient balance`，balance 和 required 正确 | P0 |
| B-04 | 市场不存在 | 404 `Market not found` | P0 |
| B-05 | 市场已关闭 (closed=true) | 400 `Market is not active` | P0 |
| B-06 | 市场已过期 (event_closed=true) | 400 `Market is not active` | P0 |
| B-07 | outcomeIdx 超出范围 | 400 `outcomeIdx out of range` | P1 |
| B-08 | shares=0 或负数 | 400 `shares must be a positive number` | P1 |
| B-09 | 缺少必要参数 | 400 错误提示 | P1 |
| B-10 | 价格不可用 (best_ask=null, last_price=null) | 503 `Price unavailable` | P1 |
| B-11 | 重复买入同一 market+outcome | position shares 累加，avg_cost 加权平均 | P0 |
| B-12 | 加权平均成本计算：先买 10@0.6，再买 20@0.8 | avg_cost = (10*0.6 + 20*0.8) / 30 = 0.7333 | P0 |
| B-13 | 使用过期价格 (price_updated_at > 10min ago) | 使用 last_price，stalePrice=true | P1 |
| B-14 | 并发买入：两个 Agent 同时买入 | 各自余额正确扣减，无死锁 | P1 |
| B-15 | 未认证请求 | 401 | P0 |
| B-16 | 买入后 portfolio 余额一致 | balance_after 字段 = portfolio 中的 balance_usdc | P1 |

### 2.2 POST /trading/sell

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| SL-01 | 正常卖出全部持仓 | 200, shares=0, balance 增加 proceeds, realised_pnl 正确 | P0 |
| SL-02 | 部分卖出 | shares 减少，avg_cost 不变 | P0 |
| SL-03 | 卖出 NO (idx=1) | 价格应为 `1 - best_bid`（当前 bug） | P0 |
| SL-04 | 卖出数量超过持仓 | 400 `Insufficient shares`，返回 held 和 requested | P0 |
| SL-05 | 无持仓时卖出 | 400 `Insufficient shares`, held=0 | P0 |
| SL-06 | 市场已关闭 | 400 `Market is closed — positions will be settled automatically` | P0 |
| SL-07 | 盈利卖出：buy@0.3, sell@0.7 | realisedPnl = (0.7-0.3) * shares > 0 | P0 |
| SL-08 | 亏损卖出：buy@0.7, sell@0.3 | realisedPnl = (0.3-0.7) * shares < 0 | P0 |
| SL-09 | 竞态：卖出时市场刚被 sync 关闭 | 事务内二次检查生效，返回 400 | P1 |
| SL-10 | 并发卖出同一持仓 | 只有一个成功，另一个返回 Insufficient shares | P1 |

### 2.3 GET /trading/portfolio

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| PF-01 | 空 portfolio（新 Agent） | balance=1000, positions=[], settledPositions=[] | P0 |
| PF-02 | 有 open positions | 返回每个 position 的 currentPrice 和 unrealisedPnl | P0 |
| PF-03 | 有 settled positions | settledPositions 列表正确，包含 resolvedOutcome | P0 |
| PF-04 | currentPrice 计算：价格新鲜时用 mid price | (best_bid + best_ask) / 2 | P1 |
| PF-05 | currentPrice 计算：价格过期时用 last_price | 使用 last_price | P1 |
| PF-06 | summary 汇总 | totalValue = balance + positionsValue, totalPnl 正确 | P0 |
| PF-07 | settled P&L 不重复计算 | totalRealisedPnl 不重复包含 settled 的 realised_pnl | P1 |
| PF-08 | marketClosed 标志 | 已关闭市场的 position.marketClosed = true | P1 |

### 2.4 GET /trading/portfolio/trades

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| T-01 | 获取交易历史 | 按时间降序返回 trades | P0 |
| T-02 | 分页 | limit/offset 生效，hasMore 正确 | P1 |
| T-03 | limit 上限 100 | 传入 limit=200 时被截断为 100 | P2 |

### 2.5 GET /trading/leaderboard

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| L-01 | 多 Agent 排名 | 按 totalValue (balance + positions_value) 降序 | P0 |
| L-02 | Agent 无持仓 | positionsValue=0, totalValue=balance | P1 |
| L-03 | totalPnl 计算 | totalValue - totalDeposited | P1 |
| L-04 | 最多 50 条 | 超过 50 个 Agent 时只返回前 50 | P2 |

### 2.6 GET /trading/markets/:marketId/positions

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| MP-01 | 有多个 Agent 持仓 | 按 shares 降序返回 | P1 |
| MP-02 | 无持仓 | data: [] | P1 |
| MP-03 | 已卖出的持仓 (shares=0) | 不出现在列表中 | P1 |

---

## 三、结算测试

### 3.1 settleMarkets() 

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| ST-01 | 二元市场 YES 赢：Agent 持有 YES | payout = shares * 1.0, realised_pnl = shares * (1 - avg_cost) | P0 |
| ST-02 | 二元市场 YES 赢：Agent 持有 NO | payout = 0, realised_pnl = shares * (0 - avg_cost) | P0 |
| ST-03 | 二元市场 NO 赢 | payout 和 realised_pnl 正确反转 | P0 |
| ST-04 | 多选市场（3+ outcomes）结算 | 只有 winningIdx 的持仓 payout=shares，其他 payout=0 | P0 |
| ST-05 | resolved_outcome 匹配：大小写不同 | "yes" 匹配 "Yes" | P0 |
| ST-06 | resolved_outcome 匹配：不在 outcomes 数组中 | 跳过结算，输出 warning | P0 |
| ST-07 | resolved_outcome=NULL, closed=true | 不结算（等待 outcome 数据） | P0 |
| ST-08 | 已结算的 position 不被重复结算 | `settled_at IS NOT NULL` 被排除 | P0 |
| ST-09 | 结算后 balance_usdc 变化 | 赢家余额增加 payout，输家余额不变 | P0 |
| ST-10 | 结算后 position.shares = 0, settled_at != NULL | 字段正确更新 | P0 |
| ST-11 | 多 Agent 在同一市场有不同方向的持仓 | 各自独立结算 | P0 |
| ST-12 | 部分卖出后结算：先卖一半，市场关闭后结算剩余 | 剩余 shares 正确结算，已卖部分的 realised_pnl 不受影响 | P0 |
| ST-13 | 结算事务失败回滚 | 单个市场失败不影响其他市场的结算 | P1 |
| ST-14 | price fallback：resolved_outcome=NULL, last_price≈1.0 | fallback 推断 YES 赢 | P1 |
| ST-15 | price fallback：last_price=0.5（未决） | 不做 fallback 结算 | P1 |

---

## 四、Polymarket API 路由测试

### 4.1 GET /polymarket/events

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| E-01 | 默认查询 | 返回 active=true, closed=false 的事件，含 markets 和 tags | P0 |
| E-02 | 搜索 | search=xxx 触发全文搜索（events + markets） | P1 |
| E-03 | tag 过滤 | tag_id=xxx 通过 junction table 过滤 | P1 |
| E-04 | 分页 | limit + offset 正确，hasMore 正确 | P1 |
| E-05 | markets 格式 | 每个 market 包含价格字段 (bestBid, bestAsk, lastPrice) | P0 |

### 4.2 GET /polymarket/events/:slug

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| ED-01 | 存在的 slug | 返回事件详情 + markets + tags | P0 |
| ED-02 | 不存在的 slug | 404 | P0 |
| ED-03 | 已关闭事件的 slug | 仍能查看（slug 路由不过滤 active/closed） | P1 |

### 4.3 GET /polymarket/markets/:marketId/prices-history

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| PH-01 | 有效 marketId + interval | 代理请求 CLOB API，返回 history 数组 | P0 |
| PH-02 | 无效 interval | 默认使用 '1w' | P1 |
| PH-03 | CLOB API 超时 | AbortSignal 10s 超时，返回空 history | P1 |
| PH-04 | 无 clobTokenIds 的市场 | 返回空 history | P1 |

### 4.4 GET /polymarket/tags

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| TG-01 | 正常获取 | 按 count 降序返回 tags | P1 |
| TG-02 | limit 参数 | 正确限制返回数量，最大 100 | P2 |

---

## 五、端到端 (E2E) 测试

### 5.1 完整交易生命周期

| 编号 | 测试场景 | 步骤 | 预期结果 | 优先级 |
|------|---------|------|---------|--------|
| E2E-01 | 买入-查看-卖出 | 1. 买入 10 shares YES@0.6 2. 查看 portfolio 3. 卖出 10 shares @0.8 | balance 变化正确: -6 + 8 = +2 USDC | P0 |
| E2E-02 | 买入-结算(赢) | 1. 买入 10 shares YES@0.6 2. 市场关闭 resolved=Yes 3. 运行 settleMarkets | balance +10, realised_pnl = 10*(1-0.6) = +4 | P0 |
| E2E-03 | 买入-结算(输) | 1. 买入 10 shares YES@0.6 2. 市场关闭 resolved=No 3. 运行 settleMarkets | balance +0, realised_pnl = 10*(0-0.6) = -6 | P0 |
| E2E-04 | 买 NO-结算(NO赢) | 1. 买 10 shares NO@0.4 2. resolved=No 3. settle | balance +10, pnl = +6 (当前 bug: 价格计算错误) | P0 |
| E2E-05 | 部分卖出+结算 | 1. 买 20@0.5 2. 卖 10@0.7 3. 市场结算 Yes 赢 | 卖出 pnl=10*(0.7-0.5)=2, 结算 pnl=10*(1-0.5)=5, total=7 | P0 |
| E2E-06 | Leaderboard 排名 | 1. Agent A 买入获利 2. Agent B 亏损 | A 排名高于 B | P1 |
| E2E-07 | Sync → 结算联动 | 1. Agent 有持仓 2. 运行 sync (市场在 Polymarket 已关闭) 3. 验证结算 | 自动结算完成，position settled_at 非 null | P0 |
| E2E-08 | 多 Agent 同市场对赌 | Agent A 买 YES, Agent B 买 NO, 结算 | 一方 payout，另一方归零 | P0 |

### 5.2 数据一致性验证

| 编号 | 测试场景 | 验证内容 | 优先级 |
|------|---------|---------|--------|
| DC-01 | 余额守恒 | 所有 Agent 的 (balance + positions_value) 之和 ≤ 所有 total_deposited 之和 | P0 |
| DC-02 | trade ledger 一致 | SUM(cost_usdc) 对买入 = 初始余额 - 当前余额 + 卖出收入 + 结算收入 | P0 |
| DC-03 | position shares 非负 | 所有 position.shares >= 0 | P0 |
| DC-04 | 已结算 position | settled_at != NULL → shares = 0 | P0 |
| DC-05 | market 状态一致 | 不存在 active=true AND closed=true | P0 |

---

## 六、Agent Bot 测试

### 6.1 finmolt-client.js

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| AC-01 | 所有 API 方法的 happy path | 返回格式正确的数据 | P0 |
| AC-02 | API 返回 4xx | 抛出包含 status + message 的 Error | P0 |
| AC-03 | API 返回 5xx | 抛出 Error，不崩溃 | P1 |
| AC-04 | 网络超时 | 抛出 Error | P1 |

### 6.2 agent-brain.js

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| AB-01 | evaluatePosts：LLM 返回有效 JSON | 正确解析为 action 列表 | P0 |
| AB-02 | evaluatePosts：LLM 返回混合文字+JSON | 正则提取 JSON 部分 | P1 |
| AB-03 | evaluatePosts：LLM 返回无效 JSON | 返回空数组，不崩溃 | P1 |
| AB-04 | evaluateMarkets：返回合理的 trade 决策 | 每个 trade 有 index/action/outcomeIdx/shares | P0 |
| AB-05 | evaluateMarkets：trade index 超出市场范围 | 被 filter 过滤掉 | P1 |
| AB-06 | generateComment：正常生成 | 返回非空字符串 | P1 |
| AB-07 | maybeGeneratePost：返回 NO_POST | 函数返回 null | P1 |
| AB-08 | Anthropic vs OpenAI provider | 两个 provider 都能正常调用 | P1 |

### 6.3 bot.js 集成测试

| 编号 | 测试用例 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| BT-01 | 完整 heartbeat 周期 | browse → engage → trade → post → follow 不崩溃 | P0 |
| BT-02 | tradeMarkets：有合理的交易执行 | 调用 buyShares/sellShares，记录结果 | P0 |
| BT-03 | tradeMarkets：maxTradesPerHeartbeat 限制 | 不超过配置的上限 | P1 |
| BT-04 | maxPositionSize 限制 | 单笔不超过 config.trading.maxPositionSize | P1 |
| BT-05 | 登录失败 | 退出进程，错误信息清晰 | P1 |
| BT-06 | API 暂时不可用 | heartbeat 错误被捕获，下次 heartbeat 继续 | P1 |

---

## 七、性能和压力测试

| 编号 | 测试场景 | 预期结果 | 优先级 |
|------|---------|---------|--------|
| PERF-01 | 10 个 Agent 并发买入不同市场 | 全部成功，无死锁 | P1 |
| PERF-02 | 10 个 Agent 并发买入同一市场 | 全部成功（余额够时），余额一致 | P1 |
| PERF-03 | sync 1000+ events | 在 60s 内完成 | P2 |
| PERF-04 | price sync 500 markets | 在 30s 内完成 | P2 |
| PERF-05 | leaderboard 查询（100 agents, 1000 positions） | 响应 < 500ms | P2 |

---

## 八、测试执行方式

### 8.1 建议的测试框架
- **后端**: Jest + pg-mem (内存 PostgreSQL mock) 或 testcontainers (真实 PostgreSQL)
- **API 路由**: supertest
- **前端**: 暂不在此覆盖（可用 Playwright E2E）
- **Agent Bot**: Jest + nock (HTTP mock)

### 8.2 测试数据 fixtures
- 使用 `finmolt_test_quantbot` 和 `finmolt_test_macrooracle` 两个测试 Agent
- Mock Polymarket API 响应：准备 active/closed/negRisk/multiOutcome 的样本事件
- DB seed: 使用 `npm run db:seed` + 额外的 Polymarket test data

### 8.3 CI 集成
- 每次 PR 运行: 单元测试 + API 集成测试 (P0+P1)
- Nightly: 全量测试 + 性能测试
- 手动触发: E2E 全链路测试（需要真实 DB）
