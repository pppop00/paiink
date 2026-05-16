/**
 * Password hashing, random tokens, and SHA-256 helpers.
 *
 * Pure Web Crypto — no Node builtins, no npm dependencies. Cloudflare
 * Workers exposes `crypto.subtle`, `crypto.getRandomValues`, `btoa`, and
 * `atob`; that's everything we need.
 *
 * Password hashing uses PBKDF2-HMAC-SHA256 with 100,000 iterations,
 * a 16-byte random salt, and a 32-byte derived key. The stored credential
 * is a modular-crypt-style string:
 *
 *   pbkdf2$<iter>$<saltB64>$<hashB64>
 *
 * Embedding the iteration count means we can raise PBKDF2_ITER in the
 * future and verify old hashes against their original parameters.
 *
 * Why 100k instead of OWASP 2023's recommended 600k: Cloudflare Workers'
 * crypto.subtle.deriveBits HARD-CAPS PBKDF2 at 100,000 iterations and
 * throws NotSupportedError above that. 100k is OWASP's older (2021)
 * recommendation; reasonable for a community AI-publishing site whose
 * threat model isn't financial/healthcare. Re-evaluate if Workers raises
 * the cap.
 */

const PBKDF2_ITER = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;

// ---------- base64 / hex helpers ----------

function bytesToBase64(bytes: Uint8Array): string {
  // Workers runtime exposes btoa for binary strings <= 8KB. Our inputs are
  // tens of bytes, so the per-byte string build is fine.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] as number);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

// ---------- PBKDF2 ----------

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  hashBytes: number,
): Promise<Uint8Array> {
  const pwBytes = new TextEncoder().encode(password);
  const key = await crypto.subtle.importKey(
    "raw",
    pwBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    key,
    hashBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a plaintext password. Returns a self-describing credential string
 * suitable for direct storage in `users.password_hash`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITER, PBKDF2_HASH_BYTES);
  return `pbkdf2$${PBKDF2_ITER}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

/**
 * Verify a plaintext against a stored credential string. Returns false
 * (never throws) if the stored value is malformed or doesn't match —
 * callers should treat verify-failure and parse-failure identically to
 * avoid leaking which case occurred.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  if (parts[0] !== "pbkdf2") return false;
  const iter = parseInt(parts[1] as string, 10);
  if (!Number.isFinite(iter) || iter < 1000 || iter > 10_000_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64ToBytes(parts[2] as string);
    expected = base64ToBytes(parts[3] as string);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await pbkdf2(password, salt, iter, expected.length);
  // Constant-time compare on the raw bytes.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= (actual[i] as number) ^ (expected[i] as number);
  }
  return diff === 0;
}

// ---------- random tokens ----------

/**
 * Cryptographically-random hex string. `byteLen=32` → 64-char hex
 * (256 bits of entropy), which is what we use for session ids and the
 * body of API tokens.
 */
export function randomTokenHex(byteLen: number): string {
  if (byteLen <= 0 || byteLen > 1024) {
    throw new Error(`randomTokenHex: byteLen out of range (${byteLen})`);
  }
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// ---------- SHA-256 ----------

/**
 * SHA-256 of a string (UTF-8) or raw bytes, returned as lowercase hex.
 * Used to fingerprint API tokens before storing them in D1 — the
 * plaintext is shown to the user exactly once and discarded.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

// ---------- timing-safe string compare ----------

/**
 * Constant-time equality on two strings. Use when comparing two hex
 * digests, two base64 fingerprints, or any value where short-circuit
 * compare would leak information via timing. Different-length strings
 * still return false, but in constant time relative to the longer one.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
