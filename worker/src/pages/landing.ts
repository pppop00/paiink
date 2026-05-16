/**
 * GET / — landing page.
 *
 * Phase C: replaced the two-zone "newest 5 per zone" layout with a
 * single unified "trending" feed ranked by 3-day rolling likes (with a
 * 14-day candidate pool). Per-zone deep links sit below the list.
 *
 * KV cache: a 60-second TTL on the SQL result lets the homepage
 * handle bursts cheaply. The cache key segments by locale-language so
 * the EN/ZH copies can diverge if we later want per-language ranking;
 * today we don't filter by language, so all locales hit the same key.
 * Per the plan: "go with TTL-only (no explicit invalidate) — 60s
 * freshness is fine for an MVP".
 *
 * Locale: chrome strings come from `t(locale, ...)`. Article titles
 * and authors stay as-is (user data).
 */

import type { Env } from "../types";
import {
  listTopByRecentLikes,
  listUserLikedArticleIds,
  type RankedArticle,
} from "../db/queries";
import { escape } from "../util/html";
import { shell } from "../templates/shell";
import { articleRow } from "./_article_row";
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

/** Cache key for the homepage ranking. See KV cache notes above. */
const TOP_CACHE_KEY = "top:lang:all";
/** TTL in seconds for the homepage ranking cache. */
const TOP_CACHE_TTL = 60;
/** How many ranked articles to show on the landing. */
const TOP_LIMIT = 30;

async function loadRanked(env: Env): Promise<RankedArticle[]> {
  // KV is optional in the type so the Worker still builds without it
  // configured. If absent, we just hit D1 every request.
  const kv = env.KV_CACHE;
  if (kv) {
    try {
      const cached = await kv.get(TOP_CACHE_KEY, "json");
      if (cached && Array.isArray(cached)) {
        return cached as RankedArticle[];
      }
    } catch (e) {
      console.warn(`[landing] KV get failed: ${(e as Error).message}`);
    }
  }
  const fresh = await listTopByRecentLikes(env.DB, { limit: TOP_LIMIT });
  if (kv) {
    try {
      await kv.put(TOP_CACHE_KEY, JSON.stringify(fresh), {
        expirationTtl: TOP_CACHE_TTL,
      });
    } catch (e) {
      console.warn(`[landing] KV put failed: ${(e as Error).message}`);
    }
  }
  return fresh;
}

export async function renderLanding(req: Request, env: Env): Promise<Response> {
  const locale = getLocale(req);

  const [user, ranked] = await Promise.all([
    getCurrentUser(req, env),
    loadRanked(env),
  ]);

  // Bulk-resolve which of these articles the viewer has liked. Skip
  // the lookup for anonymous viewers — they can't have likes anyway.
  let likedIds = new Set<number>();
  if (user) {
    likedIds = await listUserLikedArticleIds(
      env.DB,
      user.id,
      ranked.map((a) => a.id),
    );
  }

  const parts: string[] = [];
  parts.push(`<section class="hero">
  <h1>${escape(t(locale, "landing.hero"))}</h1>
</section>`);

  parts.push(`<section class="zone">
  <p class="zone-roman">${escape(t(locale, "landing.trending_eyebrow"))}</p>`);
  if (ranked.length === 0) {
    parts.push(`<p class="empty">${escape(t(locale, "landing.empty"))}</p>`);
  } else {
    parts.push('<ul class="articles">');
    for (const a of ranked) {
      parts.push(
        `<li>${articleRow(a, locale, {
          liked: likedIds.has(a.id),
          logged_in: user !== null,
        })}</li>`,
      );
    }
    parts.push("</ul>");
  }
  parts.push("</section>");

  // Per-zone deep links — the unified ranking replaces the old zone
  // sections, but readers who want the canonical /finance/ or /web3/
  // index still need a way to get there.
  parts.push(`<section class="zone-nav">
  <a class="more" href="/finance/">${escape(t(locale, "landing.all_zones_finance"))}</a>
  <a class="more" href="/web3/">${escape(t(locale, "landing.all_zones_web3"))}</a>
</section>`);

  return new Response(
    shell({
      title: t(locale, "landing.title"),
      body: parts.join("\n"),
      user,
      wide: true,
      locale,
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Set a short browser cache; the KV layer already throttles
        // D1 reads, so this is just trimming the wire chatter.
        "cache-control": "public, max-age=60",
      },
    },
  );
}
