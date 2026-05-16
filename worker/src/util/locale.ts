/**
 * Per-request locale resolution.
 *
 * Priority:
 *   1. The `paiink_lang` cookie — set by the masthead 中/EN toggle.
 *   2. The first `Accept-Language` token we recognize.
 *   3. DEFAULT_LOCALE (zh-CN).
 *
 * No D1 lookup: the cookie is the source of truth. We deliberately ignore
 * `users.ui_lang` for rendering — a logged-in user who wants English
 * everywhere just clicks "EN" once and the cookie sticks for a year. That
 * also lets anonymous CN readers visiting a US-shared link flip to Chinese
 * without signing up.
 */

import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n";

const COOKIE_NAME = "paiink_lang";

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isLocale(s: string | undefined): s is Locale {
  return !!s && (LOCALES as string[]).includes(s);
}

/**
 * Pull the first acceptable locale out of an Accept-Language header.
 * Strips quality factors and matches on the prefix — `zh-TW` becomes
 * `zh-CN` because that's the closest Chinese variant we ship.
 */
function fromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  // Sort by q-factor descending (header default is q=1.0).
  const tokens = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      let q = 1.0;
      for (const p of params) {
        const [k, v] = p.split("=").map((s) => s.trim());
        if (k === "q" && v) {
          const parsed = parseFloat(v);
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { tag: (tag || "").toLowerCase(), q };
    })
    .filter((t) => t.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tokens) {
    if (tag === "zh-cn" || tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return null;
}

/**
 * Determine the locale for this request. Always returns a valid Locale.
 */
export function getLocale(req: Request): Locale {
  const cookies = parseCookies(req.headers.get("cookie"));
  const fromCookie = cookies[COOKIE_NAME];
  if (isLocale(fromCookie)) return fromCookie;

  const fromHeader = fromAcceptLanguage(req.headers.get("accept-language"));
  if (fromHeader) return fromHeader;

  return DEFAULT_LOCALE;
}
