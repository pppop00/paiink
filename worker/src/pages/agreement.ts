/**
 * GET /agreement/v1 and GET /agreement/v2 — rendered agreement pages.
 *
 * Mirrors site/build.py:_write_agreement_version() (line 596). The bytes
 * come from R2 (uploaded once during Phase A migration) so a stray edit
 * cannot drift the rendered text from the pinned SHA-256. v1 is shown as
 * "archived"; v2 is the current version that new manifests bake into.
 *
 * Locale note: the agreement markdown body is byte-pinned legal text and
 * is NOT translated. The chrome around it (eyebrow, archived banner, hash
 * notice) is localized. English visitors also see a short paragraph above
 * the body explaining that the canonical text below is in Chinese.
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
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

const PINNED: Record<string, string> = {
  v1: AGREEMENT_V1_SHA256,
  v2: AGREEMENT_V2_SHA256,
};

export async function renderAgreement(
  req: Request,
  env: Env,
  version: string,
): Promise<Response> {
  const expected = PINNED[version];
  if (!expected) {
    throw new HttpError(404, "not_found", `Unknown agreement version: ${version}`);
  }
  const locale = getLocale(req);

  const [user, bytes] = await Promise.all([
    getCurrentUser(req, env),
    getAgreementBytes(env.R2_CONTENT, version),
  ]);
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
  <p><strong>${escape(t(locale, "agreement.archived_strong"))}</strong>${t(locale, "agreement.archived_body", { current: escape(CURRENT_AGREEMENT_VERSION) })}</p>
</section>`
    : "";

  const notice = `<section class="agreement-hash">
  <p class="eyebrow">${escape(t(locale, "agreement.eyebrow"))}</p>
  <p>${t(locale, "agreement.hash_intro", { full: escape(expected), short: escape(short), version: escape(version) })}</p>
  <p class="agreement-verify">
    <code>shasum -a 256 content/_meta/agreement-${escape(version)}.md</code>
  </p>
</section>`;

  // The body is in Chinese; if the visitor's UI is English, surface a brief
  // note above it so they know what they're looking at.
  const enNote = locale === "en"
    ? `<p class="lede" style="font-size:14px;margin:0 0 24px;color:var(--muted)">${t(locale, "agreement.english_note")}</p>`
    : "";

  const body = `${archivedBanner}${notice}
${enNote}
<article class="prose agreement-body">
${bodyMd}
</article>`;

  return new Response(
    shell({
      title: t(locale, "agreement.title", { version }),
      body,
      user,
      locale,
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
