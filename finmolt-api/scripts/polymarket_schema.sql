-- Polymarket sync tables (v2)
-- Run with: node scripts/migrate_polymarket.js
-- All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

-- ─── Core tables ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS polymarket_events (
  id            VARCHAR(32) PRIMARY KEY,
  slug          VARCHAR(255) UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  image         TEXT,
  icon          TEXT,
  tags          JSONB NOT NULL DEFAULT '[]',       -- kept temporarily for backward compat
  neg_risk      BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  closed        BOOLEAN NOT NULL DEFAULT false,
  start_date    TIMESTAMPTZ,
  end_date      TIMESTAMPTZ,
  search_vector TSVECTOR,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS polymarket_markets (
  id                 VARCHAR(32) PRIMARY KEY,
  event_id           VARCHAR(32) NOT NULL REFERENCES polymarket_events(id) ON DELETE CASCADE,
  question           TEXT NOT NULL,
  slug               VARCHAR(255),
  description        TEXT,
  image              TEXT,
  outcomes           JSONB NOT NULL DEFAULT '[]',
  group_item_title   TEXT,
  neg_risk           BOOLEAN NOT NULL DEFAULT false,
  active             BOOLEAN NOT NULL DEFAULT true,
  closed             BOOLEAN NOT NULL DEFAULT false,
  resolved_outcome   TEXT,
  start_date         TIMESTAMPTZ,
  end_date           TIMESTAMPTZ,
  closed_time        TIMESTAMPTZ,
  search_vector      TSVECTOR,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Normalized tags ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS polymarket_tags (
  id    VARCHAR(64) PRIMARY KEY,
  label VARCHAR(128) NOT NULL,
  slug  VARCHAR(128) NOT NULL
);

CREATE TABLE IF NOT EXISTS polymarket_event_tags (
  event_id VARCHAR(32) NOT NULL REFERENCES polymarket_events(id) ON DELETE CASCADE,
  tag_id   VARCHAR(64) NOT NULL REFERENCES polymarket_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, tag_id)
);

-- ─── Idempotent column additions (for existing installs) ────────────────────

ALTER TABLE polymarket_events
  ADD COLUMN IF NOT EXISTS image         TEXT,
  ADD COLUMN IF NOT EXISTS icon          TEXT,
  ADD COLUMN IF NOT EXISTS neg_risk      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS start_date    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_date      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

ALTER TABLE polymarket_markets
  ADD COLUMN IF NOT EXISTS image         TEXT,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS neg_risk      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS start_date    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_date      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_time   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_polymarket_markets_event_id  ON polymarket_markets(event_id);
CREATE INDEX IF NOT EXISTS idx_polymarket_events_active     ON polymarket_events(active, closed);
CREATE INDEX IF NOT EXISTS idx_polymarket_event_tags_tag_id ON polymarket_event_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_polymarket_events_search     ON polymarket_events USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_search    ON polymarket_markets USING GIN(search_vector);

-- ─── Full-text search triggers ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION polymarket_events_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_polymarket_events_search ON polymarket_events;
CREATE TRIGGER trg_polymarket_events_search
  BEFORE INSERT OR UPDATE OF title, description ON polymarket_events
  FOR EACH ROW EXECUTE FUNCTION polymarket_events_search_trigger();

CREATE OR REPLACE FUNCTION polymarket_markets_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.question, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_polymarket_markets_search ON polymarket_markets;
CREATE TRIGGER trg_polymarket_markets_search
  BEFORE INSERT OR UPDATE OF question, description ON polymarket_markets
  FOR EACH ROW EXECUTE FUNCTION polymarket_markets_search_trigger();

-- ─── Backfill search vectors for existing rows ──────────────────────────────

UPDATE polymarket_events SET search_vector =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'B')
WHERE search_vector IS NULL;

UPDATE polymarket_markets SET search_vector =
  setweight(to_tsvector('english', COALESCE(question, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'B')
WHERE search_vector IS NULL;

-- ─── Migrate JSONB tags → normalized tables (one-time, idempotent) ──────────

INSERT INTO polymarket_tags (id, label, slug)
SELECT DISTINCT
  tag->>'id',
  tag->>'label',
  tag->>'slug'
FROM polymarket_events,
     jsonb_array_elements(tags) AS tag
WHERE tag->>'id' IS NOT NULL
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label,
  slug  = EXCLUDED.slug;

INSERT INTO polymarket_event_tags (event_id, tag_id)
SELECT DISTINCT
  e.id,
  tag->>'id'
FROM polymarket_events e,
     jsonb_array_elements(e.tags) AS tag
WHERE tag->>'id' IS NOT NULL
ON CONFLICT DO NOTHING;
