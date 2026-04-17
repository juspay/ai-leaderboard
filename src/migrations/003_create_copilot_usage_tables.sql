CREATE TABLE IF NOT EXISTS copilot_usage_snapshots (
  id BIGSERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('org', 'user')),
  scope_name TEXT NOT NULL,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL DEFAULT 0,
  period_day INTEGER NOT NULL DEFAULT 0,
  github_username TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  unit_type TEXT NOT NULL DEFAULT '',
  price_per_unit DOUBLE PRECISION,
  gross_quantity DOUBLE PRECISION,
  gross_amount DOUBLE PRECISION,
  discount_quantity DOUBLE PRECISION,
  discount_amount DOUBLE PRECISION,
  net_quantity DOUBLE PRECISION,
  net_amount DOUBLE PRECISION,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_copilot_usage_snapshots_natural
  ON copilot_usage_snapshots (
    scope_type,
    scope_name,
    period_year,
    period_month,
    period_day,
    github_username,
    product,
    sku,
    model
  );

CREATE INDEX IF NOT EXISTS idx_copilot_usage_snapshots_scope_period
  ON copilot_usage_snapshots (scope_type, scope_name, period_year, period_month, period_day);

CREATE INDEX IF NOT EXISTS idx_copilot_usage_snapshots_username
  ON copilot_usage_snapshots (github_username);

CREATE TABLE IF NOT EXISTS user_provider_identities (
  id BIGSERIAL PRIMARY KEY,
  leaderboard_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_username TEXT NOT NULL,
  external_org TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (leaderboard_user_id, provider),
  UNIQUE (provider, external_username)
);

CREATE INDEX IF NOT EXISTS idx_user_provider_identities_lookup
  ON user_provider_identities (provider, external_username);
