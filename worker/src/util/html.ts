/**
 * Small HTML/string helpers shared across page templates.
 *
 * Keep this file tiny — anything that grows complex (markdown, shell chrome,
 * etc.) should live in its own module.
 */

/**
 * HTML-entity escape, attribute-safe (quotes included). Mirrors Python's
 * `html.escape(s, quote=True)` used by site/build.py.
 */
export function escape(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Truncate a hash for display, keeping the leading 16 chars + ellipsis.
 * Used in /verify pages where we show a short content_sha256 but tooltip
 * the full value.
 */
export function shortHash(s: string, head = 16): string {
  if (!s) return "";
  if (s.length <= head + 4) return s;
  return s.slice(0, head) + "…";
}

/**
 * Format a Unix-seconds timestamp as an ISO date string (YYYY-MM-DD UTC).
 * Falls back to empty string for invalid inputs so callers can `|| "—"`.
 */
export function formatDate(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "";
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Try to extract a YYYY-MM-DD trailing date from a slug. Mirrors
 * site/build.py:_date_of so display dates match the static build for
 * already-migrated articles.
 */
export function dateFromSlug(slug: string | null | undefined): string {
  if (!slug) return "";
  const m = /(\d{4})-(\d{2})-(\d{2})$/.exec(slug);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * Best-effort display date: prefer date embedded in slug (matches the
 * static build's `_date_of`), fall back to a Unix timestamp.
 */
export function displayDate(
  slug: string | null | undefined,
  unixSeconds: number | null | undefined,
): string {
  return dateFromSlug(slug) || formatDate(unixSeconds);
}
