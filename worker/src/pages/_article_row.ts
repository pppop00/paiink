/**
 * Shared article-row markup used by landing.ts, zone.ts, profile.ts, me.ts.
 *
 * Mirrors site/build.py:_article_link (line 254). Title links to the article
 * chrome page; the side link points at /verify/<uuid> so curious readers
 * can inspect the manifest without first opening the article. The heart
 * button (Phase C) hangs in the side column under the details link.
 *
 * The "详情/Details" + heart-button labels are the only chrome strings in
 * this row; everything else (title, author, skill name, date) is user
 * data and not translated.
 */

import type { ArticleRow } from "../types";
import { escape, displayDate } from "../util/html";
import { DEFAULT_LOCALE, t, type Locale } from "../i18n";

export interface ArticleRowOpts {
  /**
   * Whether the viewer has liked this article. List pages compute the
   * Set<article_id> in bulk via listUserLikedArticleIds() and feed it
   * in per-row so we don't fan out N D1 queries per render.
   *
   * Defaults to false (anonymous viewer or never liked).
   */
  liked?: boolean;
  /**
   * Whether the viewer is logged in. Drives the button's clickability:
   * a logged-out viewer's click sends them to /login?next=… instead of
   * firing the POST. We can't infer this from `liked` alone because a
   * logged-out viewer obviously has `liked=false`.
   */
  logged_in?: boolean;
}

/**
 * Inline SVG heart, two variants. Kept inline (rather than a sprite or
 * external file) because the cost of a single ~120-byte path is lower
 * than a round trip, and CSP's `img-src 'self'` would otherwise need a
 * data: exception we'd rather not grant.
 */
const HEART_OUTLINE = '<svg class="heart" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 14s-5-3.2-5-7a3 3 0 0 1 5-2.3A3 3 0 0 1 13 7c0 3.8-5 7-5 7Z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const HEART_FILLED = '<svg class="heart" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 14s-5-3.2-5-7a3 3 0 0 1 5-2.3A3 3 0 0 1 13 7c0 3.8-5 7-5 7Z" fill="currentColor"/></svg>';

/**
 * Build the heart button as it appears in a row. The button is always
 * rendered with `data-uuid`+`data-liked` so the inline JS (see
 * `LIKE_SCRIPT` in shell.ts, added in this phase) can handle clicks
 * uniformly. Logged-out viewers get an `<a>` that redirects to login.
 */
export function likeButton(
  uuid: string,
  like_count: number,
  liked: boolean,
  logged_in: boolean,
  zone: string,
  slug: string,
  locale: Locale,
): string {
  const count = Math.max(like_count, 0);
  if (!logged_in) {
    const next = encodeURIComponent(`/${zone}/${slug}/`);
    return `<a class="like-btn" href="/login?next=${escape(next)}" title="${escape(t(locale, "like.login_to_like"))}" aria-label="${escape(t(locale, "like.login_to_like"))}">${HEART_OUTLINE}<span class="count">${count}</span></a>`;
  }
  const aria = liked ? t(locale, "like.aria_unlike") : t(locale, "like.aria_like");
  const cls = liked ? "like-btn liked" : "like-btn";
  const icon = liked ? HEART_FILLED : HEART_OUTLINE;
  return `<button type="button" class="${cls}" data-like-btn data-uuid="${escape(uuid)}" data-liked="${liked ? "1" : "0"}" aria-label="${escape(aria)}" aria-pressed="${liked ? "true" : "false"}">${icon}<span class="count">${count}</span></button>`;
}

export function articleRow(
  a: ArticleRow,
  locale: Locale = DEFAULT_LOCALE,
  opts: ArticleRowOpts = {},
): string {
  const href = `/${a.zone}/${a.slug}/`;
  const verifyHref = `/verify/${a.uuid}`;
  const title = escape(a.title || a.slug);
  const author = escape(a.author_display_name || "anonymous");
  const skill = escape(a.skill_name || "");
  const date = displayDate(a.slug, a.finished_at || a.published_at);

  const metaBits = [author, skill, date].filter((b) => b.length > 0);
  const meta = metaBits.join('<span class="sep">·</span>');

  const liked = opts.liked === true;
  const loggedIn = opts.logged_in === true;
  const heart = likeButton(a.uuid, a.like_count, liked, loggedIn, a.zone, a.slug, locale);

  return `<div class="article-row">
  <a class="article-link" href="${href}">
    <h3>${title}</h3>
    <p class="meta">${meta}</p>
  </a>
  <div class="article-side">
    <a class="side-link" href="${verifyHref}">${escape(t(locale, "me.details"))} →</a>
    ${heart}
  </div>
</div>`;
}
