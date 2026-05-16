/**
 * Slug generation + auto-versioning.
 *
 * Phase A change vs pre-Phase-A: collision check used to hit the GitHub
 * tree API (`GET /repos/.../contents/content/<zone>/<candidate>`). It
 * now queries D1 (`SELECT 1 FROM articles WHERE zone = ? AND slug = ?`).
 * Auto-version algorithm is unchanged: `<base>`, `<base>-v2`, ...,
 * `<base>-v100`, then 409.
 */
import { HttpError, type Zone } from "../types";
import { slugExists } from "../db/queries";

const SLUG_MAX_VERSION = 100;

/**
 * Convert a title to a URL-safe kebab slug. CJK and other non-alnum
 * characters are treated as separators; the result is lowercase ASCII.
 * Returns "" when the title contains no alnum characters — callers
 * should fall back to a UUID-derived stem in that case.
 */
export function kebabSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Current UTC date as YYYY-MM-DD (used to suffix base slugs). */
export function todayUtcDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Pick the first available slug in (zone). Returns `baseSlug` if free,
 * else `baseSlug-v2`, `-v3`, ..., up to `-v100`. Throws 409 if all
 * 100 versions are taken (means the user should pick a new title).
 *
 * The D1 query is `slugExists(db, zone, candidate)`; see db/queries.ts.
 */
export async function pickAvailableSlug(
  db: D1Database,
  zone: Zone,
  baseSlug: string,
): Promise<string> {
  for (let v = 1; v <= SLUG_MAX_VERSION; v++) {
    const candidate = v === 1 ? baseSlug : `${baseSlug}-v${v}`;
    const exists = await slugExists(db, zone, candidate);
    if (!exists) return candidate;
  }
  throw new HttpError(409, "slug", "too many versions; pick a new title");
}
