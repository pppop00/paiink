/**
 * POST /api/logout — destroy the session row (if any) and clear the
 * cookie. Idempotent: a missing/expired cookie still returns 200.
 */
import { HttpError, type Env } from "../types";
import { clearSessionCookie, parseSessionCookie } from "../util/session";
import { deleteSession } from "../db/queries";

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

function assertOrigin(req: Request): void {
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "csrf", "origin not allowed");
  }
}

export async function handleLogout(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "POST only");
  }
  assertOrigin(req);

  const sessionId = parseSessionCookie(req);
  if (sessionId) {
    try {
      await deleteSession(env.DB, sessionId);
    } catch {
      // Logout must be best-effort idempotent. Swallow row-not-found /
      // transient D1 errors; the cookie clear below is what users see.
    }
  }

  return clearSessionCookie(jsonResponse(200, { ok: true }), req);
}
