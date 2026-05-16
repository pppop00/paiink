/**
 * ai-audit manifest builder.
 *
 * Extracted from worker/src/index.ts:664-698 (pre-Phase-A). The byte
 * shape of the manifest is the contract with readers — once a manifest
 * is written to R2, the same JSON.stringify(manifest, null, 2) + "\n"
 * pattern must be used on re-serializations (don't reorder keys, don't
 * change indentation).
 *
 * The article id is passed in so the caller (handleSubmit) can reuse
 * the same string as the D1 `articles.uuid` column — keeps the
 * /verify/<uuid> link and the manifest's `article.id` aligned.
 */
import {
  CURRENT_AGREEMENT_SHA256,
  CURRENT_AGREEMENT_VERSION,
  type Language,
  type License,
  type Manifest,
  type Zone,
} from "../types";

export interface BuildManifestInput {
  /** UUID/ULID used both in the manifest and as the D1 uuid column. */
  articleId: string;
  title: string;
  zone: Zone;
  language: Language;
  license: License;
  /** ISO-8601 UTC timestamp; also reused for agreement.accepted_at. */
  publishedAt: string;
  /** sha256(html_bytes), lowercase hex. */
  contentSha: string;
  wordCount: number;
  skillName: string;
  skillRepoUrl: string;
  skillRepoCommit: string;
  model: string;
  harness: string;
  apiRequestId?: string;
  email: string;
  displayName: string;
}

/**
 * Build the manifest JS object. The caller is responsible for byte-
 * stable serialization (`JSON.stringify(m, null, 2) + "\n"`) when
 * persisting to R2 — see putArticleManifest in src/r2.ts.
 *
 * The agreement.version + agreement.sha256 are pinned to whatever is
 * current in types.ts; Phase D bumps these to v3.
 */
export function buildManifest(input: BuildManifestInput): Manifest {
  return {
    schema: "https://pai.ink/schemas/ai-audit/v1.json",
    schema_version: "1.0",
    article: {
      id: input.articleId,
      title: input.title,
      category: input.zone,
      language: input.language,
      license: input.license,
      published_at: input.publishedAt,
      content_sha256: input.contentSha,
      content_path: "index.html",
      assets: [],
      word_count: input.wordCount,
    },
    skill: {
      name: input.skillName,
      repo_url: input.skillRepoUrl,
      repo_commit: input.skillRepoCommit,
    },
    generation: {
      model: input.model,
      harness: input.harness,
      ...(input.apiRequestId ? { api_request_id: input.apiRequestId } : {}),
    },
    author: {
      email: input.email,
      display_name: input.displayName,
    },
    agreement: {
      version: CURRENT_AGREEMENT_VERSION,
      sha256: CURRENT_AGREEMENT_SHA256,
      accepted_at: input.publishedAt,
    },
  };
}
