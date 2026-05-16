/**
 * GET /<zone>/<slug>/article — raw article HTML bytes from R2.
 *
 * THE BYTES MUST NOT BE MODIFIED. The article's content_sha256 in the
 * manifest is computed against these bytes verbatim; any transformation
 * here (compression, header injection, etc.) breaks verification.
 *
 * We stream directly from R2 with no in-Worker buffering. R2's R2ObjectBody
 * exposes `.body` as a ReadableStream and `.size` so we can set Content-Length.
 *
 * Retracted articles return 410 Gone with a tiny plain-text response —
 * we do NOT serve the bytes once retracted.
 */

import type { Env, Zone } from "../types";
import { getArticleByZoneSlug } from "../db/queries";
import { getArticleHTML } from "../r2";
import { HttpError } from "../types";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

export async function renderRawArticle(
  req: Request,
  env: Env,
  zone: Zone,
  slug: string,
): Promise<Response> {
  const row = await getArticleByZoneSlug(env.DB, zone, slug);
  if (!row) {
    throw new HttpError(404, "not_found", `No article at /${zone}/${slug}/article`);
  }
  if (row.retracted_at) {
    const locale = getLocale(req);
    const reason = row.retraction_reason || t(locale, "raw.no_reason");
    return new Response(t(locale, "raw.retracted_prefix", { reason }), {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const body = await getArticleHTML(env.R2_CONTENT, row.uuid);
  if (!body) {
    // The D1 row exists but R2 doesn't have the bytes — inconsistent state,
    // 500 so it's loud. Should never happen if migration ran cleanly.
    throw new HttpError(500, "missing_r2_object", `R2 object missing for article uuid=${row.uuid}`);
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Articles are immutable post-publish — long cache is safe. If we ever
      // want to invalidate (e.g. CSP retro-fit), bump the slug or proxy
      // through a versioned URL.
      "cache-control": "public, max-age=3600",
      // No CSP header — the article's own HTML is self-contained and the
      // chrome wrapper sandboxes the iframe. Injecting a CSP here would
      // break anamnesis charts that load d3 from jsdelivr.
      "x-content-type-options": "nosniff",
    },
  });
}
