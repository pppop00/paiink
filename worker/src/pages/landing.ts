/**
 * GET / — landing page.
 *
 * Mirrors site/build.py:write_landing() (lines 288-315). Hero block + two
 * zone sections, each showing the top 5 newest articles.
 *
 * Locale: all chrome strings (hero, zone titles, ledes, "all" link, empty
 * state) come from `t(locale, ...)`. Article titles/authors are not
 * translated — those are user data.
 */

import type { Env, ArticleRow } from "../types";
import { listArticlesByZone } from "../db/queries";
import { escape } from "../util/html";
import { shell } from "../templates/shell";
import { articleRow } from "./_article_row";
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

const ZONE_KEYS = ["finance", "web3"] as const;

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

export async function renderLanding(req: Request, env: Env): Promise<Response> {
  const locale = getLocale(req);

  const [user, ...buckets] = await Promise.all([
    getCurrentUser(req, env),
    ...ZONE_KEYS.map((z) => listArticlesByZone(env.DB, z, { limit: 5 })),
  ]);

  const parts: string[] = [];
  parts.push(`<section class="hero">
  <h1>${escape(t(locale, "landing.hero"))}</h1>
</section>`);

  ZONE_KEYS.forEach((zoneKey, i) => {
    const items: ArticleRow[] = buckets[i] ?? [];
    const roman = i < ROMAN.length ? ROMAN[i] : String(i + 1);
    const title = t(locale, `zone.${zoneKey}.title`);
    parts.push(`<section class="zone">
  <p class="zone-roman">${escape(t(locale, "landing.zone.roman", { n: roman }))}</p>
  <div class="zone-head">
    <h2>${escape(title)}</h2>
    <a class="more" href="/${zoneKey}/">${escape(t(locale, "landing.zone.more"))}</a>
  </div>`);
    if (items.length === 0) {
      parts.push(`<p class="empty">${escape(t(locale, "landing.empty"))}</p>`);
    } else {
      parts.push('<ul class="articles">');
      for (const a of items) {
        parts.push(`<li>${articleRow(a, locale)}</li>`);
      }
      parts.push("</ul>");
    }
    parts.push("</section>");
  });

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
        "cache-control": "public, max-age=60",
      },
    },
  );
}
