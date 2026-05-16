/**
 * GET /u/<handle> — public read-only author profile.
 *
 * Shows display_name + handle in the header, and a newest-first list of
 * the author's non-retracted articles. No auth required; profile is part
 * of the brand surface. Retracted articles are hidden here (their /verify
 * page remains reachable via the article uuid).
 *
 * Phase C: bulk-resolves viewer likes so the heart on each row renders
 * with the right state for the logged-in visitor (if any).
 */
import type { Env, ArticleRow } from "../types";
import type { AuthedUser } from "../util/auth_middleware";
import {
  findUserByHandle,
  listArticlesByUserId,
  listUserLikedArticleIds,
} from "../db/queries";
import { HttpError } from "../types";
import { shell } from "../templates/shell";
import { escape } from "../util/html";
import { articleRow } from "./_article_row";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

export async function renderProfile(
  req: Request,
  env: Env,
  handle: string,
  viewer: AuthedUser | null,
): Promise<Response> {
  const locale = getLocale(req);
  const user = await findUserByHandle(env.DB, handle);
  if (!user || user.deleted_at !== null) {
    throw new HttpError(404, "not_found", `User @${handle} not found`);
  }

  // Public profile only shows non-retracted articles. listArticlesByUserId
  // includes retractions for the /me view; filter them out here.
  const allArticles: ArticleRow[] = await listArticlesByUserId(env.DB, user.id);
  const articles = allArticles.filter((a) => a.retracted_at === null);

  let likedIds = new Set<number>();
  if (viewer && articles.length > 0) {
    likedIds = await listUserLikedArticleIds(
      env.DB,
      viewer.id,
      articles.map((a) => a.id),
    );
  }

  const joinedDate = new Date(user.created_at * 1000).toISOString().slice(0, 10);

  const articlesHtml = articles.length === 0
    ? `<p class="empty">${escape(t(locale, "profile.no_articles"))}</p>`
    : `<ul class="articles">${articles
        .map(
          (a) =>
            `<li>${articleRow(a, locale, {
              liked: likedIds.has(a.id),
              logged_in: viewer !== null,
            })}</li>`,
        )
        .join("\n")}</ul>`;

  const body = `<section class="profile-head">
  <p class="eyebrow">@${escape(user.handle)}</p>
  <h1>${escape(user.display_name)}</h1>
  <p class="handle">${escape(t(locale, "profile.article_count", { n: articles.length, date: joinedDate }))}</p>
</section>

<section class="me-section">
  <div class="head"><h2>${escape(t(locale, "profile.articles"))}</h2></div>
  ${articlesHtml}
</section>`;

  return new Response(
    shell({
      title: `${user.display_name} (@${user.handle}) — pai.ink`,
      body,
      user: viewer,
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
