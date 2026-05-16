/**
 * paiink-api — Cloudflare Worker
 *
 * Endpoint: POST /submit (when hosted at api.paiink.com)
 *           POST /api/submit (when hosted at workers.dev or behind same-origin reverse-proxy)
 *
 * Accepts AI-generated article submissions (HTML + provenance metadata),
 * validates them, then commits index.html + ai-audit.json to the
 * pppop00/paiink repo via the GitHub Git Data API as a single atomic commit.
 * 4EVERLAND watches `main` and rebuilds in ~60-90s.
 *
 * Auth model (agreement v2+, no GitHub):
 *   - GITHUB_TOKEN (Worker secret): pushes the commit. Service identity.
 *     Commit author/committer: paiink-submit <submit@paiink.com>.
 *   - Submitter identity = display_name + email (declared, NOT verified).
 *     The platform never sends email to the address; accuracy is the
 *     author's responsibility per agreement v2 §6.
 *   - Sybil resistance: KV-backed IP rate limit (IP_DAILY_LIMIT/day,
 *     fail-soft if KV is unbound). Stack with Cloudflare WAF rules for
 *     defense in depth.
 */

const AGREEMENT_V2_SHA256 =
  "ec4066647aad291af1e7e88387b3dbfea8c63fce13da3e5ba64f11299793a19d";
const REPO_OWNER = "pppop00";
const REPO_NAME = "paiink";
const REPO_BRANCH = "main";
const COMMIT_AUTHOR_NAME = "paiink-submit";
const COMMIT_AUTHOR_EMAIL = "submit@paiink.com";
const USER_AGENT = "paiink-submit/1.0";
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const IP_DAILY_LIMIT = 3;
const RL_KEY_TTL_SECONDS = 36 * 3600; // auto-expire next day; 36h covers DST/timezone slop
const SLUG_MAX_VERSION = 100;
const GITHUB_TIMEOUT_MS = 10_000;
const ALLOWED_ORIGIN = "https://www.paiink.com";
// Loose email syntax — we never deliver mail from the Worker, the agreement
// makes accuracy the author's responsibility. Reject the obvious garbage only.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LICENSES = ["CC-BY-NC-4.0", "CC-BY-4.0", "CC0-1.0", "ARR"] as const;
type License = (typeof LICENSES)[number];
const ZONES = ["finance", "web3"] as const;
type Zone = (typeof ZONES)[number];
const LANGUAGES = ["zh-CN", "en"] as const;
type Language = (typeof LANGUAGES)[number];

interface Env {
  GITHUB_TOKEN: string;
  // KV namespace used for IP rate limiting. If unbound, rate limit is a no-op
  // (fail-soft). The dashboard binding name and the namespace id are wired up
  // separately in wrangler.toml; see worker/README.md.
  KV_RATE_LIMIT?: KVNamespace;
}

interface SubmitPayload {
  title: string;
  zone: Zone;
  language: Language;
  display_name: string;
  email: string;
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

interface Manifest {
  schema: string;
  schema_version: string;
  article: {
    id: string;
    title: string;
    category: Zone;
    language: Language;
    license: License;
    published_at: string;
    content_sha256: string;
    content_path: string;
    assets: never[];
    word_count: number;
  };
  skill: {
    name: string;
    repo_url: string;
    repo_commit: string;
  };
  generation: {
    model: string;
    harness: string;
    api_request_id?: string;
  };
  author: {
    email: string;
    display_name: string;
  };
  agreement: {
    version: string;
    sha256: string;
    accepted_at: string;
  };
}

class HttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, error: string, detail: string) {
    super(error);
    this.status = status;
    this.detail = detail;
  }
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function errorResponse(err: HttpError): Response {
  return jsonResponse(err.status, { error: err.message, detail: err.detail });
}

// ---------- helpers ----------

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function assertString(
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

function assertEnum<T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (!isString(v) || !(allowed as readonly string[]).includes(v)) {
    throw new HttpError(400, "validation", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

function kebabSlug(title: string): string {
  // Treat non-alphanumerics (incl. CJK) as separators, lowercase the rest.
  // Empty result is rejected by the caller.
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function todayUtcDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  // Workers do not implement btoa for large strings well, so chunk it.
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeBase64Maybe(s: string): Uint8Array {
  // Strip the optional data: URI prefix; some browser/agent flows send one.
  const stripped = s.replace(/^data:[^;,]*(;base64)?,/, "");
  try {
    return base64ToBytes(stripped);
  } catch {
    throw new HttpError(400, "validation", "html must be base64-encoded in JSON mode");
  }
}

function wordCountFromHtml(html: Uint8Array): number {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(html);
  const stripped = text.replace(/<[^>]+>/g, " ");
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)$/);
  if (!m) {
    throw new HttpError(400, "validation", "skill_repo_url must be a GitHub URL");
  }
  return { owner: m[1] as string, repo: (m[2] as string).replace(/\.git$/, "") };
}

// ---------- GitHub fetch wrapper ----------

interface GhFetchOpts {
  method?: string;
  token?: string;
  body?: unknown;
  // Treat "not found" as a value rather than an error for some calls.
  allow404?: boolean;
}

async function ghFetch(
  url: string,
  opts: GhFetchOpts = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    throw new HttpError(503, "upstream", `GitHub request failed: ${(e as Error).message}`);
  }
  if (resp.status >= 500) {
    throw new HttpError(503, "upstream", "GitHub temporarily unavailable");
  }
  const text = await resp.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (resp.status === 404 && opts.allow404) {
    return { status: 404, body: parsed };
  }
  return { status: resp.status, body: parsed };
}

// ---------- input parsing ----------

async function parsePayload(req: Request): Promise<SubmitPayload> {
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
    rawAgreementAccepted = aa === "true" || aa === "1" || aa === "on" ? true : aa === null ? undefined : false;
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
  const display_name = assertString(rawDisplayName, "display_name", { min: 1, max: 100 });
  const email = assertString(rawEmail, "email", { min: 3, max: 254 });
  if (!EMAIL_RE.test(email)) {
    throw new HttpError(400, "validation", "email must be a syntactically valid address");
  }
  const skill_name = assertString(rawSkillName, "skill_name", { min: 1, max: 200 });
  const skill_repo_url = assertString(rawSkillRepoUrl, "skill_repo_url");
  if (!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(skill_repo_url)) {
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

// ---------- gating ----------

async function verifySkillRepoPublic(owner: string, repo: string): Promise<void> {
  // No token here — we want to confirm anonymous reachability.
  const r = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`, {
    allow404: true,
  });
  if (r.status === 404) {
    throw new HttpError(400, "skill_repo", "skill repo not found or not public");
  }
  if (r.status !== 200) {
    throw new HttpError(400, "skill_repo", `skill repo check failed (status ${r.status})`);
  }
}

async function verifySkillCommit(
  owner: string,
  repo: string,
  commit: string,
): Promise<void> {
  const r = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${commit}`,
    { allow404: true },
  );
  if (r.status === 200) return;
  if (r.status === 404 || r.status === 422) {
    throw new HttpError(400, "skill_commit", "skill_repo_commit not found in skill repo");
  }
  throw new HttpError(400, "skill_commit", `commit check failed (status ${r.status})`);
}

async function pickAvailableSlug(
  zone: Zone,
  baseSlug: string,
  token: string,
): Promise<string> {
  for (let v = 1; v <= SLUG_MAX_VERSION; v++) {
    const candidate = v === 1 ? baseSlug : `${baseSlug}-v${v}`;
    const r = await ghFetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/content/${zone}/${candidate}?ref=${REPO_BRANCH}`,
      { token, allow404: true },
    );
    if (r.status === 404) return candidate;
    if (r.status !== 200) {
      throw new HttpError(500, "slug_check", `slug existence check failed (${r.status})`);
    }
  }
  throw new HttpError(409, "slug", "too many versions; pick a new title");
}

async function enforceIpRateLimit(req: Request, env: Env): Promise<void> {
  // Best-effort daily cap keyed by CF-Connecting-IP. Fail-soft: if KV is
  // unbound or unreachable, let the request through rather than 500-ing the
  // submitter. Stack with Cloudflare WAF rate-limiting rules for hard limits.
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

// ---------- commit via Git Data API ----------

interface CommitResult {
  commit_sha: string;
}

async function commitFiles(
  token: string,
  slug: string,
  zone: Zone,
  html: Uint8Array,
  manifest: Manifest,
  title: string,
): Promise<CommitResult> {
  const apiBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

  // 1. Get current ref + base commit + base tree.
  const refResp = await ghFetch(`${apiBase}/git/refs/heads/${REPO_BRANCH}`, { token });
  if (refResp.status !== 200 || typeof refResp.body !== "object" || refResp.body === null) {
    throw new HttpError(500, "git", `failed to read ref (${refResp.status})`);
  }
  const refObj = (refResp.body as { object?: { sha?: unknown } }).object;
  if (!refObj || !isString(refObj.sha)) {
    throw new HttpError(500, "git", "ref has no commit sha");
  }
  const parentCommitSha = refObj.sha;

  const parentCommitResp = await ghFetch(`${apiBase}/git/commits/${parentCommitSha}`, { token });
  if (parentCommitResp.status !== 200 || typeof parentCommitResp.body !== "object" || parentCommitResp.body === null) {
    throw new HttpError(500, "git", `failed to read parent commit (${parentCommitResp.status})`);
  }
  const parentTreeSha = (parentCommitResp.body as { tree?: { sha?: unknown } }).tree?.sha;
  if (!isString(parentTreeSha)) {
    throw new HttpError(500, "git", "parent commit has no tree sha");
  }

  // 2. Create blobs.
  const htmlBlob = await ghFetch(`${apiBase}/git/blobs`, {
    method: "POST",
    token,
    body: { content: bytesToBase64(html), encoding: "base64" },
  });
  if (htmlBlob.status !== 201 || typeof htmlBlob.body !== "object" || htmlBlob.body === null) {
    throw new HttpError(500, "git", `failed to create html blob (${htmlBlob.status})`);
  }
  const htmlBlobSha = (htmlBlob.body as { sha?: unknown }).sha;
  if (!isString(htmlBlobSha)) throw new HttpError(500, "git", "html blob missing sha");

  const manifestStr = JSON.stringify(manifest, null, 2) + "\n";
  const manifestBlob = await ghFetch(`${apiBase}/git/blobs`, {
    method: "POST",
    token,
    body: { content: manifestStr, encoding: "utf-8" },
  });
  if (manifestBlob.status !== 201 || typeof manifestBlob.body !== "object" || manifestBlob.body === null) {
    throw new HttpError(500, "git", `failed to create manifest blob (${manifestBlob.status})`);
  }
  const manifestBlobSha = (manifestBlob.body as { sha?: unknown }).sha;
  if (!isString(manifestBlobSha)) throw new HttpError(500, "git", "manifest blob missing sha");

  // 3. Create tree (using base_tree so the rest of the repo is preserved).
  const basePath = `content/${zone}/${slug}`;
  const treeResp = await ghFetch(`${apiBase}/git/trees`, {
    method: "POST",
    token,
    body: {
      base_tree: parentTreeSha,
      tree: [
        { path: `${basePath}/index.html`, mode: "100644", type: "blob", sha: htmlBlobSha },
        { path: `${basePath}/ai-audit.json`, mode: "100644", type: "blob", sha: manifestBlobSha },
      ],
    },
  });
  if (treeResp.status !== 201 || typeof treeResp.body !== "object" || treeResp.body === null) {
    throw new HttpError(500, "git", `failed to create tree (${treeResp.status})`);
  }
  const newTreeSha = (treeResp.body as { sha?: unknown }).sha;
  if (!isString(newTreeSha)) throw new HttpError(500, "git", "tree missing sha");

  // 4. Create commit.
  const commitTime = nowIso();
  const commitResp = await ghFetch(`${apiBase}/git/commits`, {
    method: "POST",
    token,
    body: {
      message: `publish: ${title} (#${slug})`,
      parents: [parentCommitSha],
      tree: newTreeSha,
      author: { name: COMMIT_AUTHOR_NAME, email: COMMIT_AUTHOR_EMAIL, date: commitTime },
      committer: { name: COMMIT_AUTHOR_NAME, email: COMMIT_AUTHOR_EMAIL, date: commitTime },
    },
  });
  if (commitResp.status !== 201 || typeof commitResp.body !== "object" || commitResp.body === null) {
    throw new HttpError(500, "git", `failed to create commit (${commitResp.status})`);
  }
  const newCommitSha = (commitResp.body as { sha?: unknown }).sha;
  if (!isString(newCommitSha)) throw new HttpError(500, "git", "commit missing sha");

  // 5. Fast-forward the ref. force=false: if main moved while we were
  //    building, fail loudly rather than overwriting someone else's commit.
  const patchResp = await ghFetch(`${apiBase}/git/refs/heads/${REPO_BRANCH}`, {
    method: "PATCH",
    token,
    body: { sha: newCommitSha, force: false },
  });
  if (patchResp.status !== 200) {
    if (patchResp.status === 422) {
      throw new HttpError(
        409,
        "git_conflict",
        "branch moved during commit; retry",
      );
    }
    throw new HttpError(500, "git", `failed to advance ref (${patchResp.status})`);
  }

  return { commit_sha: newCommitSha };
}

// ---------- main handler ----------

async function handleSubmit(req: Request, env: Env): Promise<Response> {
  // Agreement v2: no PAT, no GitHub. Identity is the declared email +
  // display_name. Rate limit is per IP via KV.
  const payload = await parsePayload(req);

  await enforceIpRateLimit(req, env);

  const { owner: skillOwner, repo: skillRepo } = parseRepoUrl(payload.skill_repo_url);
  await verifySkillRepoPublic(skillOwner, skillRepo);
  await verifySkillCommit(skillOwner, skillRepo, payload.skill_repo_commit);

  // Empty-after-kebab can happen with all-CJK titles. Fall back to a stable
  // article-<8hex>-<date> form so Chinese-language titles aren't rejected.
  let baseKebab = kebabSlug(payload.title);
  if (baseKebab.length === 0) {
    baseKebab = `article-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }
  const baseSlug = `${baseKebab}-${todayUtcDate()}`;
  const slug = await pickAvailableSlug(payload.zone, baseSlug, env.GITHUB_TOKEN);

  const contentSha = await sha256Hex(payload.html);
  const publishedAt = nowIso();

  const manifest: Manifest = {
    schema: "https://pai.ink/schemas/ai-audit/v1.json",
    schema_version: "1.0",
    article: {
      id: crypto.randomUUID(),
      title: payload.title,
      category: payload.zone,
      language: payload.language,
      license: payload.license,
      published_at: publishedAt,
      content_sha256: contentSha,
      content_path: "index.html",
      assets: [],
      word_count: wordCountFromHtml(payload.html),
    },
    skill: {
      name: payload.skill_name,
      repo_url: payload.skill_repo_url,
      repo_commit: payload.skill_repo_commit,
    },
    generation: {
      model: payload.model,
      harness: payload.harness,
      ...(payload.api_request_id ? { api_request_id: payload.api_request_id } : {}),
    },
    author: {
      email: payload.email,
      display_name: payload.display_name,
    },
    agreement: {
      version: "v2",
      sha256: AGREEMENT_V2_SHA256,
      accepted_at: publishedAt,
    },
  };

  const { commit_sha } = await commitFiles(
    env.GITHUB_TOKEN,
    slug,
    payload.zone,
    payload.html,
    manifest,
    payload.title,
  );

  return jsonResponse(200, {
    slug,
    url: `https://www.paiink.com/${payload.zone}/${slug}/`,
    live_in_seconds_estimate: 90,
    commit_sha,
  });
}

// ---------- entrypoint ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Accept both /submit (when served at api.paiink.com via Custom Domain)
    // and /api/submit (when served at workers.dev or any same-origin reverse-proxy).
    if (url.pathname !== "/submit" && url.pathname !== "/api/submit") {
      return jsonResponse(404, { error: "not_found", detail: "no such endpoint" });
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed", detail: "POST only" });
    }
    try {
      return await handleSubmit(req, env);
    } catch (e) {
      if (e instanceof HttpError) {
        return errorResponse(e);
      }
      // Genuine internal error — only place we log, so Workers tail surfaces it.
      console.error("unhandled error in submit endpoint:", e);
      return jsonResponse(500, {
        error: "internal",
        detail: "unexpected error; see Worker logs",
      });
    }
  },
};
