/**
 * Session cookie helpers.
 *
 * One cookie name (`paiink_sid`) carries a 256-bit random session id
 * issued by `createSession()` in db/queries.ts. The id is the rowkey
 * into the D1 `sessions` table — there's no JWT, no signing layer; it's
 * a bearer token whose validity is checked by D1 lookup on every
 * request that calls `getCurrentUser()`.
 *
 * Cookie attributes:
 *   HttpOnly   — JS can't read it; defends against XSS exfil
 *   Secure     — only sent over HTTPS. Modern browsers (Chrome 89+,
 *                Firefox, Safari) honor this on http://localhost too,
 *                so dev still works without a cert.
 *   SameSite=Lax — sent on top-level navigations from other sites
 *                  (so logging in via an external link works) but
 *                  blocked for cross-site POST/fetch (CSRF baseline).
 *   Path=/     — every Worker route can read it
 *   Max-Age    — 90 days; matches the D1 session expires_at default.
 */

export const SESSION_COOKIE = "paiink_sid";
export const SESSION_MAX_AGE_SEC = 90 * 24 * 3600;

const COOKIE_ATTRS = `HttpOnly; Secure; SameSite=Lax; Path=/`;

/**
 * Clone the response (preserving body/status/headers) with a Set-Cookie
 * header appended that installs the given session id. Callers should
 * use this immediately before returning, on the same Response they
 * built for the success path.
 */
export function setSessionCookie(response: Response, sessionId: string): Response {
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; ${COOKIE_ATTRS}; Max-Age=${SESSION_MAX_AGE_SEC}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Clone the response with a Set-Cookie that immediately expires the
 * session cookie (Max-Age=0). Browsers drop it on receipt.
 */
export function clearSessionCookie(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Pull the session id out of the `Cookie` request header. Returns null
 * if the header is absent, the cookie isn't set, or its value is empty.
 * Tolerates whitespace and unrelated cookies before/after ours.
 */
export function parseSessionCookie(req: Request): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  // RFC 6265: name=value pairs separated by "; ". We do a forgiving split.
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (!value) return null;
    return value;
  }
  return null;
}
