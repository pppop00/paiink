/**
 * Typed D1 helpers — Phase A + Phase B scope.
 *
 * Phase A touches: articles, users (minimal lazy creation), rate_limits.
 * Phase B adds: users (claim + password), sessions, api_tokens,
 *              per-author article listing + soft-retract.
 *
 * Functions for likes land in their respective later phases — leave
 * those columns alone here.
 *
 * Convention: every function takes the D1Database as its first arg so
 * callers can pass either `env.DB` or a transaction wrapper later.
 */

import type {
  ArticleRow,
  Language,
  UserRow,
  Zone,
} from "../types";
import { HttpError } from "../types";
import { randomTokenHex, sha256Hex } from "../util/crypto";

// ---------- articles ----------

/** SELECT-list for articles. Keep in sync with the ArticleRow mapping below. */
const ARTICLE_COLS = `
  id, uuid, zone, slug, language, title, author_id, author_email,
  author_display_name, content_sha256, word_count, license,
  agreement_version, agreement_sha256, skill_name, skill_repo_url,
  skill_repo_commit, model, harness, api_request_id, finished_at,
  published_at, retracted_at, retraction_reason, like_count, created_at
`.trim();

interface RawArticleRow {
  id: number;
  uuid: string;
  zone: string;
  slug: string;
  language: string;
  title: string;
  author_id: number;
  author_email: string;
  author_display_name: string;
  content_sha256: string;
  word_count: number;
  license: string;
  agreement_version: string;
  agreement_sha256: string;
  skill_name: string;
  skill_repo_url: string;
  skill_repo_commit: string;
  model: string;
  harness: string;
  api_request_id: string | null;
  finished_at: number;
  published_at: number;
  retracted_at: number | null;
  retraction_reason: string | null;
  like_count: number;
  created_at: number;
}

function rowToArticle(r: RawArticleRow): ArticleRow {
  return r as ArticleRow;
}

export async function getArticleByZoneSlug(
  db: D1Database,
  zone: Zone,
  slug: string,
): Promise<ArticleRow | null> {
  const row = await db
    .prepare(`SELECT ${ARTICLE_COLS} FROM articles WHERE zone = ?1 AND slug = ?2 LIMIT 1`)
    .bind(zone, slug)
    .first<RawArticleRow>();
  return row ? rowToArticle(row) : null;
}

export async function getArticleByUuid(
  db: D1Database,
  uuid: string,
): Promise<ArticleRow | null> {
  const row = await db
    .prepare(`SELECT ${ARTICLE_COLS} FROM articles WHERE uuid = ?1 LIMIT 1`)
    .bind(uuid)
    .first<RawArticleRow>();
  return row ? rowToArticle(row) : null;
}

export interface ListByZoneOptions {
  limit?: number;
  offset?: number;
  language?: Language;
}

export async function listArticlesByZone(
  db: D1Database,
  zone: Zone,
  opts: ListByZoneOptions = {},
): Promise<ArticleRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let sql = `SELECT ${ARTICLE_COLS} FROM articles
             WHERE zone = ?1 AND retracted_at IS NULL`;
  const binds: (string | number)[] = [zone];
  if (opts.language) {
    sql += ` AND language = ?${binds.length + 1}`;
    binds.push(opts.language);
  }
  sql += ` ORDER BY published_at DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`;
  binds.push(limit, offset);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<RawArticleRow>();
  return (results ?? []).map(rowToArticle);
}

export interface ListRecentOptions {
  limit?: number;
  language?: Language;
}

/**
 * Used by the landing page in Phase A. Phase C swaps in a 3-day
 * rolling like-rank query; this stays as the "latest" fallback.
 */
export async function listRecentArticles(
  db: D1Database,
  opts: ListRecentOptions = {},
): Promise<ArticleRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  let sql = `SELECT ${ARTICLE_COLS} FROM articles
             WHERE retracted_at IS NULL`;
  const binds: (string | number)[] = [];
  if (opts.language) {
    sql += ` AND language = ?${binds.length + 1}`;
    binds.push(opts.language);
  }
  sql += ` ORDER BY published_at DESC LIMIT ?${binds.length + 1}`;
  binds.push(limit);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<RawArticleRow>();
  return (results ?? []).map(rowToArticle);
}

export type InsertArticleInput = Omit<
  ArticleRow,
  "id" | "created_at" | "like_count" | "retracted_at" | "retraction_reason"
>;

/** Inserts an article and returns the new row id. */
export async function insertArticle(
  db: D1Database,
  row: InsertArticleInput,
): Promise<number> {
  const stmt = db
    .prepare(
      `INSERT INTO articles (
         uuid, zone, slug, language, title, author_id, author_email,
         author_display_name, content_sha256, word_count, license,
         agreement_version, agreement_sha256, skill_name, skill_repo_url,
         skill_repo_commit, model, harness, api_request_id, finished_at,
         published_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18, ?19, ?20, ?21
       )`,
    )
    .bind(
      row.uuid,
      row.zone,
      row.slug,
      row.language,
      row.title,
      row.author_id,
      row.author_email,
      row.author_display_name,
      row.content_sha256,
      row.word_count,
      row.license,
      row.agreement_version,
      row.agreement_sha256,
      row.skill_name,
      row.skill_repo_url,
      row.skill_repo_commit,
      row.model,
      row.harness,
      row.api_request_id,
      row.finished_at,
      row.published_at,
    );
  const result = await stmt.run();
  // D1 surfaces last_row_id via meta on success
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new HttpError(500, "db_error", "INSERT INTO articles returned no last_row_id");
  }
  return id;
}

/** Cheap existence check for slug auto-versioning. */
export async function slugExists(
  db: D1Database,
  zone: Zone,
  slug: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM articles WHERE zone = ?1 AND slug = ?2 LIMIT 1`)
    .bind(zone, slug)
    .first<{ hit: number }>();
  return row !== null;
}

// ---------- users (Phase A minimal) ----------

const USER_COLS = `id, email, password_hash, display_name, handle, ui_lang, created_at, deleted_at`;

interface RawUserRow {
  id: number;
  email: string;
  password_hash: string | null;
  display_name: string;
  handle: string;
  ui_lang: string;
  created_at: number;
  deleted_at: number | null;
}

function rowToUser(r: RawUserRow): UserRow {
  return r;
}

/** Kebab a display name into a handle candidate. */
function kebabHandle(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "user";
}

function randomSuffix(): string {
  // 4-char base36 — collision odds at our scale are fine
  const arr = new Uint8Array(3);
  crypto.getRandomValues(arr);
  let v = (arr[0] << 16) | (arr[1] << 8) | arr[2];
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += "0123456789abcdefghijklmnopqrstuvwxyz"[v % 36];
    v = Math.floor(v / 36);
  }
  return out;
}

/**
 * Phase A: lazy-create a user row keyed by email when an article is
 * submitted under a name we don't know yet. Phase B's signup will set
 * password_hash on the existing row (claim flow) — emails already
 * captured here remain valid. handle is unique; we retry with a random
 * suffix on collision (up to 8 attempts).
 */
export async function getOrCreateUserByEmail(
  db: D1Database,
  email: string,
  displayName: string,
): Promise<UserRow> {
  const normalized = email.trim();
  if (!normalized) {
    throw new HttpError(400, "validation", "email required");
  }
  const existing = await db
    .prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1`)
    .bind(normalized)
    .first<RawUserRow>();
  if (existing) return rowToUser(existing);

  const baseHandle = kebabHandle(displayName);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = attempt === 0 ? baseHandle : `${baseHandle}-${randomSuffix()}`;
    try {
      const result = await db
        .prepare(
          `INSERT INTO users (email, display_name, handle, ui_lang, created_at)
           VALUES (?1, ?2, ?3, 'zh-CN', unixepoch())`,
        )
        .bind(normalized, displayName, candidate)
        .run();
      const id = result.meta?.last_row_id;
      if (typeof id !== "number") {
        throw new HttpError(500, "db_error", "INSERT INTO users returned no last_row_id");
      }
      const row = await db
        .prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?1`)
        .bind(id)
        .first<RawUserRow>();
      if (!row) {
        throw new HttpError(500, "db_error", "user inserted but not found");
      }
      return rowToUser(row);
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // D1 surfaces sqlite UNIQUE failures as a generic error string. We
      // can't distinguish email-collision from handle-collision cheaply
      // post-fact, so re-check email and retry handle.
      if (/UNIQUE/i.test(msg)) {
        const raced = await db
          .prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1`)
          .bind(normalized)
          .first<RawUserRow>();
        if (raced) return rowToUser(raced);
        // handle collision — continue loop with a fresh suffix
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(
    500,
    "db_error",
    `could not allocate unique handle for "${displayName}" (last: ${String(lastError)})`,
  );
}

// ---------- rate_limits ----------

/**
 * Atomically increment the counter at (scope, window_start) and return
 * the new value. Window boundaries are UTC days computed by the caller
 * (unixepoch() / 86400 * 86400); pass that as window_start.
 */
export async function incrementRateLimit(
  db: D1Database,
  scope: string,
  windowStart: number,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (scope, window_start, count)
       VALUES (?1, ?2, 1)
       ON CONFLICT(scope, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(scope, windowStart)
    .first<{ count: number }>();
  if (!row || typeof row.count !== "number") {
    throw new HttpError(500, "db_error", "rate_limit upsert returned no count");
  }
  return row.count;
}

/** Read-only fetch; returns 0 if no row exists yet. */
export async function getRateLimit(
  db: D1Database,
  scope: string,
  windowStart: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT count FROM rate_limits WHERE scope = ?1 AND window_start = ?2`)
    .bind(scope, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// ===================================================================
// Phase B additions: users (signup/claim), sessions, api_tokens,
// per-author article queries.
// ===================================================================

// ---------- users (Phase B signup/claim) ----------

export interface CreateUserInput {
  email: string;
  password_hash: string;          // pre-hashed by util/crypto.hashPassword
  display_name: string;
  handle: string;
  ui_lang?: string;               // default 'zh-CN'
}

/**
 * Insert a fully-formed user. Used by the signup handler after Turnstile
 * + payload validation has passed. The caller is responsible for hashing
 * the password (util/crypto.hashPassword) before calling.
 *
 * Throws HttpError(409, "email_taken") if `email` collides and the
 * existing row already has a password_hash (genuine duplicate signup).
 * Throws HttpError(409, "handle_taken") if `handle` collides.
 * If the email row exists but is unclaimed (password_hash IS NULL), the
 * caller should detect this via findUserByEmail first and use claimUser
 * instead — createUser does NOT auto-claim.
 */
export async function createUser(
  db: D1Database,
  input: CreateUserInput,
): Promise<UserRow> {
  const email = input.email.trim();
  const handle = input.handle.trim();
  if (!email) throw new HttpError(400, "validation", "email required");
  if (!handle) throw new HttpError(400, "validation", "handle required");
  if (!input.display_name) throw new HttpError(400, "validation", "display_name required");
  if (!input.password_hash) throw new HttpError(400, "validation", "password_hash required");

  try {
    const result = await db
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, handle, ui_lang, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())`,
      )
      .bind(
        email,
        input.password_hash,
        input.display_name,
        handle,
        input.ui_lang ?? "zh-CN",
      )
      .run();
    const id = result.meta?.last_row_id;
    if (typeof id !== "number") {
      throw new HttpError(500, "db_error", "INSERT INTO users returned no last_row_id");
    }
    const row = await db
      .prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?1`)
      .bind(id)
      .first<RawUserRow>();
    if (!row) throw new HttpError(500, "db_error", "user inserted but not found");
    return rowToUser(row);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) {
      // Distinguish email collision vs handle collision by probing.
      const emailHit = await db
        .prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1`)
        .bind(email)
        .first<RawUserRow>();
      if (emailHit) {
        throw new HttpError(409, "email_taken", "email is already registered");
      }
      throw new HttpError(409, "handle_taken", "handle is already taken");
    }
    throw err;
  }
}

/**
 * Lookup by email. Case-insensitive (the column carries COLLATE NOCASE).
 * Returns null if no row matches.
 */
export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  const normalized = email.trim();
  if (!normalized) return null;
  const row = await db
    .prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1`)
    .bind(normalized)
    .first<RawUserRow>();
  return row ? rowToUser(row) : null;
}

/**
 * Lookup by handle. Case-insensitive. Used by /u/<handle> routes and
 * by signup handle-availability checks.
 */
export async function findUserByHandle(
  db: D1Database,
  handle: string,
): Promise<UserRow | null> {
  const normalized = handle.trim();
  if (!normalized) return null;
  const row = await db
    .prepare(`SELECT ${USER_COLS} FROM users WHERE handle = ?1 COLLATE NOCASE LIMIT 1`)
    .bind(normalized)
    .first<RawUserRow>();
  return row ? rowToUser(row) : null;
}

/**
 * Lookup by primary key. Used by the auth middleware after a session
 * hit. Returns null if the row is missing.
 */
export async function findUserById(
  db: D1Database,
  id: number,
): Promise<UserRow | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?1 LIMIT 1`)
    .bind(id)
    .first<RawUserRow>();
  return row ? rowToUser(row) : null;
}

/**
 * Set the password on a previously-lazy user row (password_hash IS NULL).
 * Returns true if a row was claimed (UPDATE affected 1 row); returns
 * false if the row is missing, deleted, or already claimed (race with
 * another signup or a prior claim). The CAS uses
 * `WHERE id = ?1 AND password_hash IS NULL`.
 */
export async function claimUser(
  db: D1Database,
  id: number,
  password_hash: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET password_hash = ?2
       WHERE id = ?1 AND password_hash IS NULL AND deleted_at IS NULL`,
    )
    .bind(id, password_hash)
    .run();
  // D1 surfaces affected-row count on meta.changes.
  const changes = result.meta?.changes ?? 0;
  return changes >= 1;
}

// ---------- sessions ----------

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip_created: string | null;
  user_agent: string | null;
}

interface RawSessionRow {
  id: string;
  user_id: number;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip_created: string | null;
  user_agent: string | null;
}

const SESSION_COLS = `id, user_id, created_at, expires_at, last_seen_at, ip_created, user_agent`;

/** Default 90 days, matches util/session.SESSION_MAX_AGE_SEC. */
const DEFAULT_SESSION_TTL_SEC = 90 * 24 * 3600;

export interface CreateSessionInput {
  user_id: number;
  ttl_sec?: number;
  ip?: string | null;
  user_agent?: string | null;
}

/**
 * Mint a new session row. Returns the 64-char hex session id. The
 * caller hands the id to util/session.setSessionCookie().
 *
 * Collision odds for a 256-bit id are negligible, but if D1 reports a
 * UNIQUE violation we retry once with a fresh id rather than 500-ing.
 */
export async function createSession(
  db: D1Database,
  input: CreateSessionInput,
): Promise<string> {
  const ttl = input.ttl_sec ?? DEFAULT_SESSION_TTL_SEC;
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomTokenHex(32);
    try {
      await db
        .prepare(
          `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip_created, user_agent)
           VALUES (?1, ?2, unixepoch(), unixepoch() + ?3, unixepoch(), ?4, ?5)`,
        )
        .bind(id, input.user_id, ttl, input.ip ?? null, input.user_agent ?? null)
        .run();
      return id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && /UNIQUE/i.test(msg)) continue;
      throw err;
    }
  }
  // Loop falls through only if both attempts UNIQUE-collided (cosmic-ray odds).
  throw new HttpError(500, "db_error", "could not allocate unique session id");
}

/**
 * Resolve a session id to its row, filtering out expired sessions.
 * Returns null if the id doesn't exist or if `expires_at` is in the past.
 */
export async function findSession(
  db: D1Database,
  sessionId: string,
): Promise<SessionRow | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare(
      `SELECT ${SESSION_COLS} FROM sessions
       WHERE id = ?1 AND expires_at > unixepoch() LIMIT 1`,
    )
    .bind(sessionId)
    .first<RawSessionRow>();
  return row ? (row as SessionRow) : null;
}

/**
 * Bump `last_seen_at`. Fire-and-forget from auth middleware — failures
 * here are non-fatal. We don't extend expires_at: 90 days is a hard
 * lifetime, not a sliding one (re-login if you've been inactive
 * 3 months).
 */
export async function touchSession(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  await db
    .prepare(`UPDATE sessions SET last_seen_at = unixepoch() WHERE id = ?1`)
    .bind(sessionId)
    .run();
}

/** Logout: delete a single session. No error if it didn't exist. */
export async function deleteSession(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  await db.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(sessionId).run();
}

/**
 * "Log out everywhere" — delete all sessions for a user. Returns the
 * number of rows deleted (best-effort; reads D1 meta.changes).
 * Phase B+ admin / "panic" feature; not surfaced in the UI yet.
 */
export async function deleteUserSessions(
  db: D1Database,
  userId: number,
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM sessions WHERE user_id = ?1`)
    .bind(userId)
    .run();
  return result.meta?.changes ?? 0;
}

// ---------- api_tokens ----------

/**
 * The fields safe to expose to the user-facing /me API. Plaintext token
 * and the sha256 column are deliberately excluded — plaintext is never
 * persisted at all, and the hash is a server-only fingerprint.
 */
export interface ApiTokenSafe {
  id: number;
  prefix: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreateTokenResult {
  id: number;
  prefix: string;
  /** Shown to the user exactly once; never re-derivable from the DB. */
  plaintext: string;
}

interface RawApiTokenRow {
  id: number;
  prefix: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const API_TOKEN_SAFE_COLS = `id, prefix, name, created_at, last_used_at, revoked_at`;

/**
 * Mint a new API token for the given user. Returns the plaintext to
 * surface in the response body (the only chance to read it). The
 * plaintext format is `pai_<8hex>_<32hex>` — 40 hex chars of entropy
 * (160 bits) after the prefix, well above any practical brute-force
 * threshold. Only the sha256 of the plaintext is stored.
 */
export async function createApiToken(
  db: D1Database,
  user_id: number,
  name: string,
): Promise<CreateTokenResult> {
  if (!name || !name.trim()) {
    throw new HttpError(400, "validation", "token name required");
  }
  // 4-byte (8 hex char) prefix + 20-byte (40 hex char) body.
  // prefix doubles as a visible label in /me; body carries the entropy.
  const prefix = `pai_${randomTokenHex(4)}`;
  const body = randomTokenHex(20);
  const plaintext = `${prefix}_${body}`;
  const tokenHash = await sha256Hex(plaintext);

  const result = await db
    .prepare(
      `INSERT INTO api_tokens (user_id, prefix, token_sha256, name, created_at)
       VALUES (?1, ?2, ?3, ?4, unixepoch())`,
    )
    .bind(user_id, prefix, tokenHash, name.trim())
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new HttpError(500, "db_error", "INSERT INTO api_tokens returned no last_row_id");
  }
  return { id, prefix, plaintext };
}

/**
 * List the tokens a user has issued. Includes revoked rows so the UI
 * can show "revoked on 2026-05-12" entries — the caller filters as
 * needed. Newest-first.
 */
export async function listApiTokens(
  db: D1Database,
  user_id: number,
): Promise<ApiTokenSafe[]> {
  const { results } = await db
    .prepare(
      `SELECT ${API_TOKEN_SAFE_COLS} FROM api_tokens
       WHERE user_id = ?1
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(user_id)
    .all<RawApiTokenRow>();
  return (results ?? []) as ApiTokenSafe[];
}

/**
 * Resolve a plaintext API token to its bound user_id. Returns null if
 * the token doesn't exist, is revoked, or the user is deleted.
 *
 * Side effect: bumps `last_used_at` (fire-and-forget — a slow write
 * shouldn't block the request).
 */
export async function findApiTokenUserId(
  db: D1Database,
  plaintext: string,
): Promise<number | null> {
  if (!plaintext) return null;
  const tokenHash = await sha256Hex(plaintext);
  const row = await db
    .prepare(
      `SELECT api_tokens.id AS id, api_tokens.user_id AS user_id,
              api_tokens.revoked_at AS revoked_at,
              users.deleted_at AS user_deleted_at
       FROM api_tokens
       LEFT JOIN users ON users.id = api_tokens.user_id
       WHERE api_tokens.token_sha256 = ?1 LIMIT 1`,
    )
    .bind(tokenHash)
    .first<{
      id: number;
      user_id: number;
      revoked_at: number | null;
      user_deleted_at: number | null;
    }>();
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.user_deleted_at !== null) return null;

  // Fire-and-forget last_used_at update. Don't await — we don't want
  // a slow D1 write to lengthen every authed request.
  db.prepare(`UPDATE api_tokens SET last_used_at = unixepoch() WHERE id = ?1`)
    .bind(row.id)
    .run()
    .catch((e) => {
      console.warn(`[api_token] last_used_at bump failed: ${(e as Error).message}`);
    });

  return row.user_id;
}

/**
 * Mark a token as revoked. The user_id arg is a guard rail: even if an
 * attacker stole a session, they can only revoke tokens belonging to
 * the session's user. Returns true if a row was updated.
 */
export async function revokeApiToken(
  db: D1Database,
  id: number,
  user_id: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE api_tokens SET revoked_at = unixepoch()
       WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
    )
    .bind(id, user_id)
    .run();
  const changes = result.meta?.changes ?? 0;
  return changes >= 1;
}

// ---------- articles (Phase B additions) ----------

export interface ListByUserOptions {
  limit?: number;
  offset?: number;
}

/**
 * List a user's articles, newest-first. INCLUDES retracted articles
 * (the caller — typically /me/articles — decides what to show; authors
 * see their own withdrawn pieces).
 */
export async function listArticlesByUserId(
  db: D1Database,
  user_id: number,
  opts: ListByUserOptions = {},
): Promise<ArticleRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { results } = await db
    .prepare(
      `SELECT ${ARTICLE_COLS} FROM articles
       WHERE author_id = ?1
       ORDER BY published_at DESC, id DESC
       LIMIT ?2 OFFSET ?3`,
    )
    .bind(user_id, limit, offset)
    .all<RawArticleRow>();
  return (results ?? []).map(rowToArticle);
}

/**
 * Soft-retract: set retracted_at + retraction_reason, only if the
 * caller owns the article and it isn't already retracted. The
 * underlying R2 bytes and per-deploy CIDs are NOT touched — manifests
 * remain verifiable, but the canonical URL 404s.
 *
 * `reason` is required by agreement v2 (the author asserts WHY a piece
 * is being withdrawn — typo, factual error, legal request, etc.).
 * Returns true if a row was updated.
 */
export async function retractArticle(
  db: D1Database,
  uuid: string,
  user_id: number,
  reason: string,
): Promise<boolean> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new HttpError(400, "validation", "retraction reason required");
  }
  const result = await db
    .prepare(
      `UPDATE articles
       SET retracted_at = unixepoch(), retraction_reason = ?3
       WHERE uuid = ?1 AND author_id = ?2 AND retracted_at IS NULL`,
    )
    .bind(uuid, user_id, trimmed)
    .run();
  const changes = result.meta?.changes ?? 0;
  return changes >= 1;
}
