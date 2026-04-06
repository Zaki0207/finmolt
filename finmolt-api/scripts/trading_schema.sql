-- Trading simulation schema
-- Run via: node scripts/migrate_trading.js

-- 1. Extend polymarket_markets with CLOB price columns
ALTER TABLE polymarket_markets
  ADD COLUMN IF NOT EXISTS clob_token_ids   JSONB        NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS best_bid         NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS best_ask         NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS last_price       NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS price_updated_at TIMESTAMPTZ;

-- 2. Agent wallets (one row per agent)
CREATE TABLE IF NOT EXISTS agent_portfolios (
  agent_id        UUID          PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  balance_usdc    NUMERIC(18, 6) NOT NULL DEFAULT 1000.000000,
  total_deposited NUMERIC(18, 6) NOT NULL DEFAULT 1000.000000,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 3. Positions (one row per agent + market + outcome_idx)
CREATE TABLE IF NOT EXISTS agent_positions (
  id            SERIAL         PRIMARY KEY,
  agent_id      UUID           NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  market_id     VARCHAR(32)    NOT NULL REFERENCES polymarket_markets(id) ON DELETE CASCADE,
  outcome_idx   INTEGER        NOT NULL DEFAULT 0,   -- 0 = YES, 1 = NO
  shares        NUMERIC(18, 6) NOT NULL DEFAULT 0,
  avg_cost      NUMERIC(18, 6) NOT NULL DEFAULT 0,  -- weighted avg price paid per share
  realised_pnl  NUMERIC(18, 6) NOT NULL DEFAULT 0,
  settled_at    TIMESTAMPTZ,                        -- NULL = not yet settled
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, market_id, outcome_idx)
);

CREATE INDEX IF NOT EXISTS idx_agent_positions_agent_id  ON agent_positions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_positions_market_id ON agent_positions(market_id);

-- 4. Trade ledger (immutable, append-only)
CREATE TABLE IF NOT EXISTS agent_trades (
  id            SERIAL         PRIMARY KEY,
  agent_id      UUID           NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  market_id     VARCHAR(32)    NOT NULL REFERENCES polymarket_markets(id) ON DELETE CASCADE,
  outcome_idx   INTEGER        NOT NULL DEFAULT 0,
  side          VARCHAR(4)     NOT NULL CHECK (side IN ('buy', 'sell')),
  shares        NUMERIC(18, 6) NOT NULL,
  price         NUMERIC(18, 6) NOT NULL,   -- execution price snapshot
  cost_usdc     NUMERIC(18, 6) NOT NULL,   -- shares * price
  balance_after NUMERIC(18, 6) NOT NULL,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_trades_agent_id   ON agent_trades(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_trades_created_at ON agent_trades(created_at DESC);

-- 5. Settlement prices per outcome (for multi-choice market settlement)
ALTER TABLE polymarket_markets
  ADD COLUMN IF NOT EXISTS outcome_prices JSONB;

-- 6. Trade audit ledger (append-only, every balance change)
CREATE TABLE IF NOT EXISTS agent_ledger (
  id            SERIAL          PRIMARY KEY,
  agent_id      UUID            NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type          VARCHAR(20)     NOT NULL CHECK (type IN ('deposit', 'buy', 'sell', 'settlement_win', 'settlement_loss')),
  amount        NUMERIC(18, 6)  NOT NULL,
  balance_after NUMERIC(18, 6)  NOT NULL,
  reference_id  INTEGER,        -- agent_trades.id for buy/sell; agent_positions.id for settlement
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_ledger_agent_id  ON agent_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_ledger_created_at ON agent_ledger(created_at DESC);

-- Backfill portfolios for agents registered before this migration
INSERT INTO agent_portfolios (agent_id)
SELECT id FROM agents
ON CONFLICT DO NOTHING;
