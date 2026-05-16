/**
 * /api/me/tokens — manage long-lived API tokens that AI agents use to
 * submit articles on behalf of the user (Phase B replacement for the
 * GitHub-PAT identity path).
 *
 * Authentication: the router resolves the current user via
 * `getCurrentUser` (cookie session or Bearer token) BEFORE dispatching
 * here, and returns 401 if absent. These handlers accept the resolved
 * `AuthedUser` so they never need to re-parse cookies.
 *
 * Token plaintext is returned ONCE at creation and never persisted
 * anywhere readable — D1 stores only a sha256 hash plus a short
 * non-secret prefix used for display ("paink_xxxxxxxx…").
 */
import { HttpError, type Env } from "../types";
import { type AuthedUser } from "../util/auth_middleware";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../db/queries";

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
  // Token endpoints accept either a cookie session OR a Bearer token.
  // The Origin gate is only meaningful for cookie traffic (browser-
  // initiated). When the caller authenticated via Bearer, the
  // Authorization header itself is not auto-attached cross-site, so
  // there's no CSRF surface to protect — skip the check.
  if (req.headers.get("Authorization")) return;
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "csrf", "origin not allowed");
  }
}

// ---------- POST /api/me/tokens ----------

export async function handleCreateToken(
  req: Request,
  env: Env,
  user: AuthedUser,
): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "POST only");
  }
  assertCookieOrigin(req);

  const body = await readJson(req);
  const rawName = body.name;
  if (typeof rawName !== "string") {
    throw new HttpError(400, "validation", "name is required");
  }
  const name = rawName.trim();
  if (name.length < 1 || name.length > 100) {
    throw new HttpError(
      400,
      "validation",
      "name must be 1-100 characters",
    );
  }

  const created = await createApiToken(env.DB, user.id, name);
  const createdAt = Math.floor(Date.now() / 1000);
  return jsonResponse(201, {
    id: created.id,
    prefix: created.prefix,
    plaintext: created.plaintext,
    name,
    created_at: createdAt,
  });
}

// ---------- GET /api/me/tokens ----------

export async function handleListTokens(
  req: Request,
  env: Env,
  user: AuthedUser,
): Promise<Response> {
  if (req.method !== "GET") {
    throw new HttpError(405, "method_not_allowed", "GET only");
  }
  assertCookieOrigin(req);

  const tokens = await listApiTokens(env.DB, user.id);
  return jsonResponse(200, { tokens });
}

// ---------- DELETE /api/me/tokens/<id> ----------

export async function handleRevokeToken(
  req: Request,
  env: Env,
  user: AuthedUser,
  idParam: string,
): Promise<Response> {
  if (req.method !== "DELETE") {
    throw new HttpError(405, "method_not_allowed", "DELETE only");
  }
  assertCookieOrigin(req);

  if (!/^\d+$/.test(idParam)) {
    throw new HttpError(400, "validation", "token id must be an integer");
  }
  const id = Number.parseInt(idParam, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new HttpError(400, "validation", "token id must be a positive integer");
  }

  const ok = await revokeApiToken(env.DB, id, user.id);
  if (!ok) {
    throw new HttpError(
      404,
      "not_found",
      "no such token, or already revoked",
    );
  }
  return jsonResponse(200, { ok: true, id });
}
