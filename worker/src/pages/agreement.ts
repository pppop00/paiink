/**
 * GET /agreement/v1 and GET /agreement/v2 — rendered agreement pages.
 *
 * Mirrors site/build.py:_write_agreement_version() (line 596). The bytes
 * come from R2 (uploaded once during Phase A migration) so a stray edit
 * cannot drift the rendered text from the pinned SHA-256. v1 is shown as
 * "archived"; v2 is the current version that new manifests bake into.
 *
 * No v3 path in Phase A — that's a Phase D deliverable when the new copy
 * ships and a fresh hash gets added to types.ts.
 */

import type { Env } from "../types";
import {
  AGREEMENT_V1_SHA256,
  AGREEMENT_V2_SHA256,
  CURRENT_AGREEMENT_VERSION,
  HttpError,
} from "../types";
import { getAgreementBytes } from "../r2";
import { mdToHtml } from "../util/md";
import { escape, shortHash } from "../util/html";
import { shell } from "../templates/shell";

const PINNED: Record<string, string> = {
  v1: AGREEMENT_V1_SHA256,
  v2: AGREEMENT_V2_SHA256,
};

export async function renderAgreement(
  _req: Request,
  env: Env,
  version: string,
): Promise<Response> {
  const expected = PINNED[version];
  if (!expected) {
    throw new HttpError(404, "not_found", `Unknown agreement version: ${version}`);
  }

  const bytes = await getAgreementBytes(env.R2_CONTENT, version);
  if (!bytes) {
    throw new HttpError(
      500,
      "missing_agreement",
      `R2 object agreements/agreement-${version}.md missing`,
    );
  }

  // Defense in depth: re-hash the bytes we just fetched and refuse to
  // render if they don't match the pinned constant. Cheap (one sha256
  // on a few kilobytes) and catches an accidental R2 overwrite loudly.
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new HttpError(
      500,
      "agreement_hash_drift",
      `agreement-${version}.md hash drift: expected ${expected}, got ${actual}`,
    );
  }

  const md = new TextDecoder().decode(bytes);
  const bodyMd = mdToHtml(md);
  const short = shortHash(expected, 8);

  const isArchived = version !== CURRENT_AGREEMENT_VERSION;
  const archivedBanner = isArchived
    ? `<section class="agreement-archived">
  <p><strong>归档版本。</strong>新投稿适用 <a href="/agreement/${escape(
    CURRENT_AGREEMENT_VERSION,
  )}">最新版本</a>。已发布文章的 manifest 永久绑定其上传时的协议版本。</p>
</section>`
    : "";

  const notice = `<section class="agreement-hash">
  <p class="eyebrow">协议哈希 / Agreement hash</p>
  <p>本协议哈希: <code title="${escape(expected)}">${escape(short)}</code>
   — 文件: <code>content/_meta/agreement-${escape(version)}.md</code>.
   任何人可下载源文件并本地复算验证。</p>
  <p class="agreement-verify">
    <code>shasum -a 256 content/_meta/agreement-${escape(version)}.md</code>
  </p>
</section>`;

  const body = `${archivedBanner}${notice}
<article class="prose agreement-body">
${bodyMd}
</article>`;

  return new Response(
    shell({
      title: `投稿协议 ${version} — pai.ink`,
      body,
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Agreement md is immutable per version — cache aggressively.
        "cache-control": "public, max-age=3600",
      },
    },
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
