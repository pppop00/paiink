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
import { DEFAULT_LOCALE, t, type Locale } from "../i18n";

/**
 * Content-Security-Policy applied to pai-chrome pages. Matches site/build.py:70
 * verbatim. The Worker also sets this in the response header so non-meta
 * directives (frame-ancestors) take effect.
 */
export const CSP_POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://d3js.org https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self' https://api.paiink.com; " +
  "frame-src https://challenges.cloudflare.com; " +
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
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
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
    <a href="/agreement/v2">${escape(t(locale, "footer.agreement"))}</a> ·
    <a href="https://github.com/pppop00/paiink">${escape(t(locale, "footer.source"))}</a> ·
    <a href="https://github.com/pppop00/paiink/blob/main/LICENSE">${escape(t(locale, "footer.license"))}</a> ·
    <a href="/schemas/ai-audit/v1.json">${escape(t(locale, "footer.schema"))}</a>
  </div>
</footer>
</div>
${CURSOR_SCRIPT}
${LOGOUT_SCRIPT}
${LANG_TOGGLE_SCRIPT}
</body>
</html>
`;
}
