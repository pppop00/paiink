/**
 * Page chrome ported from site/build.py:_shell().
 *
 * Output must remain byte-comparable enough that Phase A swap is invisible
 * to users: same masthead, same nav links, same footer, same CSP meta, same
 * cursor script. The only intentional difference is the `base` argument is
 * dropped — every link is rooted at `/` because the Worker serves from a
 * single origin instead of a static file tree where relative paths matter.
 *
 * Locale: nav + footer labels go through `t(locale, ...)`. Callers thread
 * the locale derived from `getLocale(req)`; if absent the shell falls back
 * to DEFAULT_LOCALE so the chrome never crashes due to a missing arg.
 */

import { escape } from "../util/html";
import type { AuthedUser } from "../util/auth_middleware";
import { ASSET_PATHS } from "../asset-manifest";
import { DEFAULT_LOCALE, t, type Locale } from "../i18n";
import { analyticsBeacon } from "../analytics";

/**
 * Content-Security-Policy applied to pai-chrome pages. Matches site/build.py:70
 * verbatim. The Worker also sets this in the response header so non-meta
 * directives (frame-ancestors) take effect.
 */
export const CSP_POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://d3js.org https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self' https://api.paiink.com https://cloudflareinsights.com; " +
  "frame-src 'self' https://challenges.cloudflare.com; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'self'";

export interface ShellOptions {
  title: string;
  body: string;
  /** UI locale for nav + footer + page chrome. Defaults to DEFAULT_LOCALE. */
  locale?: Locale;
  /** Language attribute on <html>. If absent, derived from locale. */
  language?: string;
  /** Which nav item gets aria-current="page". Optional. */
  active?: "finance" | "web3" | "submit" | "me" | "login" | "signup" | null;
  /** Extra <head> content (e.g. canonical link). Optional. */
  extraHead?: string;
  /**
   * Currently-logged-in user, or null/undefined for anonymous visitors.
   * Drives the auth-aware nav links in the masthead. Phase B+ only.
   */
  user?: AuthedUser | null;
  /** Use the wider container (1080px) for landing/dashboard/profile/zone pages. */
  wide?: boolean;
  /** Use the narrow centered container (460px) for auth cards / focused forms. */
  narrow?: boolean;
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

function navActions(
  user: AuthedUser | null | undefined,
  active: string | null,
  locale: Locale,
): string {
  // Right side of masthead: language toggle + submission + auth utilities.
  const langSwitcher = renderLangSwitcher(locale);
  const submit = navLink("/submit", t(locale, "nav.submit"), "submit", active);
  if (user) {
    return (
      langSwitcher +
      `<span class="nav-sep">·</span>` +
      submit +
      `<span class="nav-sep">·</span>` +
      navLink("/me", t(locale, "nav.me"), "me", active) +
      `<span class="nav-sep">·</span>` +
      `<button type="button" data-logout class="nav-logout-btn">${t(locale, "nav.logout")}</button>`
    );
  }
  return (
    langSwitcher +
    `<span class="nav-sep">·</span>` +
    submit +
    `<span class="nav-sep">·</span>` +
    navLink("/login", t(locale, "nav.login"), "login", active) +
    `<span class="nav-sep">·</span>` +
    navLink("/signup", t(locale, "nav.signup"), "signup", active)
  );
}

function renderLangSwitcher(locale: Locale): string {
  const zhActive = locale === "zh-CN" ? " active" : "";
  const enActive = locale === "en" ? " active" : "";
  return (
    `<span class="nav-lang">` +
    `<button type="button" data-lang="zh-CN" class="lang-btn${zhActive}" aria-label="切换到中文">${t(locale, "nav.toggle_zh")}</button>` +
    `<span class="nav-sep">·</span>` +
    `<button type="button" data-lang="en" class="lang-btn${enActive}" aria-label="Switch to English">${t(locale, "nav.toggle_en")}</button>` +
    `</span>`
  );
}

const LOGOUT_SCRIPT = `<script>
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest && e.target.closest('[data-logout]');
  if (!btn) return;
  e.preventDefault();
  fetch('/api/logout', { method: 'POST', credentials: 'include', headers: { 'Origin': window.location.origin } })
    .catch(function () {})
    .then(function () { window.location.assign('/'); });
});
</script>`;

const LANG_TOGGLE_SCRIPT = `<script>
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest && e.target.closest('[data-lang]');
  if (!btn) return;
  e.preventDefault();
  var lang = btn.getAttribute('data-lang');
  var oneYear = 31536000;
  document.cookie = 'paiink_lang=' + lang + '; Max-Age=' + oneYear + '; Path=/; SameSite=Lax';
  window.location.reload();
});
</script>`;

/**
 * Like-button handler (Phase C). Listens at the document level so it
 * works across every page that renders an [data-like-btn] (landing,
 * zone, profile, /me, /verify). The button carries data-uuid + the
 * current data-liked state; we POST or DELETE accordingly and update
 * the DOM optimistically, rolling back on failure.
 *
 * The endpoint is cookie-only on the server side (no Bearer tokens —
 * see api/likes.ts) so credentials:'same-origin' is what matters.
 */
const LIKE_SCRIPT = `<script>
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest && e.target.closest('[data-like-btn]');
  if (!btn) return;
  e.preventDefault();
  if (btn.dataset.likeBusy === '1') return;
  var uuid = btn.getAttribute('data-uuid');
  if (!uuid) return;
  var wasLiked = btn.getAttribute('data-liked') === '1';
  var nextLiked = !wasLiked;
  var countEl = btn.querySelector('.count');
  var oldCount = countEl ? parseInt(countEl.textContent || '0', 10) || 0 : 0;
  var optimisticCount = Math.max(oldCount + (nextLiked ? 1 : -1), 0);

  // Optimistic flip
  btn.dataset.likeBusy = '1';
  btn.setAttribute('data-liked', nextLiked ? '1' : '0');
  btn.setAttribute('aria-pressed', nextLiked ? 'true' : 'false');
  btn.classList.toggle('liked', nextLiked);
  // Swap heart SVG without rebuilding the whole button
  var svg = btn.querySelector('svg.heart path');
  if (svg) {
    if (nextLiked) {
      svg.setAttribute('fill', 'currentColor');
      svg.removeAttribute('stroke');
      svg.removeAttribute('stroke-width');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.4');
    }
  }
  if (countEl) countEl.textContent = String(optimisticCount);

  var method = nextLiked ? 'POST' : 'DELETE';
  fetch('/api/articles/' + encodeURIComponent(uuid) + '/like', {
    method: method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Origin': window.location.origin }
  }).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (j) {
      return { ok: r.ok, status: r.status, body: j };
    });
  }).then(function (r) {
    btn.dataset.likeBusy = '';
    if (r.ok && r.body && typeof r.body.like_count === 'number') {
      // Server is authoritative.
      if (countEl) countEl.textContent = String(Math.max(r.body.like_count, 0));
      return;
    }
    if (r.status === 401 || r.status === 403) {
      // Not logged in or token-auth: bounce to /login with a next= back here.
      window.location.assign('/login?next=' + encodeURIComponent(window.location.pathname));
      return;
    }
    // Roll back optimistic flip
    btn.setAttribute('data-liked', wasLiked ? '1' : '0');
    btn.setAttribute('aria-pressed', wasLiked ? 'true' : 'false');
    btn.classList.toggle('liked', wasLiked);
    if (countEl) countEl.textContent = String(oldCount);
    if (svg) {
      if (wasLiked) {
        svg.setAttribute('fill', 'currentColor');
        svg.removeAttribute('stroke');
        svg.removeAttribute('stroke-width');
      } else {
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.4');
      }
    }
  }).catch(function () {
    btn.dataset.likeBusy = '';
    // Roll back on network error
    btn.setAttribute('data-liked', wasLiked ? '1' : '0');
    btn.setAttribute('aria-pressed', wasLiked ? 'true' : 'false');
    btn.classList.toggle('liked', wasLiked);
    if (countEl) countEl.textContent = String(oldCount);
  });
});
</script>`;

export function shell(opts: ShellOptions): string {
  const locale: Locale = opts.locale ?? DEFAULT_LOCALE;
  const language = opts.language ?? locale;
  const active = opts.active ?? null;
  const extraHead = opts.extraHead ?? "";
  const user = opts.user ?? null;
  const wrapClass = opts.narrow
    ? "wrap wrap--narrow"
    : opts.wide
    ? "wrap wrap--wide"
    : "wrap";

  return `<!doctype html>
<html lang="${escape(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${escape(CSP_POLICY)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escape(opts.title)}</title>
<link rel="icon" href="${ASSET_PATHS["favicon.svg"]}" type="image/svg+xml">
<link rel="stylesheet" href="${ASSET_PATHS["style.css"]}">
${extraHead}
</head>
<body>
<div class="${wrapClass}">
<header class="masthead">
  <div class="brand"><a href="/">pai.ink</a></div>
  <nav class="nav-main">
    ${navLink("/finance/", t(locale, "nav.finance"), "finance", active)}
    ${navLink("/web3/", t(locale, "nav.web3"), "web3", active)}
  </nav>
  <nav class="nav-actions">
    ${navActions(user, active, locale)}
  </nav>
</header>
${opts.body}
<footer class="site">
  <div><a href="/">pai.ink</a> · ${escape(t(locale, "footer.tagline"))}</div>
  <div>
    <a href="/about">${escape(t(locale, "footer.about"))}</a> ·
    <a href="/submit">${escape(t(locale, "footer.submit"))}</a> ·
    <a href="/agreement/v3">${escape(t(locale, "footer.agreement"))}</a> ·
    <a href="https://github.com/pppop00/paiink">${escape(t(locale, "footer.source"))}</a> ·
    <a href="https://github.com/pppop00/paiink/blob/main/LICENSE">${escape(t(locale, "footer.license"))}</a> ·
    <a href="/schemas/ai-audit/v1.json">${escape(t(locale, "footer.schema"))}</a>
  </div>
</footer>
</div>
${CURSOR_SCRIPT}
${LOGOUT_SCRIPT}
${LANG_TOGGLE_SCRIPT}
${LIKE_SCRIPT}
${analyticsBeacon()}
</body>
</html>
`;
}
