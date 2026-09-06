CREATE TABLE IF NOT EXISTS auth_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  user_id    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens (email);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens (user_id);
