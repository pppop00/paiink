/**
 * Request-side authentication helper.
 *
 * Every protected handler funnels through `getCurrentUser(req, env)`:
 *
 *   const me = await getCurrentUser(req, env);
 *   if (!me) return new Response(JSON.stringify({error: "unauthorized"}),
 *                                {status: 401, headers: {...}});
 *
 * The function:
 *   1. Reads the `paiink_sid` cookie.
 *   2. Looks the session up in D1; expired sessions return null.
 *   3. Fetches the bound user; deleted users return null.
 *   4. Fires a touchSession() update in the background (no await) so
 *      `last_seen_at` reflects activity without blocking the handler.
 *
 * Returning null is intentional — middleware doesn't get to write
 * responses (no access to status codes, content-types, redirects). The
 * caller knows whether to 401 / 403 / redirect to /login.
 *
 * API-token auth (Authorization: Bearer pai_...) lives in a sibling
 * helper that's added when Stream 2 wires up the public /api routes.
 * For now, only the cookie path is implemented.
 */

import type { Env, UserRow } from "../types";
import {
  findSession,
  findUserById,
  touchSession,
} from "../db/queries";
import { parseSessionCookie } from "./session";

export interface AuthedUser extends UserRow {
  /** Session id from the cookie. Useful when the caller needs to revoke it (logout). */
  session_id: string;
}

/**
 * Resolve the current user from the request cookie. Returns null on
 * missing cookie, expired/missing session, or missing/deleted user.
 *
 * Side effect: best-effort fire-and-forget `touchSession()` to bump
 * `last_seen_at`. Failures there are swallowed — we don't want a stale
 * write to invalidate an otherwise-valid auth check.
 */
export async function getCurrentUser(
  req: Request,
  env: Env,
): Promise<AuthedUser | null> {
  const sid = parseSessionCookie(req);
  if (!sid) return null;

  const session = await findSession(env.DB, sid);
  if (!session) return null;

  const user = await findUserById(env.DB, session.user_id);
  if (!user) return null;
  if (user.deleted_at !== null) return null;

  // Fire-and-forget. D1 awaits are cheap but the handler shouldn't wait
  // on a non-load-bearing update. We swallow the rejection so an
  // unhandledRejection doesn't blow up the isolate.
  touchSession(env.DB, sid).catch((e) => {
    console.warn(`[auth] touchSession failed: ${(e as Error).message}`);
  });

  return { ...user, session_id: sid };
}
