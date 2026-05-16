/**
 * Submission payload parsing + low-level validators.
 *
 * Ported from worker/src/index.ts (pre-Phase-A) more or less verbatim.
 * Keep the user-facing contract (field names, error shapes, max sizes)
 * stable so existing agent clients and the browser form keep working
 * across the GitHub→D1+R2 cutover.
 *
 * Phase A scope:
 *   • Same multipart + JSON shapes as before
 *   • Same enum / length / regex checks
 *   • declared email + display_name still come from the body (no auth yet)
 *
 * Phase B will swap declared identity for a session-derived user and add
 * Turnstile, at which point parsePayload still runs first and then the
 * caller overrides email/display_name from the session.
 */
import {
  HttpError,
  LANGUAGES,
  LICENSES,
  ZONES,
  type Language,
  type License,
  type Zone,
} from "../types";

// ---------- limits & regexes ----------

export const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Loose email syntax — we never deliver mail from the Worker, the agreement
// makes accuracy the author's responsibility. Reject the obvious garbage only.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Reused across the GitHub skill-repo URL gate (also surfaced for tests).
export const SKILL_REPO_URL_RE = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/;

// ---------- shape ----------

export interface SubmitPayload {
  title: string;
  zone: Zone;
  language: Language;
  /**
   * Declared display_name. Optional starting Phase B: when the caller
   * authenticates via session cookie or Bearer token, identity comes from
   * the user row instead. Unauthenticated submits still require it.
   */
  display_name: string | null;
  /** Declared email. Same optionality rules as display_name. */
  email: string | null;
  skill_name: string;
  skill_repo_url: string;
  skill_repo_commit: string;
  model: string;
  harness: string;
  license: License;
  agreement_accepted: boolean;
  api_request_id?: string;
  html: Uint8Array;
}

// ---------- primitive validators ----------

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

export function assertString(
  v: unknown,
  field: string,
  { min = 1, max = Infinity }: { min?: number; max?: number } = {},
): string {
  if (!isString(v)) throw new HttpError(400, "validation", `${field} must be a string`);
  if (v.length < min || v.length > max) {
    throw new HttpError(400, "validation", `${field} length must be ${min}-${max}`);
  }
  return v;
}

export function assertEnum<T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (!isString(v) || !(allowed as readonly string[]).includes(v)) {
    throw new HttpError(400, "validation", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

// ---------- encoding helpers ----------

export function bytesToBase64(bytes: Uint8Array): string {
  // Workers do not implement btoa for large strings well, so chunk it.
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeBase64Maybe(s: string): Uint8Array {
  // Strip the optional data: URI prefix; some browser/agent flows send one.
  const stripped = s.replace(/^data:[^;,]*(;base64)?,/, "");
  try {
    return base64ToBytes(stripped);
  } catch {
    throw new HttpError(400, "validation", "html must be base64-encoded in JSON mode");
  }
}

// ---------- content helpers ----------

/** SHA-256 over the raw bytes of a Uint8Array, returned as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cheap whitespace-split word count after stripping HTML tags. Good enough
 * for the manifest's word_count field; we don't need linguistic accuracy.
 */
export function wordCountFromHtml(html: Uint8Array): number {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(html);
  const stripped = text.replace(/<[^>]+>/g, " ");
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------- parser ----------

/**
 * Parse a /api/submit request body. Accepts:
 *   - application/json (agent path): `html` is a base64 string (optional
 *     `data:` URI prefix is stripped).
 *   - multipart/form-data (browser path): `html` is a file part.
 *
 * Throws HttpError(400) on shape/length/enum issues, HttpError(413) when
 * the decoded HTML exceeds MAX_HTML_BYTES, HttpError(415) for unsupported
 * Content-Type.
 */
export async function parsePayload(req: Request): Promise<SubmitPayload> {
  const ct = (req.headers.get("Content-Type") ?? "").toLowerCase();

  let rawTitle: unknown;
  let rawZone: unknown;
  let rawLanguage: unknown;
  let rawDisplayName: unknown;
  let rawEmail: unknown;
  let rawSkillName: unknown;
  let rawSkillRepoUrl: unknown;
  let rawSkillRepoCommit: unknown;
  let rawModel: unknown;
  let rawHarness: unknown;
  let rawLicense: unknown;
  let rawAgreementAccepted: unknown;
  let rawApiRequestId: unknown;
  let html: Uint8Array;

  if (ct.startsWith("application/json")) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "validation", "invalid JSON body");
    }
    if (typeof body !== "object" || body === null) {
      throw new HttpError(400, "validation", "JSON body must be an object");
    }
    const o = body as Record<string, unknown>;
    rawTitle = o.title;
    rawZone = o.zone;
    rawLanguage = o.language;
    rawDisplayName = o.display_name;
    rawEmail = o.email;
    rawSkillName = o.skill_name;
    rawSkillRepoUrl = o.skill_repo_url;
    rawSkillRepoCommit = o.skill_repo_commit;
    rawModel = o.model;
    rawHarness = o.harness;
    rawLicense = o.license;
    rawAgreementAccepted = o.agreement_accepted;
    rawApiRequestId = o.api_request_id;
    if (!isString(o.html)) {
      throw new HttpError(400, "validation", "html must be a base64 string in JSON mode");
    }
    html = decodeBase64Maybe(o.html);
  } else if (ct.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, "validation", "invalid multipart body");
    }
    rawTitle = form.get("title");
    rawZone = form.get("zone");
    rawLanguage = form.get("language");
    rawDisplayName = form.get("display_name");
    rawEmail = form.get("email");
    rawSkillName = form.get("skill_name");
    rawSkillRepoUrl = form.get("skill_repo_url");
    rawSkillRepoCommit = form.get("skill_repo_commit");
    rawModel = form.get("model");
    rawHarness = form.get("harness");
    rawLicense = form.get("license");
    const aa = form.get("agreement_accepted");
    rawAgreementAccepted =
      aa === "true" || aa === "1" || aa === "on"
        ? true
        : aa === null
          ? undefined
          : false;
    rawApiRequestId = form.get("api_request_id") ?? undefined;
    // The Cloudflare Workers types declare FormData.get() as `string | null`,
    // but at runtime the entry for a file field is a Blob/File. We narrow via
    // structural check rather than `instanceof File` (the Workers type system
    // doesn't always recognize File as a side of the union).
    const htmlField: unknown = form.get("html");
    if (htmlField === null || typeof htmlField === "string") {
      throw new HttpError(400, "validation", "html must be a file upload in multipart mode");
    }
    const blob = htmlField as { arrayBuffer(): Promise<ArrayBuffer> };
    const buf = await blob.arrayBuffer();
    html = new Uint8Array(buf);
  } else {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json or multipart/form-data",
    );
  }

  if (html.byteLength > MAX_HTML_BYTES) {
    throw new HttpError(413, "too_large", `html exceeds ${MAX_HTML_BYTES} bytes`);
  }
  if (html.byteLength === 0) {
    throw new HttpError(400, "validation", "html is empty");
  }

  const title = assertString(rawTitle, "title", { min: 1, max: 200 });
  const zone = assertEnum(rawZone, "zone", ZONES);
  const language = assertEnum(rawLanguage, "language", LANGUAGES);

  // display_name + email are optional starting Phase B (session/Bearer
  // auth supplies them). When present they must still be well-formed;
  // when absent, leave as null and let the caller fill them in from the
  // authenticated user. The submit handler enforces "either auth OR both
  // fields present" so this loosening doesn't open an anonymous-bypass hole.
  const dnPresent = rawDisplayName !== undefined && rawDisplayName !== null && rawDisplayName !== "";
  const emPresent = rawEmail !== undefined && rawEmail !== null && rawEmail !== "";
  const display_name = dnPresent
    ? assertString(rawDisplayName, "display_name", { min: 1, max: 100 })
    : null;
  let email: string | null = null;
  if (emPresent) {
    email = assertString(rawEmail, "email", { min: 3, max: 254 });
    if (!EMAIL_RE.test(email)) {
      throw new HttpError(400, "validation", "email must be a syntactically valid address");
    }
  }
  const skill_name = assertString(rawSkillName, "skill_name", { min: 1, max: 200 });
  const skill_repo_url = assertString(rawSkillRepoUrl, "skill_repo_url");
  if (!SKILL_REPO_URL_RE.test(skill_repo_url)) {
    throw new HttpError(400, "validation", "skill_repo_url must match GitHub URL pattern");
  }
  const skill_repo_commit = assertString(rawSkillRepoCommit, "skill_repo_commit");
  if (!/^[0-9a-f]{40}$/.test(skill_repo_commit)) {
    throw new HttpError(400, "validation", "skill_repo_commit must be 40 hex chars");
  }
  const model = assertString(rawModel, "model", { min: 1, max: 100 });
  const harness = assertString(rawHarness, "harness", { min: 1, max: 100 });
  const licenseVal = assertEnum(rawLicense, "license", LICENSES);

  if (!isBoolean(rawAgreementAccepted) || rawAgreementAccepted !== true) {
    throw new HttpError(403, "agreement", "agreement_accepted must be true");
  }

  let api_request_id: string | undefined;
  if (rawApiRequestId !== undefined && rawApiRequestId !== null && rawApiRequestId !== "") {
    api_request_id = assertString(rawApiRequestId, "api_request_id", { min: 1, max: 200 });
  }

  return {
    title,
    zone,
    language,
    display_name,
    email,
    skill_name,
    skill_repo_url,
    skill_repo_commit,
    model,
    harness,
    license: licenseVal,
    agreement_accepted: true,
    api_request_id,
    html,
  };
}
