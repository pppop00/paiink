/**
 * POST /api/signup — create account (email + password) or claim a
 * lazy-created Phase-A user row.
 *
 * Phase B contract:
 *   • Email + password (no email verification, no avatar uploads).
 *   • Cloudflare Turnstile invisible captcha required.
 *   • Issues an HTTP-only session cookie (90d TTL by default).
 *   • If a user row already exists for the email and was created in
 *     Phase A from a submission (`password_hash IS NULL`), the signup
 *     CLAIMS that row instead of creating a duplicate — preserving the
 *     existing `handle` and `display_name` so published manifests stay
 *     coherent.
 *
 * Router (Stream 3) handles method-allowed + CORS preflight. This
 * function still does defense-in-depth method + Origin checks.
 */
import { HttpError, type Env, type UserRow } from "../types";
import { hashPassword } from "../util/crypto";
import { verifyTurnstile } from "../util/turnstile";
import { setSessionCookie } from "../util/session";
import { kebabSlug } from "../util/slug";
import {
  claimUser,
  createSession,
  createUser,
  findUserByEmail,
  findUserByHandle,
} from "../db/queries";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ORIGINS = new Set<string>([
  "https://www.paiink.com",
  "https://paiink.com",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);
const ALLOWED_UI_LANGS = new Set<string>(["zh-CN", "en"]);
const HANDLE_GEN_MAX_ATTEMPTS = 8;

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

function requireString(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  opts: { trim?: boolean; pattern?: RegExp } = {},
): string {
  const raw = obj[key];
  if (typeof raw !== "string") {
    throw new HttpError(400, "validation", `${key} is required`);
  }
  const value = opts.trim === false ? raw : raw;
  if (opts.trim !== false && raw.trim() !== raw) {
    throw new HttpError(
      400,
      "validation",
      `${key} must not have leading/trailing whitespace`,
    );
  }
  if (value.length < min || value.length > max) {
    throw new HttpError(
      400,
      "validation",
      `${key} must be ${min}-${max} characters`,
    );
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    throw new HttpError(400, "validation", `${key} is malformed`);
  }
  return value;
}

function randomHexSuffix(): string {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a free handle. Starts from kebabified display_name; falls back
 * to `user-<4hex>` if the kebab is empty (e.g. all-CJK name). On collision,
 * retries with a fresh `-<4hex>` suffix up to MAX_ATTEMPTS times.
 */
async function generateFreeHandle(
  db: D1Database,
  displayName: string,
): Promise<string> {
  const base = kebabSlug(displayName);
  const stems: string[] = base.length > 0 ? [base] : [];
  for (let i = 0; i < HANDLE_GEN_MAX_ATTEMPTS; i++) {
    let candidate: string;
    if (i === 0 && stems.length > 0) {
      candidate = stems[0];
    } else if (stems.length > 0) {
      candidate = `${stems[0]}-${randomHexSuffix()}`;
    } else {
      candidate = `user-${randomHexSuffix()}`;
    }
    const taken = await findUserByHandle(db, candidate);
    if (!taken) return candidate;
  }
  throw new HttpError(
    503,
    "handle_unavailable",
    "could not allocate a free handle; please try again",
  );
}

export async function handleSignup(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "POST only");
  }
  assertOrigin(req);

  const body = await readJson(req);

  // ---- field validation ----
  const email = requireString(body, "email", 3, 254, {
    pattern: EMAIL_RE,
  }).toLowerCase();
  const password = requireString(body, "password", 8, 256, { trim: false });
  const displayName = requireString(body, "display_name", 1, 100);
  const turnstileToken = requireString(body, "turnstile_token", 1, 4096, {
    trim: false,
  });

  let uiLang = "zh-CN";
  if (body.ui_lang !== undefined) {
    if (typeof body.ui_lang !== "string" || !ALLOWED_UI_LANGS.has(body.ui_lang)) {
      throw new HttpError(400, "validation", "ui_lang must be 'zh-CN' or 'en'");
    }
    uiLang = body.ui_lang;
  }

  // ---- captcha ----
  const ip = req.headers.get("cf-connecting-ip");
  const captchaOk = await verifyTurnstile(
    turnstileToken,
    ip,
    env.TURNSTILE_SECRET,
  );
  if (!captchaOk) {
    throw new HttpError(403, "turnstile", "captcha verification failed");
  }

  // ---- existing-row check (claim path) ----
  const db = env.DB;
  const existing: UserRow | null = await findUserByEmail(db, email);

  const userAgent = req.headers.get("user-agent") || null;
  const clientIp = ip || null;

  let userId: number;
  let handle: string;
  let resolvedDisplayName: string;
  let claimed = false;

  if (existing) {
    if (existing.password_hash !== null) {
      throw new HttpError(
        409,
        "email_taken",
        "an account with this email exists; try logging in",
      );
    }
    // Claim lazy-created row. Preserve handle + display_name so existing
    // manifests/articles authored by this user remain coherent.
    const pwHash = await hashPassword(password);
    await claimUser(db, existing.id, pwHash);
    userId = existing.id;
    handle = existing.handle;
    resolvedDisplayName = existing.display_name;
    claimed = true;
  } else {
    const pwHash = await hashPassword(password);
    let inserted: UserRow | null = null;
    for (let attempt = 0; attempt < HANDLE_GEN_MAX_ATTEMPTS; attempt++) {
      const candidate = await generateFreeHandle(db, displayName);
      try {
        inserted = await createUser(db, {
          email,
          password_hash: pwHash,
          display_name: displayName,
          handle: candidate,
          ui_lang: uiLang,
        });
        break;
      } catch (err) {
        // Race: handle/email taken between probe and insert. Retry handle.
        if (
          err instanceof HttpError &&
          (err.code === "email_taken" || err.code === "handle_taken")
        ) {
          if (err.code === "email_taken") throw err;
          continue;
        }
        // D1 unique-violation surfaces as a generic Error from prepare().run().
        const message = err instanceof Error ? err.message.toLowerCase() : "";
        if (message.includes("unique") && message.includes("handle")) continue;
        if (message.includes("unique") && message.includes("email")) {
          throw new HttpError(
            409,
            "email_taken",
            "an account with this email exists; try logging in",
          );
        }
        throw err;
      }
    }
    if (!inserted) {
      throw new HttpError(
        503,
        "handle_unavailable",
        "could not allocate a free handle; please try again",
      );
    }
    userId = inserted.id;
    handle = inserted.handle;
    resolvedDisplayName = inserted.display_name;
  }

  // ---- session ----
  const sessionId = await createSession(db, {
    user_id: userId,
    ip: clientIp,
    user_agent: userAgent,
  });

  return setSessionCookie(
    jsonResponse(200, {
      user_id: userId,
      handle,
      display_name: resolvedDisplayName,
      claimed,
    }),
    sessionId,
    req,
  );
}
