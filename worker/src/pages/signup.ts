/**
 * GET /signup — account creation form.
 *
 * Email + password + display name. Cloudflare Turnstile invisible captcha
 * runs in the browser; its token is bundled into the /api/signup JSON
 * request. On success the API issues an HTTP-only `paiink_sid` cookie and
 * this page redirects the user to /me.
 *
 * Layout: centered .auth-card on a .wrap--narrow page so the form has a
 * focused visual hierarchy instead of stretching across the whole shell.
 * Logged-in visitors get a 302 to /me (no point re-registering).
 */
import type { Env } from "../types";
import { shell } from "../templates/shell";
import { escape } from "../util/html";
import { TURNSTILE_SITE_KEY_DEV } from "../util/turnstile";
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t, type Locale } from "../i18n";

const TURNSTILE_HEAD = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;

function formScript(locale: Locale): string {
  const captchaWait = JSON.stringify(t(locale, "auth.captcha_wait"));
  const creating = JSON.stringify(t(locale, "auth.signup.creating"));
  return `<script>
(function () {
  var turnstileToken = null;
  window.onTurnstile = function (t) { turnstileToken = t; };
  var form = document.getElementById('signup-form');
  var errEl = document.getElementById('signup-error');
  var submitBtn = document.getElementById('signup-submit');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.hidden = true;
    if (!turnstileToken) {
      errEl.textContent = ${captchaWait};
      errEl.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    var prevText = submitBtn.textContent;
    submitBtn.textContent = ${creating};
    var fd = new FormData(form);
    var body = {};
    fd.forEach(function (value, key) { body[key] = value; });
    body.turnstile_token = turnstileToken;
    fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.ok) {
        window.location.href = '/me';
        return null;
      }
      return r.json().catch(function () {
        return { error: 'unknown', detail: 'request failed' };
      }).then(function (j) {
        errEl.textContent = (j.error || 'error') + ': ' + (j.detail || 'unknown');
        errEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = prevText;
        try { if (window.turnstile) window.turnstile.reset(); } catch (_) {}
        turnstileToken = null;
      });
    }).catch(function (err) {
      errEl.textContent = 'network: ' + (err && err.message ? err.message : String(err));
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = prevText;
    });
  });
})();
</script>`;
}

export async function renderSignup(req: Request, env: Env): Promise<Response> {
  const locale = getLocale(req);
  const user = await getCurrentUser(req, env);
  if (user) {
    return new Response(null, { status: 302, headers: { Location: "/me" } });
  }

  const siteKey = escape(env.TURNSTILE_SITE_KEY ?? TURNSTILE_SITE_KEY_DEV);

  const body = `<section class="auth-page">
  <div class="auth-card">
    <p class="eyebrow">${escape(t(locale, "auth.signup.eyebrow"))}</p>
    <h1>${escape(t(locale, "auth.signup.title"))}</h1>

    <form id="signup-form" class="auth-form" autocomplete="off">
      <label>${escape(t(locale, "auth.email"))}
        <input type="email" name="email" required maxlength="254" autocomplete="email" placeholder="${escape(t(locale, "auth.email_placeholder"))}">
      </label>

      <label>${escape(t(locale, "auth.password"))} <span class="req">${escape(t(locale, "auth.password_hint"))}</span>
        <input type="password" name="password" minlength="8" maxlength="256" required autocomplete="new-password">
      </label>

      <label>${escape(t(locale, "auth.display_name"))}
        <input type="text" name="display_name" required maxlength="100" placeholder="${escape(t(locale, "auth.display_name_placeholder"))}">
      </label>

      <div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="onTurnstile" data-theme="auto"></div>

      <button type="submit" id="signup-submit" class="btn btn--primary">${escape(t(locale, "auth.signup.cta"))}</button>
      <p class="form-error" id="signup-error" hidden></p>
    </form>

    <p class="alt">${escape(t(locale, "auth.signup.have_account"))} <a href="/login">${escape(t(locale, "auth.signup.login_link"))}</a></p>
  </div>
</section>

${formScript(locale)}`;

  return new Response(
    shell({
      title: t(locale, "auth.signup.page_title"),
      body,
      active: "signup",
      extraHead: TURNSTILE_HEAD,
      narrow: false,  // .auth-page handles its own centering
      locale,
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
