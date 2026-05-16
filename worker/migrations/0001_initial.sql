-- 0001_initial.sql
--
-- Full Phase A-E schema in a single migration. Phase A only writes
-- users (minimal), articles, and rate_limits; later phases populate
-- sessions, api_tokens, and likes without touching this file.
--
-- Apply with: wrangler d1 execute paiink --file worker/migrations/0001_initial.sql
-- Re-running is safe: every CREATE uses IF NOT EXISTS.

-- ---------- users ----------
-- Minimum surface for Phase A: lazy creation when an article is
-- migrated or submitted. password_hash stays NULL until the user
-- signs up in Phase B (PBKDF2-HMAC-SHA256, 600k iter, "salt$hash").
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                                       -- NULL until Phase B signup
  display_name  TEXT NOT NULL,
  handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,        -- /u/<handle>
  ui_lang       TEXT NOT NULL DEFAULT 'zh-CN',              -- 'zh-CN' | 'en'
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER
);

-- ---------- sessions (Phase B) ----------
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,                            -- 256-bit hex
  user_id      INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER NOT NULL,                            -- 90d rolling
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ip_created   TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------- api_tokens (Phase E) ----------
CREATE TABLE IF NOT EXISTS api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  prefix        TEXT NOT NULL,                              -- pai_xxxxxxxx, shown in UI
  token_sha256  TEXT NOT NULL UNIQUE,                       -- sha256 of full token
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- ---------- articles ----------
-- author_email + author_display_name are denormalized on purpose: the
-- manifest captures the author's identity at publish time. If the user
-- later changes their profile, the manifest bytes don't move (they
-- can't — content_sha256 would break), so we keep the original strings
-- here as the source of truth for re-serving the manifest from D1.
CREATE TABLE IF NOT EXISTS articles (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                TEXT NOT NULL UNIQUE,                 -- 22-char ULID or legacy UUID v4
  zone                TEXT NOT NULL,                        -- 'finance' | 'web3'
  slug                TEXT NOT NULL,                        -- unique within (zone)
  language            TEXT NOT NULL,                        -- 'zh-CN' | 'en'
  title               TEXT NOT NULL,
  author_id           INTEGER NOT NULL REFERENCES users(id),
  author_email        TEXT NOT NULL,                        -- denorm; matches manifest at publish
  author_display_name TEXT NOT NULL,                        -- denorm; matches manifest at publish
  content_sha256      TEXT NOT NULL,
  word_count          INTEGER NOT NULL,
  license             TEXT NOT NULL,
  agreement_version   TEXT NOT NULL,                        -- 'v1' | 'v2' | 'v3' (Phase D)
  agreement_sha256    TEXT NOT NULL,
  skill_name          TEXT NOT NULL,
  skill_repo_url      TEXT NOT NULL,
  skill_repo_commit   TEXT NOT NULL,
  model               TEXT NOT NULL,
  harness             TEXT NOT NULL,
  api_request_id      TEXT,
  finished_at         INTEGER NOT NULL,                     -- unix seconds
  published_at        INTEGER NOT NULL,                     -- unix seconds
  retracted_at        INTEGER,                              -- soft delete; 404s URL, keeps row
  retraction_reason   TEXT,
  like_count          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_zone_slug  ON articles(zone, slug);
CREATE INDEX        IF NOT EXISTS idx_articles_published ON articles(published_at DESC) WHERE retracted_at IS NULL;
CREATE INDEX        IF NOT EXISTS idx_articles_author    ON articles(author_id, published_at DESC);
CREATE INDEX        IF NOT EXISTS idx_articles_language  ON articles(language, published_at DESC) WHERE retracted_at IS NULL;
CREATE INDEX        IF NOT EXISTS idx_articles_uuid      ON articles(uuid);

-- ---------- likes (Phase C) ----------
CREATE TABLE IF NOT EXISTS likes (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  article_id INTEGER NOT NULL REFERENCES articles(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_recent ON likes(created_at DESC, article_id);
CREATE INDEX IF NOT EXISTS idx_likes_user   ON likes(user_id, created_at DESC);

-- ---------- rate_limits ----------
-- Scope examples: 'ip:1.2.3.4', 'user:42', 'signup-ip:1.2.3.4',
-- 'submit-user:42', 'like-user:42'. window_start is a UTC day boundary
-- (unixepoch() / 86400 * 86400) — collapses to a single counter per
-- scope per day. INSERT ... ON CONFLICT increments atomically.
CREATE TABLE IF NOT EXISTS rate_limits (
  scope        TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
