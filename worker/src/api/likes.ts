/**
 * Likes API — Phase C.
 *
 * Endpoints:
 *   POST   /api/articles/<uuid>/like     ❤
 *   DELETE /api/articles/<uuid>/like     ♡
 *
 * Auth model (LOCKED, don't relax without architectural review):
 *   • ONLY cookie sessions can like. API tokens (`Authorization:
 *     Bearer pai_…`) are rejected with 403. The reasoning is in the
 *     replatform plan under "认证设计":
 *
 *       仅人类用户(cookie session)能点赞。API token 路径不能点赞
 *       —— 防止 agent 互刷。
 *
 *     If we let agents like articles, the homepage "trending" signal
 *     would become a measure of whose agent infra is most aggressive,
 *     not what the community thinks is worth reading. The router
 *     gates these handlers with getCurrentUser() (cookie session
 *     only), then we reject Bearer-authed-but-no-cookie callers here.
 *
 *   • NO Turnstile on this endpoint. Turnstile already gated account
 *     creation at /signup; per-user per-day rate limit (200/day, in
 *     D1 `rate_limits`) handles further abuse. Adding Turnstile to
 *     every heart click would tank the UX. Don't add it back without
 *     thinking through what the per-user limit isn't already catching.
 *
 *   • Self-liking is allowed. The social-signal premise relies on
 *     volume diluting any single author's contribution; not worth the
 *     complexity to block it for an MVP.
 *
 * Response shape: `{ liked: boolean, like_count: number }` on success;
 * `{ error, detail }` on failure. KV cache freshness is handled by the
 * 60s TTL on the homepage cache key — no explicit invalidate needed.
 */
import { HttpError, type Env } from "../types";
import type { AuthedUser } from "../util/auth_middleware";
import {
  getArticleByUuid,
  likeArticle,
  unlikeArticle,
  incrementRateLimit,
} from "../db/queries";

const UUID_RE = /^[a-zA-Z0-9-]+$/;
const ALLOWED_ORIGINS = new Set<string>([
  "https://www.paiink.com",
  "https://paiink.com",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

/** Max likes a single user can issue per UTC day. */
const LIKES_PER_DAY = 200;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function assertCookieOrigin(req: Request): void {
  // The like endpoints reject Bearer entirely (see below), so we never
  // skip the Origin gate for them. Browsers add Origin on every
  // fetch() / form POST; the gate only fires when Origin is set AND
  // not on the allow-list — direct curl with no Origin header is
  // not a CSRF vector and is allowed.
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "csrf", "origin not allowed");
  }
}

function validateUuid(uuid: string): void {
  if (
    typeof uuid !== "string" ||
    uuid.length < 8 ||
    uuid.length > 64 ||
    !UUID_RE.test(uuid)
  ) {
    throw new HttpError(400, "validation", "invalid article uuid");
  }
}

/**
 * Resolve an article by uuid, treating retracted articles as not
 * found. We deliberately do NOT let users like (or unlike) retracted
 * pieces — the article body is 410-gone, so the bookmark would be a
 * dead link.
 */
async function loadLikableArticle(
  env: Env,
  uuid: string,
): Promise<{ id: number; like_count: number }> {
  const row = await getArticleByUuid(env.DB, uuid);
  if (!row || row.retracted_at !== null) {
    throw new HttpError(404, "not_found", "no such article");
  }
  return { id: row.id, like_count: row.like_count };
}

// ---------- POST /api/articles/<uuid>/like ----------

export async function handleLike(
  req: Request,
  env: Env,
  user: AuthedUser,
  uuid: string,
): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "POST only");
  }
  assertCookieOrigin(req);
  validateUuid(uuid);

  // Rate limit. Window is a UTC-day boundary so the cap resets at 00:00 UTC.
  const windowStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const scope = `like:user:${user.id}`;
  const newCount = await incrementRateLimit(env.DB, scope, windowStart);
  if (newCount > LIKES_PER_DAY) {
    throw new HttpError(
      429,
      "rate_limit",
      `max ${LIKES_PER_DAY} likes per day`,
    );
  }

  const article = await loadLikableArticle(env, uuid);
  const inserted = await likeArticle(env.DB, user.id, article.id);
  // If we actually inserted, the denorm went up. If not, the user had
  // already liked; the count is unchanged from what we read.
  const newLikeCount = inserted ? article.like_count + 1 : article.like_count;
  return jsonResponse(200, { liked: true, like_count: newLikeCount });
}

// ---------- DELETE /api/articles/<uuid>/like ----------

export async function handleUnlike(
  req: Request,
  env: Env,
  user: AuthedUser,
  uuid: string,
): Promise<Response> {
  if (req.method !== "DELETE") {
    throw new HttpError(405, "method_not_allowed", "DELETE only");
  }
  assertCookieOrigin(req);
  validateUuid(uuid);

  // No rate limit on unlikes — they're not abusable for spam, and a
  // user might want to clean up a long bookmark list.
  const article = await loadLikableArticle(env, uuid);
  const deleted = await unlikeArticle(env.DB, user.id, article.id);
  const newLikeCount = deleted
    ? Math.max(article.like_count - 1, 0)
    : article.like_count;
  return jsonResponse(200, { liked: false, like_count: newLikeCount });
}
