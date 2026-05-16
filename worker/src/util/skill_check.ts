/**
 * GitHub skill-repo verification helpers.
 *
 * Skills live on GitHub (out of scope for the content migration). We
 * still need to confirm at submit time that the cited skill repo is
 * public and that the cited commit actually exists — that's what makes
 * the manifest's `skill.repo_url` + `skill.repo_commit` verifiable by
 * third parties.
 *
 * Ported verbatim from worker/src/index.ts:234-293, 440-467 (pre-Phase-A).
 * Token-less anonymous mode (`allow404`, no Authorization header) is the
 * point — we want to confirm anonymous reachability, not just authed
 * reachability via our PAT.
 */
import { HttpError } from "../types";

const USER_AGENT = "paiink-submit/1.0";
const GITHUB_TIMEOUT_MS = 10_000;

// ---------- repo URL parser ----------

/**
 * Parse `https://github.com/<owner>/<repo>` into its components. Strips
 * a trailing `.git` from the repo name. Throws 400 if the URL doesn't
 * match the expected pattern (parsePayload already pre-validates with
 * SKILL_REPO_URL_RE, but we keep this defensive in case a caller skips
 * that step).
 */
export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)$/);
  if (!m) {
    throw new HttpError(400, "validation", "skill_repo_url must be a GitHub URL");
  }
  return { owner: m[1] as string, repo: (m[2] as string).replace(/\.git$/, "") };
}

// ---------- low-level fetch wrapper ----------

interface GhFetchOpts {
  method?: string;
  token?: string;
  body?: unknown;
  /** Treat 404 as a value rather than an error (used by the existence checks). */
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

// ---------- public gates ----------

/**
 * Confirm the skill repo is publicly reachable from an anonymous
 * fetcher (no Authorization header). A private repo is reachable from
 * our PAT but not from third-party verifiers, which defeats provenance.
 */
export async function verifySkillRepoPublic(owner: string, repo: string): Promise<void> {
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

/**
 * Confirm the cited commit exists in the cited skill repo. We accept
 * 422 the same as 404 because GitHub returns 422 for malformed/short
 * SHAs that don't resolve.
 */
export async function verifySkillCommit(
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
