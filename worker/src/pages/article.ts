/**
 * GET /<zone>/<slug>/ — iframe chrome wrapper for an article.
 *
 * Mirrors site/build.py:_article_chrome() (line 666). The article HTML
 * itself is served byte-identical at /<zone>/<slug>/article (see
 * raw_article.ts); this wrapper just adds a sticky top bar so a shared
 * link can navigate back to the rest of the site.
 *
 * The wrapper does NOT use the standard shell — its layout (sticky 48px
 * bar + full-bleed iframe) is intentionally different from the rest of
 * the site, matching the static build verbatim.
 *
 * Retracted articles return 410 Gone with a styled chrome page instead.
 */

import type { Env, Zone } from "../types";
import { getArticleByZoneSlug } from "../db/queries";
import { escape } from "../util/html";
import { CSP_POLICY } from "../templates/shell";
import { HttpError } from "../types";
import { renderRetracted } from "./error";
import { getLocale } from "../util/locale";
import { t } from "../i18n";

export async function renderArticleChrome(
  req: Request,
  env: Env,
  zone: Zone,
  slug: string,
): Promise<Response> {
  const locale = getLocale(req);
  const row = await getArticleByZoneSlug(env.DB, zone, slug);
  if (!row) {
    throw new HttpError(404, "not_found", `No article at /${zone}/${slug}/`);
  }
  if (row.retracted_at) {
    return renderRetracted(row, locale);
  }
  const zoneLabel = t(locale, `zone.${zone}.title`);

  const title = row.title || slug;
  const language = row.language;
  const verifyHref = `/verify/${row.uuid}`;
  const articleHref = `/${zone}/${slug}/article`;

  const html = `<!doctype html>
<html lang="${escape(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)} — pai.ink</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<style>
  html, body { height: 100%; overflow: hidden; }
  .pai-topbar {
    position: fixed; top: 0; left: 0; right: 0; height: 48px;
    background: rgba(243, 235, 213, 0.92);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--hairline);
    display: flex; align-items: center; gap: 16px;
    padding: 0 22px; z-index: 100;
    font-family: var(--sans); font-size: 14px;
  }
  .pai-topbar .brand {
    font-family: var(--serif); font-size: 18px; font-weight: 600;
    font-style: italic; letter-spacing: -0.01em;
  }
  .pai-topbar a { color: var(--fg); text-decoration: none; }
  .pai-topbar a:hover { text-decoration: underline; }
  .pai-topbar .sep { color: var(--muted); opacity: 0.6; }
  .pai-topbar .title {
    color: var(--muted); margin-left: auto; max-width: 50%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--serif);
  }
  iframe {
    position: fixed; top: 48px; left: 0; right: 0; bottom: 0;
    width: 100%; height: calc(100% - 48px);
    border: 0; display: block; background: var(--bg);
  }
  @media (prefers-color-scheme: dark) {
    .pai-topbar { background: rgba(20, 19, 15, 0.88); }
  }
</style>
</head>
<body>
<nav class="pai-topbar" aria-label="pai.ink site navigation">
  <a class="brand" href="/">pai.ink</a>
  <span class="sep" aria-hidden="true">·</span>
  <a href="/${zone}/">${escape(zoneLabel)}</a>
  <span class="sep" aria-hidden="true">·</span>
  <a href="${verifyHref}">${escape(t(locale, "article.details"))}</a>
  <span class="title" title="${escape(title)}">${escape(title)}</span>
</nav>
<iframe src="${articleHref}" title="${escape(title)}" loading="eager" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>
<script>
(function () {
  if (!window.matchMedia('(pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('div');
  c.className = 'cursor';
  document.body.appendChild(c);
  let x = 0, y = 0, raf = 0;
  window.addEventListener('mousemove', function (e) {
    x = e.clientX; y = e.clientY;
    if (!raf) raf = requestAnimationFrame(function () {
      c.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) translate(-50%,-50%)';
      raf = 0;
    });
  }, { passive: true });
  document.addEventListener('mouseleave', function () { c.classList.add('hidden'); });
  document.addEventListener('mouseenter', function () { c.classList.remove('hidden'); });
  const sel = 'a, button, summary, input, textarea, label, [role="button"], [data-clickable]';
  document.addEventListener('mouseover', function (e) {
    if (e.target && e.target.closest && e.target.closest(sel)) c.classList.add('hovering');
  });
  document.addEventListener('mouseout', function (e) {
    if (e.target && e.target.closest && e.target.closest(sel)) c.classList.remove('hovering');
  });
})();
</script>
</body>
</html>
`;

  // CSP differs from the shell — this page legitimately frames another
  // same-origin URL, so we explicitly allow frame-src 'self'. style-src
  // also needs 'unsafe-inline' for the <style> block above.
  const csp = CSP_POLICY + "; frame-src 'self'";

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "public, max-age=300",
    },
  });
}
