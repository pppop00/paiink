/**
 * POST /api/me/articles/<uuid>/retract — mark an article as retracted.
 *
 * R2 bytes are immutable history and are NOT deleted; this only flips
 * `articles.retracted_at` and records the reason. Subsequent renders of
 * the article page return 410 Gone (handled in pages/article.ts).
 *
 * Ownership + existence + already-retracted state are funneled into a
 * single 404 to avoid leaking whether a UUID exists or who owns it.
 */
import { HttpError, type Env } from "../types";
import { type AuthedUser } from "../util/auth_middleware";
import { retractArticle } from "../db/queries";

const UUID_RE = /^[a-zA-Z0-9-]+$/;
const ALLOWED_ORIGINS = new Set<string>([
  "https://www.paiink.com",
  "https://paiink.com",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (
    !(req.headers.get("content-type") || "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "POST body must be application/json",
    );
  }
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "validation", "invalid JSON body");
  }
}

function assertCookieOrigin(req: Request): void {
  // Same logic as tokens.ts: Bearer-authed calls don't carry CSRF risk.
  if (req.headers.get("Authorization")) return;
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "csrf", "origin not allowed");
  }
}

export async function handleRetract(
  req: Request,
  env: Env,
  user: AuthedUser,
  uuid: string,
): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "POST only");
  }
  assertCookieOrigin(req);

  // Loose UUID/ULID shape check — both the legacy v4 UUIDs (with hyphens)
  // and the new 26-char Crockford ULIDs (no hyphens) must pass.
  if (
    typeof uuid !== "string" ||
    uuid.length < 8 ||
    uuid.length > 64 ||
    !UUID_RE.test(uuid)
  ) {
    throw new HttpError(400, "validation", "invalid article uuid");
  }

  const body = await readJson(req);
  const rawReason = body.reason;
  if (typeof rawReason !== "string") {
    throw new HttpError(400, "validation", "reason is required");
  }
  const reason = rawReason.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new HttpError(400, "validation", "reason must be 1-500 characters");
  }

  const ok = await retractArticle(env.DB, uuid, user.id, reason);
  if (!ok) {
    throw new HttpError(
      404,
      "not_found",
      "no such article, you don't own it, or it's already retracted",
    );
  }
  return jsonResponse(200, { ok: true, uuid });
}
