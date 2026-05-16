/**
 * GET /login — email/password login form.
 *
 * No Turnstile (we accept the credential-stuffing risk for MVP; Phase C
 * can add it back if abuse appears). On 200 from /api/login the session
 * cookie is already set; we just redirect to /me. Logged-in visitors
 * get a 302 to /me immediately so the back button doesn't strand them.
 */
import type { Env } from "../types";
import { shell } from "../templates/shell";
import { escape } from "../util/html";
import { getCurrentUser } from "../util/auth_middleware";
import { getLocale } from "../util/locale";
import { t, type Locale } from "../i18n";

function formScript(locale: Locale): string {
  const loggingIn = JSON.stringify(t(locale, "auth.login.logging_in"));
  return `<script>
(function () {
  var form = document.getElementById('login-form');
  var errEl = document.getElementById('login-error');
  var submitBtn = document.getElementById('login-submit');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.hidden = true;
    submitBtn.disabled = true;
    var prevText = submitBtn.textContent;
    submitBtn.textContent = ${loggingIn};
    var fd = new FormData(form);
    var body = {};
    fd.forEach(function (value, key) { body[key] = value; });
    fetch('/api/login', {
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

export async function renderLogin(req: Request, env: Env): Promise<Response> {
  const locale = getLocale(req);
  const user = await getCurrentUser(req, env);
  if (user) {
    return new Response(null, { status: 302, headers: { Location: "/me" } });
  }

  const body = `<section class="auth-page">
  <div class="auth-card">
    <p class="eyebrow">${escape(t(locale, "auth.login.eyebrow"))}</p>
    <h1>${escape(t(locale, "auth.login.title"))}</h1>
    <p class="lede">${escape(t(locale, "auth.login.lede"))}</p>

    <form id="login-form" class="auth-form" autocomplete="on">
      <label>${escape(t(locale, "auth.email"))}
        <input type="email" name="email" required maxlength="254" autocomplete="email" placeholder="${escape(t(locale, "auth.email_placeholder"))}">
      </label>

      <label>${escape(t(locale, "auth.password"))}
        <input type="password" name="password" required maxlength="256" autocomplete="current-password">
      </label>

      <button type="submit" id="login-submit" class="btn btn--primary">${escape(t(locale, "auth.login.cta"))}</button>
      <p class="form-error" id="login-error" hidden></p>
    </form>

    <p class="alt">${escape(t(locale, "auth.login.no_account"))} <a href="/signup">${escape(t(locale, "auth.login.signup_link"))}</a></p>
  </div>
</section>

${formScript(locale)}`;

  return new Response(
    shell({
      title: t(locale, "auth.login.page_title"),
      body,
      active: "login",
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
