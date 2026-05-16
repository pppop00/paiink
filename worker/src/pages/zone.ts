/**
 * GET /finance/ and GET /web3/ — per-zone article listings.
 *
 * Mirrors site/build.py:write_zone_index() (line 318). Phase A only has 4
 * articles total so we pull up to 100 with no pagination — that ceiling
 * gives plenty of headroom before we have to add page links.
 *
 * Locale: title + lede pulled from the i18n catalog (`zone.<key>.title` /
 * `zone.<key>.lede`). Article rows are localized via _article_row.ts.
 *
 * Phase C: bulk-resolves viewer likes via listUserLikedArticleIds() so
 * the heart button on each row renders with the correct state.
 */

import type { Env, Zone } from "../types";
import {
  listArticlesByZone,
  listUserLikedArticleIds,
} from "../db/queries";
import { escape } from "../util/html";
import { shell } from "../templates/shell";
import { articleRow } from "./_article_row";
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

export async function renderZone(
  req: Request,
  env: Env,
  zone: Zone,
): Promise<Response> {
  const locale = getLocale(req);
  const title = t(locale, `zone.${zone}.title`);
  const lede = t(locale, `zone.${zone}.lede`);

  const [user, items] = await Promise.all([
    getCurrentUser(req, env),
    listArticlesByZone(env.DB, zone, { limit: 100 }),
  ]);

  let likedIds = new Set<number>();
  if (user && items.length > 0) {
    likedIds = await listUserLikedArticleIds(
      env.DB,
      user.id,
      items.map((a) => a.id),
    );
  }

  const body: string[] = [
    `<section class="page-head">
  <h1>${escape(title)}</h1>
  <p class="lede">${escape(lede)}</p>
</section>`,
  ];
  if (items.length === 0) {
    body.push(`<p class="empty">${escape(t(locale, "landing.empty"))}</p>`);
  } else {
    body.push('<ul class="articles">');
    for (const a of items) {
      body.push(
        `<li>${articleRow(a, locale, {
          liked: likedIds.has(a.id),
          logged_in: user !== null,
        })}</li>`,
      );
    }
    body.push("</ul>");
  }

  return new Response(
    shell({
      title: `${title} — pai.ink`,
      body: body.join("\n"),
      active: zone,
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
