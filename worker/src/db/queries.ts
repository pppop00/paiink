/**
 * Typed D1 helpers — Phase A scope only.
 *
 * Phase A touches: articles, users (minimal lazy creation), rate_limits.
 * Functions for sessions / api_tokens / likes land in their respective
 * later phases — leave the columns alone here.
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
