/**
 * Shared types & constants for the paiink Worker.
 *
 * Single source of truth — every other module imports from here. Keep this
 * file in sync with:
 *   • schemas/ai-audit/v1.json (zone / language / license enums)
 *   • content/_meta/agreement-v{1,2}.md (AGREEMENT_V*_SHA256 hashes)
 *   • tools/verify_audit.py PINNED_AGREEMENT_HASHES
 *   • site/build.py (until Pages is decommissioned)
 *
 * Phase A scope: only the types Phase A code paths actually need are
 * exported. Phase B/C/D types (sessions, api_tokens, likes) live in the
 * D1 migration but get TS row interfaces added when those phases land.
 */

// ---------- enums ----------

export const LICENSES = ["CC-BY-NC-4.0", "CC-BY-4.0", "CC0-1.0", "ARR"] as const;
export type License = (typeof LICENSES)[number];

export const ZONES = ["finance", "web3"] as const;
export type Zone = (typeof ZONES)[number];

export const LANGUAGES = ["zh-CN", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

// ---------- pinned agreement hashes ----------
// Each hash is the SHA-256 of content/_meta/agreement-v<N>.md verbatim.
// Articles published while a given version was current are forever-pinned
// to that hash; mutating the markdown file would break verification.

export const AGREEMENT_V1_SHA256 =
  "d89b0a30554743958e704b4d825966fad2eb22b6399bc00d0a15809f8deed807";
export const AGREEMENT_V2_SHA256 =
  "ec4066647aad291af1e7e88387b3dbfea8c63fce13da3e5ba64f11299793a19d";
// AGREEMENT_V3_SHA256 lands in Phase D when the new copy ships. Intentionally
// absent for Phase A so a typo can't accidentally bake v3 into new manifests.

// Current agreement version baked into every new manifest in Phase A.
// Still v2; v3 ships in Phase D alongside the rewritten /submit page.
export const CURRENT_AGREEMENT_VERSION = "v2";
export const CURRENT_AGREEMENT_SHA256 = AGREEMENT_V2_SHA256;

// ---------- Cloudflare bindings ----------

export interface Env {
  /**
   * R2 bucket holding article bytes (HTML + manifest), agreements, and
   * the schema mirror. Layout:
   *   articles/<uuid>/index.html
   *   articles/<uuid>/ai-audit.json
   *   articles/<uuid>/assets/<name>          (reserved, unused today)
   *   agreements/agreement-v{1,2,3}.md
   *   schemas/ai-audit/v1.json
   *   exports/<uuid>.tar.gz                  (Phase A/E export bundles)
   */
  R2_CONTENT: R2Bucket;

  /** D1 primary store — users, articles, sessions, tokens, likes, rate_limits. */
  DB: D1Database;

  /** Hot cache for top-likes ranking. Populated starting Phase C. */
  KV_CACHE?: KVNamespace;

  /**
   * Legacy IP-based rate-limit KV from the GitHub-commit era. Kept
   * fail-soft for the duration of the migration; D1 rate_limits is the
   * canonical store in Phase A+.
   */
  KV_RATE_LIMIT?: KVNamespace;

  /** Workers Static Assets binding — serves /static/style.css etc. */
  ASSETS: Fetcher;

  /** Override of the public site URL. Defaults to https://www.paiink.com. */
  SITE_URL?: string;

  /**
   * Anonymous GitHub PAT used only for skill-repo public/commit checks
   * (read-only, never writes to our content). Optional — checks fall
   * back to anonymous fetches if absent. NOT the old commit-author PAT.
   */
  GITHUB_TOKEN?: string;

  /** Reserved for Phase B; unused in Phase A. */
  TURNSTILE_SECRET?: string;
}

// ---------- ai-audit manifest (matches schemas/ai-audit/v1.json) ----------
// Byte-stable: once serialized to R2, never re-serialize. content_sha256 is
// the contract with readers.

export interface Manifest {
  schema: string;
  schema_version: string;
  article: {
    id: string;
    title: string;
    category: Zone;
    language: Language;
    license: License;
    published_at: string;
    content_sha256: string;
    content_path: string; // always "index.html" in current submissions
    assets: never[];      // currently always empty
    word_count: number;
  };
  skill: {
    name: string;
    repo_url: string;
    repo_commit: string;
  };
  generation: {
    model: string;
    harness: string;
    api_request_id?: string;
  };
  author: {
    email: string;
    display_name: string;
  };
  agreement: {
    version: string;
    sha256: string;
    accepted_at: string;
  };
}

// ---------- D1 row shapes ----------

export interface ArticleRow {
  id: number;
  /**
   * Public-facing article identifier used in /verify/<uuid> and as the R2
   * key prefix. New articles get a 26-char Crockford-base32 ULID; the 4
   * migrated articles keep their existing UUID v4 so old verify links and
   * manifest bytes remain valid. Both shapes are TEXT in D1.
   */
  uuid: string;
  zone: Zone;
  slug: string; // unique within (zone, slug); auto-versioned on collision
  language: Language;
  title: string;
  author_id: number;
  /** Denormalized author fields — preserve manifest data if the user later edits their profile. */
  author_email: string;
  author_display_name: string;
  content_sha256: string;
  word_count: number;
  license: License;
  agreement_version: string;
  agreement_sha256: string;
  skill_name: string;
  skill_repo_url: string;
  skill_repo_commit: string;
  model: string;
  harness: string;
  api_request_id: string | null;
  /** Unix seconds. Falls back to published_at if the manifest has no generation timestamp. */
  finished_at: number;
  published_at: number;
  retracted_at: number | null;
  retraction_reason: string | null;
  like_count: number;
  created_at: number;
}

export interface UserRow {
  id: number;
  /** Case-insensitive unique. PBKDF2-hashed credential set in Phase B. */
  email: string;
  /** NULL = unclaimed; set when the user signs up in Phase B. */
  password_hash: string | null;
  display_name: string;
  /** Case-insensitive unique; used in /u/<handle>. */
  handle: string;
  /** 'zh-CN' | 'en'. Defaults to 'zh-CN' at row creation. */
  ui_lang: string;
  created_at: number;
  deleted_at: number | null;
}

// ---------- error type ----------

/**
 * Thrown by helpers, caught at the request boundary. Status maps to HTTP
 * status, code is a short machine-readable string, detail is the
 * human-readable explanation. Mirrors the shape used in src/index.ts.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}
