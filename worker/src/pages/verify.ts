/**
 * GET /verify/<uuid> — manifest display page.
 *
 * Mirrors site/build.py:write_verify_page() (line 339). Reads the D1 row
 * for fast lookup + the R2 manifest bytes for the raw-JSON details/dump.
 * The point of this page is to give a human (or an LLM agent) a one-stop
 * place to inspect the provenance manifest before trusting the article.
 *
 * Also serves the manifest.json side-route: GET /verify/<uuid>/manifest.json
 * streams the raw manifest bytes verbatim. That's the friendliest URL for
 * scripts because there's no chrome to parse around.
 *
 * Locale: row labels + button/link text translate; the manifest content
 * (skill name, hashes, etc.) is data and stays as-is.
 */

import type { Env, Manifest } from "../types";
import { HttpError } from "../types";
import { getArticleByUuid, hasUserLikedArticle } from "../db/queries";
import { getArticleManifest, getArticleManifestBytes } from "../r2";
import { escape, shortHash } from "../util/html";
import { shell } from "../templates/shell";
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t } from "../i18n";
import { likeButton } from "./_article_row";

export async function renderVerify(
  req: Request,
  env: Env,
  uuid: string,
): Promise<Response> {
  const locale = getLocale(req);
  const [row, manifest, user] = await Promise.all([
    getArticleByUuid(env.DB, uuid),
    getArticleManifest(env.R2_CONTENT, uuid),
    getCurrentUser(req, env),
  ]);
  if (!row) {
    throw new HttpError(404, "not_found", `No article with uuid=${uuid}`);
  }
  if (!manifest) {
    throw new HttpError(500, "missing_manifest", `R2 manifest missing for uuid=${uuid}`);
  }

  // Phase C: surface a heart next to the title so readers can like
  // straight from the manifest page. We don't show it for retracted
  // articles — they can't be liked anyway (api/likes 404s them).
  let viewerLiked = false;
  if (user && row.retracted_at === null) {
    viewerLiked = await hasUserLikedArticle(env.DB, user.id, row.id);
  }
  const heart =
    row.retracted_at !== null
      ? ""
      : likeButton(
          row.uuid,
          row.like_count,
          viewerLiked,
          user !== null,
          row.zone,
          row.slug,
          locale,
        );

  const art = manifest.article;
  const skill = manifest.skill;
  const gen = manifest.generation;
  const author = manifest.author;
  // v1-era manifests (predate the agreement block) have no `agreement`
  // field. The D1 row carries the synthesized version+hash from the
  // migration, so fall back to it. The fallback also defends against
  // future manifest shape drift — a missing agreement block won't 500.
  const agreement = manifest.agreement ?? {
    version: row.agreement_version,
    sha256: row.agreement_sha256,
    accepted_at: "",
  };

  const articleHref = `/${row.zone}/${row.slug}/`;
  const manifestHref = `/verify/${uuid}/manifest.json`;
  const exportHref = `/verify/${uuid}/export`;

  const repoUrl = skill.repo_url || "";
  const repoCommit = skill.repo_commit || "";
  const repoLink = repoUrl ? `<a href="${escape(repoUrl)}">${escape(repoUrl)}</a>` : "—";
  const shortCommit = repoCommit.length > 12 ? repoCommit.slice(0, 8) + "…" : repoCommit;
  const commitLink =
    repoUrl && repoCommit
      ? `<a href="${escape(repoUrl)}/commit/${escape(repoCommit)}"><code>${escape(shortCommit)}</code></a>`
      : `<code>${escape(shortCommit)}</code>`;

  const contentHash = art.content_sha256 || "";
  const short = shortHash(contentHash);
  const authorName = author?.display_name || row.author_display_name || t(locale, "verify.anonymous");

  const rows: Array<[string, string]> = [
    [t(locale, "verify.article"), `<a href="${articleHref}">${escape(art.title || "")}</a>`],
    [t(locale, "verify.zone"), escape(row.zone)],
    [t(locale, "verify.language"), escape(art.language || "")],
    [t(locale, "verify.author"), escape(authorName)],
    [t(locale, "verify.skill"), escape(skill.name || "") || "—"],
    [t(locale, "verify.skill_repo"), repoLink],
    [t(locale, "verify.skill_commit"), commitLink],
    [t(locale, "verify.model"), `<code>${escape(gen.model || "")}</code>`],
  ];

  // Optional manifest fields — only show when present (matches static build).
  const apiReqId = gen.api_request_id;
  if (apiReqId) {
    rows.push([t(locale, "verify.api_request_id"), `<code>${escape(apiReqId)}</code>`]);
  }
  rows.push([t(locale, "verify.license"), `<code>${escape(art.license || "")}</code>`]);
  rows.push([t(locale, "verify.published_at"), escape(art.published_at || "") || "—"]);
  rows.push([t(locale, "verify.content_hash"), `<code title="${escape(contentHash)}">${escape(short)}</code>`]);
  rows.push([
    t(locale, "verify.agreement"),
    `<a href="/agreement/${escape(agreement.version)}">${escape(agreement.version)}</a> · <code title="${escape(
      agreement.sha256,
    )}">${escape(shortHash(agreement.sha256))}</code>`,
  ]);
  rows.push([t(locale, "verify.agreement_accepted_at"), escape(agreement.accepted_at || "") || "—"]);

  // Retraction notice surfaces above the manifest for visibility.
  const retractedBanner = row.retracted_at
    ? `<section class="agreement-archived">
  <p><strong>${escape(t(locale, "verify.retracted_title"))}</strong>${escape(row.retraction_reason || t(locale, "verify.no_reason"))}</p>
</section>`
    : "";

  const rawJson = escape(JSON.stringify(manifest, null, 2));

  const body: string[] = [
    `<section class="verify-head">
  <p class="eyebrow">${escape(t(locale, "verify.title_eyebrow"))}</p>
  <div class="verify-title-row">
    <h1>${escape(art.title || "")}</h1>
    ${heart}
  </div>
</section>`,
    retractedBanner,
    '<dl class="manifest">',
  ];
  for (const [k, v] of rows) {
    body.push(`  <dt>${escape(k)}</dt><dd>${v}</dd>`);
  }
  body.push("</dl>");

  body.push(
    `<p style="font-size:14px;margin-top:24px">
  <a href="${articleHref}">${escape(t(locale, "verify.read_article"))}</a> ·
  <a href="${manifestHref}">${escape(t(locale, "verify.download_manifest"))}</a> ·
  <a href="${exportHref}">${escape(t(locale, "verify.download_export"))}</a>
</p>`,
  );

  body.push(
    `<details class="raw">
  <summary>${escape(t(locale, "verify.raw_manifest"))}</summary>
  <pre>${rawJson}</pre>
</details>`,
  );

  return new Response(
    shell({
      title: `${t(locale, "verify.title")} ${uuid.slice(0, 8)} — pai.ink`,
      body: body.join("\n"),
      user,
      locale,
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    },
  );
}

/**
 * GET /verify/<uuid>/manifest.json — raw manifest bytes from R2.
 * Streamed verbatim so the bytes hash matches what the author submitted.
 */
export async function renderVerifyManifest(
  _req: Request,
  env: Env,
  uuid: string,
): Promise<Response> {
  const row = await getArticleByUuid(env.DB, uuid);
  if (!row) {
    throw new HttpError(404, "not_found", `No article with uuid=${uuid}`);
  }
  const bytes = await getArticleManifestBytes(env.R2_CONTENT, uuid);
  if (!bytes) {
    throw new HttpError(500, "missing_manifest", `R2 manifest missing for uuid=${uuid}`);
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "content-disposition": `inline; filename="ai-audit-${uuid}.json"`,
    },
  });
}

// Re-export for callers that only need the manifest type.
export type { Manifest };
