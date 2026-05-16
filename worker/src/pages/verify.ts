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
 */

import type { Env, Manifest } from "../types";
import { HttpError } from "../types";
import { getArticleByUuid } from "../db/queries";
import { getArticleManifest, getArticleManifestBytes } from "../r2";
import { escape, shortHash } from "../util/html";
import { shell } from "../templates/shell";

export async function renderVerify(
  _req: Request,
  env: Env,
  uuid: string,
): Promise<Response> {
  const row = await getArticleByUuid(env.DB, uuid);
  if (!row) {
    throw new HttpError(404, "not_found", `No article with uuid=${uuid}`);
  }
  const manifest = await getArticleManifest(env.R2_CONTENT, uuid);
  if (!manifest) {
    throw new HttpError(500, "missing_manifest", `R2 manifest missing for uuid=${uuid}`);
  }

  const art = manifest.article;
  const skill = manifest.skill;
  const gen = manifest.generation;
  const author = manifest.author;
  const agreement = manifest.agreement;

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

  const rows: Array<[string, string]> = [
    ["文章 / Article", `<a href="${articleHref}">${escape(art.title || "")}</a>`],
    ["分区 / Zone", escape(row.zone)],
    ["语言 / Language", escape(art.language || "")],
    ["作者 / Author", escape(author?.display_name || row.author_display_name || "anonymous")],
    ["Skill", escape(skill.name || "") || "—"],
    ["Skill 仓库", repoLink],
    ["Skill commit", commitLink],
    ["模型 / Model", `<code>${escape(gen.model || "")}</code>`],
    ["Harness", escape(gen.harness || "") || "—"],
  ];

  // Optional manifest fields — only show when present (matches static build).
  const apiReqId = gen.api_request_id;
  if (apiReqId) {
    rows.push(["API request id", `<code>${escape(apiReqId)}</code>`]);
  }
  rows.push(["授权 / License", `<code>${escape(art.license || "")}</code>`]);
  rows.push(["发布时间", escape(art.published_at || "") || "—"]);
  rows.push(["内容哈希", `<code title="${escape(contentHash)}">${escape(short)}</code>`]);
  rows.push([
    "协议",
    `<a href="/agreement/${escape(agreement.version)}">${escape(agreement.version)}</a> · <code title="${escape(
      agreement.sha256,
    )}">${escape(shortHash(agreement.sha256))}</code>`,
  ]);
  rows.push(["协议接受时间", escape(agreement.accepted_at || "") || "—"]);

  // Retraction notice surfaces above the manifest for visibility.
  const retractedBanner = row.retracted_at
    ? `<section class="agreement-archived">
  <p><strong>本文已撤稿。</strong>${escape(row.retraction_reason || "(未填写原因)")}</p>
</section>`
    : "";

  const rawJson = escape(JSON.stringify(manifest, null, 2));

  const body: string[] = [
    `<section class="verify-head">
  <p class="eyebrow">详情 / Details</p>
  <h1>${escape(art.title || "")}</h1>
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
  <a href="${articleHref}">→ 阅读文章</a> ·
  <a href="${manifestHref}">下载 ai-audit.json</a> ·
  <a href="${exportHref}">下载验证包 (.tar.gz)</a>
</p>`,
  );

  body.push(
    `<details class="raw">
  <summary>完整 manifest (raw)</summary>
  <pre>${rawJson}</pre>
</details>`,
  );

  return new Response(
    shell({
      title: `详情 ${uuid.slice(0, 8)} — pai.ink`,
      body: body.join("\n"),
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
