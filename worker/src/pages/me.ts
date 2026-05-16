/**
 * GET /me — the logged-in user's dashboard.
 *
 * Four sections:
 *   1. Header — display name, handle, email, logout.
 *   2. My articles — newest first, retract button on each live one.
 *   3. 收藏 / Likes — articles the user has hearted, newest-like-first.
 *      Added in Phase C; doubles as a bookmarks list.
 *   4. API tokens — list + inline create form. New plaintext is shown
 *      ONCE in a green banner; the server never persists it.
 *
 * Layout uses .wrap--wide and the .me-head / .me-section / .me-articles /
 * .tokens / .token-banner styles. Router is responsible for redirecting
 * unauthenticated visitors to /login — by the time renderMe runs `user`
 * is guaranteed authed.
 *
 * Locale: all chrome strings + the inline JS labels (revoke confirmation,
 * retract prompt, etc.) are populated from the i18n catalog before the
 * script is serialized. We deliberately interpolate the strings server-side
 * because the JS has no access to t().
 */
import type { Env, ArticleRow } from "../types";
import type { AuthedUser } from "../util/auth_middleware";
import {
  listArticlesByUserId,
  listApiTokens,
  listArticlesLikedByUser,
  type ApiTokenSafe,
} from "../db/queries";
import { shell } from "../templates/shell";
import { escape, displayDate } from "../util/html";
import { getLocale } from "../util/locale";
import { t, type Locale } from "../i18n";
import { articleRow } from "./_article_row";

function articleLi(a: ArticleRow, locale: Locale): string {
  const href = `/${a.zone}/${a.slug}/`;
  const title = escape(a.title || a.slug);
  const zone = escape(a.zone);
  const date = displayDate(a.slug, a.finished_at || a.published_at);
  const retracted = a.retracted_at !== null && a.retracted_at !== undefined;
  const meta = retracted
    ? `${zone} · ${escape(date)} · <span class="badge">${escape(t(locale, "me.badge_retracted"))}</span>`
    : `${zone} · ${escape(date)}`;
  const detailsLabel = escape(t(locale, "me.details"));
  const retractLabel = escape(t(locale, "me.retract"));
  const action = retracted
    ? `<a class="btn btn--ghost btn--sm" href="/verify/${escape(a.uuid)}">${detailsLabel}</a>`
    : `<a class="btn btn--ghost btn--sm" href="/verify/${escape(a.uuid)}">${detailsLabel}</a>
       <button type="button" class="btn btn--danger btn--sm retract-btn" data-uuid="${escape(a.uuid)}">${retractLabel}</button>`;
  return `<li>
    <div class="title"><a href="${href}">${title}</a><p class="meta" style="font-size:13px;color:var(--muted);margin:4px 0 0">${meta}</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${action}</div>
  </li>`;
}

function tokenLi(tk: ApiTokenSafe, locale: Locale): string {
  const created = displayDate(null, tk.created_at);
  const lastUsed = tk.last_used_at ? displayDate(null, tk.last_used_at) : "—";
  const revoked = tk.revoked_at !== null;
  const nameCell = revoked
    ? `<span class="name revoked">${escape(tk.name)}</span>`
    : `<span class="name">${escape(tk.name)}</span>`;
  const action = revoked
    ? `<span class="badge">${escape(t(locale, "me.badge_revoked"))}</span>`
    : `<button type="button" class="btn btn--danger btn--sm revoke-btn" data-token-id="${tk.id}">${escape(t(locale, "me.token_revoke"))}</button>`;
  const lastUsedSuffix = tk.last_used_at
    ? ` · ${escape(t(locale, "me.last_used"))} ${escape(lastUsed)}`
    : "";
  return `<li>
    <code class="prefix">${escape(tk.prefix)}…</code>
    ${nameCell}
    <span class="when">${escape(created)}${lastUsedSuffix}</span>
    ${action}
  </li>`;
}

function jsonString(s: string): string {
  // For embedding a localized string into the inline <script> as a JS
  // string literal. JSON.stringify handles quoting/escaping correctly even
  // for HTML-unsafe characters because the script body is then HTML-escape
  // via the </script> rule below (we strip any </script> just in case).
  return JSON.stringify(s).replace(/<\//g, "<\\/");
}

function meScript(locale: Locale): string {
  const L = {
    tokenNameRequired: jsonString(t(locale, "me.token_name_required")),
    tokenRevokeConfirm: jsonString(t(locale, "me.token_revoke_confirm")),
    retractConfirm: jsonString(t(locale, "me.articles_hint_retract_confirm")),
    retractReasonPrompt: jsonString(t(locale, "me.retract_reason_prompt")),
    retractReasonEmpty: jsonString(t(locale, "me.retract_reason_empty")),
    retractFailed: jsonString(t(locale, "me.retract_failed")),
    badgeRevoked: jsonString(t(locale, "me.badge_revoked")),
    tokenRevokeLabel: jsonString(t(locale, "me.token_revoke")),
    tokenNone: jsonString(t(locale, "me.token_none")),
    lastUsed: jsonString(t(locale, "me.last_used")),
  };
  return `<script>
(function () {
  var L = {
    tokenNameRequired: ${L.tokenNameRequired},
    tokenRevokeConfirm: ${L.tokenRevokeConfirm},
    retractConfirm: ${L.retractConfirm},
    retractReasonPrompt: ${L.retractReasonPrompt},
    retractReasonEmpty: ${L.retractReasonEmpty},
    retractFailed: ${L.retractFailed},
    badgeRevoked: ${L.badgeRevoked},
    tokenRevokeLabel: ${L.tokenRevokeLabel},
    tokenNone: ${L.tokenNone},
    lastUsed: ${L.lastUsed}
  };

  function jsonFetch(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ---------- token: create ----------
  var createForm = document.getElementById('create-token-form');
  var newDisplay = document.getElementById('new-token-display');
  var newPlaintext = document.getElementById('new-token-plaintext');
  var tokensList = document.getElementById('tokens-list');
  var tokenError = document.getElementById('token-error');

  function showTokenError(msg) {
    if (!tokenError) return;
    tokenError.textContent = msg;
    tokenError.hidden = false;
  }
  function hideTokenError() {
    if (tokenError) tokenError.hidden = true;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  function renderTokens(tokens) {
    if (!tokensList) return;
    if (!tokens || tokens.length === 0) {
      tokensList.innerHTML = '<li><span class="when" style="opacity:0.7">' + escapeHtml(L.tokenNone) + '</span></li>';
      return;
    }
    var html = '';
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var revoked = t.revoked_at != null;
      var nameCell = revoked
        ? '<span class="name revoked">' + escapeHtml(t.name || '') + '</span>'
        : '<span class="name">' + escapeHtml(t.name || '') + '</span>';
      var actionHtml = revoked
        ? '<span class="badge">' + escapeHtml(L.badgeRevoked) + '</span>'
        : '<button type="button" class="btn btn--danger btn--sm revoke-btn" data-token-id="' + t.id + '">' + escapeHtml(L.tokenRevokeLabel) + '</button>';
      var lastUsed = t.last_used_at ? ' · ' + escapeHtml(L.lastUsed) + ' ' + fmtDate(t.last_used_at) : '';
      html += '<li>' +
        '<code class="prefix">' + escapeHtml(t.prefix || '') + '…</code>' +
        nameCell +
        '<span class="when">' + escapeHtml(fmtDate(t.created_at)) + lastUsed + '</span>' +
        actionHtml +
      '</li>';
    }
    tokensList.innerHTML = html;
    bindRevokeButtons();
  }

  function refreshTokens() {
    return jsonFetch('/api/me/tokens', { method: 'GET' }).then(function (r) {
      if (r.ok && r.body && r.body.tokens) renderTokens(r.body.tokens);
    });
  }

  if (createForm) {
    createForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideTokenError();
      var fd = new FormData(createForm);
      var body = { name: (fd.get('name') || '').toString().trim() };
      if (!body.name) {
        showTokenError(L.tokenNameRequired);
        return;
      }
      jsonFetch('/api/me/tokens', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
        if (r.ok && r.body && r.body.plaintext) {
          if (newDisplay && newPlaintext) {
            newPlaintext.textContent = r.body.plaintext;
            newDisplay.hidden = false;
            newDisplay.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          createForm.reset();
          refreshTokens();
        } else {
          var msg = r.body && (r.body.error + ': ' + (r.body.detail || ''));
          showTokenError(msg || ('HTTP ' + r.status));
        }
      });
    });
  }

  // ---------- token: revoke ----------
  function bindRevokeButtons() {
    var buttons = document.querySelectorAll('.revoke-btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].onclick = onRevokeClick;
    }
  }
  function onRevokeClick(e) {
    var id = e.currentTarget.getAttribute('data-token-id');
    if (!id) return;
    if (!window.confirm(L.tokenRevokeConfirm)) return;
    jsonFetch('/api/me/tokens/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
      if (r.ok) refreshTokens();
      else showTokenError((r.body && r.body.detail) || ('HTTP ' + r.status));
    });
  }
  bindRevokeButtons();

  // ---------- article: retract ----------
  function bindRetractButtons() {
    var buttons = document.querySelectorAll('.retract-btn');
    for (var i = 0; i < buttons.length; i++) buttons[i].onclick = onRetractClick;
  }
  function onRetractClick(e) {
    var uuid = e.currentTarget.getAttribute('data-uuid');
    if (!uuid) return;
    if (!window.confirm(L.retractConfirm)) return;
    var reason = window.prompt(L.retractReasonPrompt, '');
    if (reason == null) return;
    reason = String(reason).trim();
    if (!reason) { window.alert(L.retractReasonEmpty); return; }
    jsonFetch('/api/me/articles/' + encodeURIComponent(uuid) + '/retract', {
      method: 'POST',
      body: JSON.stringify({ reason: reason })
    }).then(function (r) {
      if (r.ok) window.location.reload();
      else window.alert(L.retractFailed + ((r.body && r.body.detail) || ('HTTP ' + r.status)));
    });
  }
  bindRetractButtons();
})();
</script>`;
}

export async function renderMe(
  req: Request,
  env: Env,
  user: AuthedUser,
): Promise<Response> {
  const locale = getLocale(req);
  const [articles, tokens, liked] = await Promise.all([
    listArticlesByUserId(env.DB, user.id),
    listApiTokens(env.DB, user.id),
    listArticlesLikedByUser(env.DB, user.id, { limit: 50 }),
  ]);

  const liveCount = articles.filter((a) => !a.retracted_at).length;

  const articlesHtml = articles.length === 0
    ? `<p class="empty">${escape(t(locale, "me.no_articles"))} <a href="/submit">${escape(t(locale, "me.no_articles_link"))}</a></p>`
    : `<ul class="me-articles">${articles.map((a) => articleLi(a, locale)).join("\n")}</ul>`;

  // The "收藏" section uses the standard article-row layout (heart
  // visible + filled) rather than the dense me-articles list. Every
  // entry here is something the user has liked, so liked=true for all.
  const likedHtml = liked.length === 0
    ? `<p class="empty">${escape(t(locale, "me.no_likes"))}</p>`
    : `<ul class="articles">${liked
        .map(
          (a) =>
            `<li>${articleRow(a, locale, {
              liked: true,
              logged_in: true,
            })}</li>`,
        )
        .join("\n")}</ul>`;

  const tokensHtml = tokens.length === 0
    ? `<li><span class="when" style="opacity:0.7">${escape(t(locale, "me.token_none"))}</span></li>`
    : tokens.map((tk) => tokenLi(tk, locale)).join("\n");

  const body = `<section class="me-head">
  <div class="id">
    <p class="eyebrow">${escape(t(locale, "me.eyebrow"))}</p>
    <h1>${escape(user.display_name)}</h1>
    <p class="id-meta"><a href="/u/${escape(user.handle)}">@${escape(user.handle)}</a> · ${escape(user.email)} · ${escape(t(locale, "me.live_count", { n: liveCount }))}</p>
  </div>
  <div>
    <button type="button" class="btn btn--ghost" data-logout>${escape(t(locale, "nav.logout"))}</button>
  </div>
</section>

<section class="me-section">
  <div class="head">
    <h2>${escape(t(locale, "me.my_articles"))}</h2>
    <p class="hint">${escape(t(locale, "me.article_hint"))}</p>
  </div>
  ${articlesHtml}
</section>

<section class="me-section">
  <div class="head">
    <h2>${escape(t(locale, "me.likes"))}</h2>
  </div>
  ${likedHtml}
</section>

<section class="me-section">
  <div class="head">
    <h2>${escape(t(locale, "me.api_tokens"))}</h2>
    <p class="hint">${escape(t(locale, "me.token_optional"))}</p>
  </div>

  <form id="create-token-form" class="token-create">
    <input type="text" name="name" required maxlength="100" placeholder="${escape(t(locale, "me.token_placeholder"))}">
    <button type="submit" class="btn btn--primary">${escape(t(locale, "me.token_create_label"))}</button>
  </form>
  <p class="form-error" id="token-error" hidden></p>

  <div id="new-token-display" class="token-banner" hidden>
    <strong>${escape(t(locale, "me.token_shown_once"))}</strong>
    <code id="new-token-plaintext"></code>
    <p style="margin:6px 0 0;font-size:13px;color:var(--muted)">${escape(t(locale, "me.token_shown_once_hint"))}</p>
  </div>

  <ul id="tokens-list" class="tokens">${tokensHtml}</ul>
</section>

${meScript(locale)}`;

  return new Response(
    shell({
      title: `${user.display_name} — pai.ink`,
      body,
      active: "me",
      user,
      wide: true,
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
