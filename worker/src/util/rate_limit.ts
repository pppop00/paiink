/**
 * IP rate limiting.
 *
 * Phase A: kept KV-backed and fail-soft, identical to the pre-Phase-A
 * implementation in worker/src/index.ts:488-518. The submit handler is
 * the only caller.
 *
 * Phase B+: migrate to D1 `rate_limits` table (scope/window_start/count)
 * and add per-user limits + signup-IP limits. That swap happens at the
 * call site — this file gets retired (or rewritten to query D1) then.
 */
import { HttpError, type Env } from "../types";

/** Max submissions per IP per UTC day. */
const IP_DAILY_LIMIT = 3;

/** KV value TTL — 36h covers DST/timezone slop so a key auto-expires next day. */
const RL_KEY_TTL_SECONDS = 36 * 3600;

/** Format YYYY-MM-DD in UTC; used to scope the KV key. */
function todayUtcDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Best-effort daily cap keyed by CF-Connecting-IP. Fail-soft: if KV is
 * unbound or unreachable, let the request through rather than 500-ing
 * the submitter. Stack with Cloudflare WAF rate-limiting rules for hard
 * limits.
 *
 * Throws HttpError(429) only when KV is reachable AND the current
 * count is already at/above IP_DAILY_LIMIT.
 */
export async function enforceIpRateLimit(req: Request, env: Env): Promise<void> {
  const kv = env.KV_RATE_LIMIT;
  if (!kv) return;

  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `rl:${todayUtcDate()}:${ip}`;
  let count = 0;
  try {
    const v = await kv.get(key);
    count = v ? parseInt(v, 10) : 0;
    if (Number.isNaN(count)) count = 0;
  } catch {
    return; // KV read failed — fail-soft, don't block
  }
  if (count >= IP_DAILY_LIMIT) {
    throw new HttpError(
      429,
      "rate_limit",
      `rate limit: max ${IP_DAILY_LIMIT} articles/day from your IP`,
    );
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: RL_KEY_TTL_SECONDS });
  } catch {
    // Increment failed — let the submission through; the WAF + agreement
    // are the real guarantees. Better than failing a legitimate submitter.
  }
}
