/**
 * POST /api/login — exchange email+password for a session cookie.
 *
 * Returns 401 with a uniform `invalid_credentials` error for every
 * failure mode (no user / unclaimed row / bad password) to avoid
 * email enumeration.
 */
import { HttpError, type Env, type UserRow } from "../types";
import { verifyPassword } from "../util/crypto";
import { setSessionCookie } from "../util/session";
import { createSession, findUserByEmail } from "../db/queries";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

function assertOrigin(req: Request): void {
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "csrf", "origin not allowed");
  }
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "POST only");
  }
  assertOrigin(req);

  const body = await readJson(req);

  // Validate shape, but funnel all "shape OK but wrong" failures into a
  // single 401 — same as the "no such user" path below — to avoid
  // leaking which field was wrong.
  const rawEmail = body.email;
  const rawPassword = body.password;
  if (typeof rawEmail !== "string" || typeof rawPassword !== "string") {
    throw new HttpError(400, "validation", "email and password are required");
  }
  if (
    rawEmail.length < 3 ||
    rawEmail.length > 254 ||
    !EMAIL_RE.test(rawEmail) ||
    rawPassword.length === 0 ||
    rawPassword.length > 256
  ) {
    throw new HttpError(
      401,
      "invalid_credentials",
      "email or password incorrect",
    );
  }
  const email = rawEmail.toLowerCase();
  const password = rawPassword;

  const db = env.DB;
  const user: UserRow | null = await findUserByEmail(db, email);

  // Uniform failure path:
  //  - no row
  //  - lazy-created Phase-A row that hasn't signed up yet (no hash)
  //  - hash mismatch
  if (!user || user.password_hash === null) {
    throw new HttpError(
      401,
      "invalid_credentials",
      "email or password incorrect",
    );
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    throw new HttpError(
      401,
      "invalid_credentials",
      "email or password incorrect",
    );
  }

  const sessionId = await createSession(db, {
    user_id: user.id,
    ip: req.headers.get("cf-connecting-ip") || null,
    user_agent: req.headers.get("user-agent") || null,
  });

  return setSessionCookie(
    jsonResponse(200, {
      user_id: user.id,
      handle: user.handle,
      display_name: user.display_name,
    }),
    sessionId,
    req,
  );
}
