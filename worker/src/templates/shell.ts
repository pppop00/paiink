/**
 * Page chrome ported from site/build.py:_shell().
 *
 * Output must remain byte-comparable enough that Phase A swap is invisible
 * to users: same masthead, same nav links, same footer, same CSP meta, same
 * cursor script. The only intentional difference is the `base` argument is
 * dropped — every link is rooted at `/` because the Worker serves from a
 * single origin instead of a static file tree where relative paths matter.
 */

import { escape } from "../util/html";

/**
 * Content-Security-Policy applied to pai-chrome pages. Matches site/build.py:70
 * verbatim. The Worker also sets this in the response header so non-meta
 * directives (frame-ancestors) take effect.
 */
export const CSP_POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://d3js.org; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self' https://api.paiink.com; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'self'";

export interface ShellOptions {
  title: string;
  body: string;
  /** Language attribute on <html>. Defaults to zh-CN to match the static site. */
  language?: string;
  /** Which nav item gets aria-current="page". Optional. */
  active?: "finance" | "web3" | "submit" | null;
  /** Extra <head> content (e.g. canonical link). Optional. */
  extraHead?: string;
}

/**
 * Cursor enhancement script — pointer:fine + reduce-motion safe. Lifted
 * verbatim from site/build.py:223. Kept inline because the CSP allows
 * `'unsafe-inline'` for script-src and a separate file would just add a
 * round trip.
 */
const CURSOR_SCRIPT = `<script>
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
</script>`;

function navLink(href: string, label: string, key: string, active?: string | null): string {
  const attr = active === key ? ' aria-current="page"' : "";
  return `<a href="${href}"${attr}>${label}</a>`;
}

export function shell(opts: ShellOptions): string {
  const language = opts.language ?? "zh-CN";
  const active = opts.active ?? null;
  const extraHead = opts.extraHead ?? "";

  return `<!doctype html>
<html lang="${escape(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${escape(CSP_POLICY)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escape(opts.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
${extraHead}
</head>
<body>
<div class="wrap">
<header class="masthead">
  <div class="brand"><a href="/">pai.ink</a></div>
  <nav>
    ${navLink("/finance/", "金融", "finance", active)}
    ${navLink("/web3/", "Web3", "web3", active)}
    ${navLink("/submit", "投稿 / Submit", "submit", active)}
  </nav>
</header>
${opts.body}
<footer class="site">
  <div><a href="/">pai.ink</a> · AI 写的，值得读的</div>
  <div>
    <a href="/about">关于</a> ·
    <a href="/submit">投稿 / Submit</a> ·
    <a href="/agreement/v2">投稿协议 / Agreement</a> ·
    <a href="https://github.com/pppop00/paiink">源代码 / Source</a> ·
    <a href="https://github.com/pppop00/paiink/blob/main/LICENSE">Apache 2.0</a> ·
    <a href="/schemas/ai-audit/v1.json">Schema</a>
  </div>
</footer>
</div>
${CURSOR_SCRIPT}
</body>
</html>
`;
}
