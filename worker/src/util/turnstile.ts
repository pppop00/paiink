/**
 * Cloudflare Turnstile siteverify wrapper.
 *
 * Turnstile is an invisible-by-default CAPTCHA that runs in the browser
 * and produces a short-lived token. We forward that token + the
 * server-side secret to challenges.cloudflare.com/turnstile/v0/siteverify
 * to confirm it's valid before honoring the request (signup is the only
 * Phase B caller; login can optionally be gated later).
 *
 * Cloudflare publishes test keys that always pass / always fail without
 * making real API calls — useful for local dev and integration tests.
 * The dummy site key is exported here so HTML templates can render the
 * widget without hardcoding the magic string in two places.
 *
 * Failure model: anything non-success returns false. The caller is
 * responsible for turning that into the appropriate HTTP error. We never
 * throw — Turnstile being unreachable shouldn't crash the request
 * handler, but it MUST gate signup (fail-closed), which is why the
 * default for a real (non-test, non-undefined) secret on network error
 * is `false`.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;

/**
 * Cloudflare's publicly-documented dummy site key — always succeeds in
 * the browser without showing a challenge. Pair with TURNSTILE_SECRET =
 * "1x0000000000000000000000000000000AA" (always-pass secret) for the
 * full dev loop.
 *
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
export const TURNSTILE_SITE_KEY_DEV = "1x00000000000000000000AA";

/**
 * The two well-known CF test secrets. Detected so we can log a clearer
 * warning ("dev mode") rather than silently treating them like prod.
 */
const TEST_SECRETS = new Set<string>([
  "1x0000000000000000000000000000000AA", // always-passes
  "2x0000000000000000000000000000000AA", // always-fails
  "3x0000000000000000000000000000000AA", // always-passes, token spent
]);

interface SiteverifyResponse {
  success?: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

/**
 * Validate a Turnstile token. See module-level docstring for the
 * dev/test-mode semantics.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string | null,
  secret: string | undefined,
): Promise<boolean> {
  // Phase A reserved the secret binding but didn't provision one. While
  // a secret is missing we keep the gate open so the existing submit
  // flow keeps working — but loudly, so we notice in logs.
  if (secret === undefined || secret === "") {
    console.warn(
      "[turnstile] TURNSTILE_SECRET not set; bypassing siteverify (dev mode)",
    );
    return true;
  }

  if (!token) {
    // Missing token from the client. Real secret + missing token = reject.
    return false;
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);

  let resp: Response;
  try {
    resp = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Network / timeout. Fail-closed in production; the test secrets
    // hit the same code path because we still call siteverify for them.
    console.warn(
      `[turnstile] siteverify network error: ${(e as Error).message}`,
    );
    return false;
  }

  if (!resp.ok) {
    console.warn(`[turnstile] siteverify HTTP ${resp.status}`);
    return false;
  }

  let parsed: SiteverifyResponse;
  try {
    parsed = (await resp.json()) as SiteverifyResponse;
  } catch {
    return false;
  }

  if (parsed.success !== true && TEST_SECRETS.has(secret)) {
    // The always-fail / spent-token test secrets land here on purpose.
    // Surface the error codes so integration tests can read them.
    console.info(
      `[turnstile] test secret rejected token: ${JSON.stringify(parsed["error-codes"] ?? [])}`,
    );
  }

  return parsed.success === true;
}
