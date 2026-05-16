/**
 * GET / — landing page.
 *
 * Phase C: replaced the two-zone "newest 5 per zone" layout with a
 * single unified "trending" feed ranked by 3-day rolling likes (with a
 * 14-day candidate pool).
 *
 * KV cache: removed. Caching the article-row snapshot in KV makes
 * like_count appear stale right after a like (the heart flips red but
 * the count stays at the cached value until TTL). At 4-article scale
 * the SQL is sub-millisecond; we'll re-add caching only if D1 read
 * pressure becomes a real problem.
 *
 * Locale: chrome strings come from `t(locale, ...)`. Article titles
 * and authors stay as-is (user data).
 */

import type { Env } from "../types";
import {
  listTopByRecentLikes,
  listUserLikedArticleIds,
} from "../db/queries";
import { escape } from "../util/html";
import { shell } from "../templates/shell";
import { articleRow } from "./_article_row";
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

/** How many ranked articles to show on the landing. */
const TOP_LIMIT = 30;

export async function renderLanding(req: Request, env: Env): Promise<Response> {
  const locale = getLocale(req);

  const [user, ranked] = await Promise.all([
    getCurrentUser(req, env),
    listTopByRecentLikes(env.DB, { limit: TOP_LIMIT }),
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
