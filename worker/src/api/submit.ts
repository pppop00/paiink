/**
 * POST /api/submit — D1 + R2 article publishing.
 *
 * Phase A swap: replaces the old GitHub Git Data API commit path
 * (worker/src/index.ts:526-637 commitFiles) with a D1 insert + two R2
 * puts. User-facing contract is unchanged from agreement v2: declared
 * email + display_name in the payload, no login, same JSON / multipart
 * shapes, same validation gates.
 *
 * The response shape stays close to before for agent compatibility:
 *
 *     { slug, url, uuid, live_in_seconds_estimate: 1 }
 *
 * The old `commit_sha` field is dropped — there's no GitHub commit
 * anymore. Articles are live in roughly one network round-trip; the
 * `live_in_seconds_estimate: 1` is a deliberate signal to clients that
 * the 60-90s Pages-rebuild wait is gone.
 *
 * Router (Stream 2) is responsible for method/CORS/preflight; this
 * function only runs for verified-POST traffic.
 */
import {
  HttpError,
  type Env,
} from "../types";
import {
  getOrCreateUserByEmail,
  insertArticle,
} from "../db/queries";
import { putArticleHTML, putArticleManifest } from "../r2";
import { buildManifest } from "../util/manifest";
import {
  nowIso,
  parsePayload,
  sha256Hex,
  wordCountFromHtml,
} from "../util/payload";
import { enforceIpRateLimit } from "../util/rate_limit";
import {
  parseRepoUrl,
  verifySkillCommit,
  verifySkillRepoPublic,
} from "../util/skill_check";
import {
  kebabSlug,
  pickAvailableSlug,
  todayUtcDate,
} from "../util/slug";

/**
 * Parse an ISO timestamp into Unix seconds for the articles table.
 * Falls back to "now" if the string is somehow unparseable (shouldn't
 * happen — publishedAt comes from nowIso() — but D1 columns are NOT NULL).
 */
function isoToUnixSec(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

export async function handleSubmit(req: Request, env: Env): Promise<Response> {
  // 1. Parse + validate payload (multipart or JSON).
  const payload = await parsePayload(req);

  // 2. IP rate limit (KV, fail-soft). Phase B+ migrates to D1 rate_limits.
  await enforceIpRateLimit(req, env);

  // 3. Skill repo public + commit existence via anonymous GitHub fetches.
  const { owner: skillOwner, repo: skillRepo } = parseRepoUrl(payload.skill_repo_url);
  await verifySkillRepoPublic(skillOwner, skillRepo);
  await verifySkillCommit(skillOwner, skillRepo, payload.skill_repo_commit);

  // 4. Slug. Empty-after-kebab can happen with all-CJK titles — fall
  //    back to a stable article-<8hex>-<date> form. The "-<date>"
  //    suffix is applied uniformly so the URL always carries publish
  //    date.
  let baseKebab = kebabSlug(payload.title);
  if (baseKebab.length === 0) {
    baseKebab = `article-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }
  const baseSlug = `${baseKebab}-${todayUtcDate()}`;
  const slug = await pickAvailableSlug(env.DB, payload.zone, baseSlug);

  // 5. Content hash + timestamps.
  const contentSha = await sha256Hex(payload.html);
  const publishedAt = nowIso();
  const publishedAtUnix = isoToUnixSec(publishedAt);
  const wordCount = wordCountFromHtml(payload.html);

  // 6. Lazy user creation. Phase A still derives identity from the
  //    declared email; Phase B will overwrite this with the session
  //    user. password_hash stays NULL until the user signs up.
  const user = await getOrCreateUserByEmail(
    env.DB,
    payload.email,
    payload.display_name,
  );

  // 7. Build the manifest. article.id is the UUID we'll also use as
  //    the D1 uuid column AND the R2 key prefix. Keeping all three in
  //    sync means /verify/<uuid> can resolve the manifest+HTML from
  //    a single id without an extra lookup.
  const articleUuid = crypto.randomUUID();
  const manifest = buildManifest({
    articleId: articleUuid,
    title: payload.title,
    zone: payload.zone,
    language: payload.language,
    license: payload.license,
    publishedAt,
    contentSha,
    wordCount,
    skillName: payload.skill_name,
    skillRepoUrl: payload.skill_repo_url,
    skillRepoCommit: payload.skill_repo_commit,
    model: payload.model,
    harness: payload.harness,
    apiRequestId: payload.api_request_id,
    email: payload.email,
    displayName: payload.display_name,
  });

  // 8. D1 row first. If this fails the row never existed and no R2
  //    bytes are written — clean failure.
  let articleRowId: number;
  try {
    articleRowId = await insertArticle(env.DB, {
      uuid: articleUuid,
      zone: payload.zone,
      slug,
      language: payload.language,
      title: payload.title,
      author_id: user.id,
      author_email: payload.email,
      author_display_name: payload.display_name,
      content_sha256: contentSha,
      word_count: wordCount,
      license: payload.license,
      agreement_version: manifest.agreement.version,
      agreement_sha256: manifest.agreement.sha256,
      skill_name: payload.skill_name,
      skill_repo_url: payload.skill_repo_url,
      skill_repo_commit: payload.skill_repo_commit,
      model: payload.model,
      harness: payload.harness,
      api_request_id: payload.api_request_id ?? null,
      finished_at: publishedAtUnix,
      published_at: publishedAtUnix,
    });
  } catch (e) {
    // Wrap unknown D1 errors so they surface as a clear 500 rather
    // than the generic "unhandled error" path.
    if (e instanceof HttpError) throw e;
    console.error("D1 insert failed in handleSubmit:", e);
    throw new HttpError(500, "db", "failed to record article");
  }

  // 9. R2 puts (HTML then manifest). If either fails after the D1 row
  //    exists, best-effort delete the row and surface a 500 so the
  //    submitter can retry. D1 has no cross-statement transaction on
  //    Workers, so this is the cleanest recovery we can offer today.
  try {
    await putArticleHTML(env.R2_CONTENT, articleUuid, payload.html);
    await putArticleManifest(env.R2_CONTENT, articleUuid, manifest);
  } catch (e) {
    console.error("R2 put failed after D1 insert; rolling back row:", e);
    try {
      await env.DB.prepare("DELETE FROM articles WHERE id = ?")
        .bind(articleRowId)
        .run();
    } catch (rollbackErr) {
      console.error("D1 rollback also failed; row will linger:", rollbackErr);
    }
    throw new HttpError(
      500,
      "storage",
      "article row written but byte storage failed; please retry",
    );
  }

  // 10. Success. live_in_seconds_estimate: 1 (vs. 90 in the old GitHub
  //     path) is the user-visible win of the migration. Drop commit_sha;
  //     there's no commit anymore. SITE_URL override lets staging point
  //     at a non-paiink.com hostname.
  const siteUrl = env.SITE_URL ?? "https://www.paiink.com";
  return new Response(
    JSON.stringify({
      slug,
      url: `${siteUrl}/${payload.zone}/${slug}/`,
      uuid: articleUuid,
      live_in_seconds_estimate: 1,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}
