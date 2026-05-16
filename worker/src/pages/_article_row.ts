/**
 * Shared article-row markup used by landing.ts and zone.ts.
 *
 * Mirrors site/build.py:_article_link (line 254). Title links to the article
 * chrome page; the side link points at /verify/<uuid> so curious readers
 * can inspect the manifest without first opening the article.
 *
 * The "详情/Details" label is the only chrome string in this row; everything
 * else (title, author, skill name, date) is user data and not translated.
 */

import type { ArticleRow } from "../types";
import { escape, displayDate } from "../util/html";
import { DEFAULT_LOCALE, t, type Locale } from "../i18n";

export function articleRow(a: ArticleRow, locale: Locale = DEFAULT_LOCALE): string {
  const href = `/${a.zone}/${a.slug}/`;
  const verifyHref = `/verify/${a.uuid}`;
  const title = escape(a.title || a.slug);
  const author = escape(a.author_display_name || "anonymous");
  const skill = escape(a.skill_name || "");
  const date = displayDate(a.slug, a.finished_at || a.published_at);

  const metaBits = [author, skill, date].filter((b) => b.length > 0);
  const meta = metaBits.join('<span class="sep">·</span>');

  return `<div class="article-row">
  <a class="article-link" href="${href}">
    <h3>${title}</h3>
    <p class="meta">${meta}</p>
  </a>
  <div class="article-side">
    <a class="side-link" href="${verifyHref}">${escape(t(locale, "me.details"))} →</a>
  </div>
</div>`;
}
