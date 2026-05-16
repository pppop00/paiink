/**
 * Request router for the paiink Worker.
 *
 * Phase A wires only the routes Phase A needs. Phase B+ adds /signup,
 * /login, /me, /u/<handle>, /api/articles/.../like — those are deliberate
 * 404s for now (see TODO blocks at the bottom).
 *
 * Design notes:
 *   • URL parsed once; handlers receive the parsed pieces, not raw strings
 *   • HttpError caught here; HTML routes get a styled page, API routes JSON
 *   • Page responses set the standard CSP header so frame-ancestors etc.
 *     can't be set via <meta> (works around the meta-tag limitation)
 *   • All static assets (style.css, favicon, /static/*) delegate to
 *     env.ASSETS (Workers Static Assets binding)
 */

import type { Env, Zone } from "./types";
import { HttpError, ZONES } from "./types";

import { renderLanding } from "./pages/landing";
import { renderZone } from "./pages/zone";
import { renderArticleChrome } from "./pages/article";
import { renderRawArticle } from "./pages/raw_article";
import { renderVerify, renderVerifyManifest } from "./pages/verify";
import { renderAgreement } from "./pages/agreement";
import { renderAbout } from "./pages/about";
import { renderSubmitForm } from "./pages/submit_form";
import { renderSignup } from "./pages/signup";
import { renderLogin } from "./pages/login";
import { renderMe } from "./pages/me";
import { renderProfile } from "./pages/profile";
import { renderHttpError, renderNotFound, renderServerError } from "./pages/error";
import { getLocale } from "./util/locale";
import { DEFAULT_LOCALE, type Locale } from "./i18n";

import { handleExport } from "./api/export";
import { handleSubmit } from "./api/submit";
import { handleSignup } from "./api/signup";
import { handleLogin } from "./api/login";
import { handleLogout } from "./api/logout";
import {
  handleCreateToken,
  handleListTokens,
  handleRevokeToken,
} from "./api/tokens";
import { handleRetract } from "./api/retract";
import { handleLike, handleUnlike } from "./api/likes";
import { getCurrentUser } from "./util/auth_middleware";
import { getSchemaBytes } from "./r2";

const ALLOWED_ORIGINS = new Set([
  "https://www.paiink.com",
  "https://paiink.com",
  "https://api.paiink.com",
]);

// Security headers applied to every HTML page response (in addition to the
// <meta http-equiv> CSP inside the page body). frame-ancestors only works
// from a real header, hence the duplication.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function isZone(s: string): s is Zone {
  return (ZONES as readonly string[]).includes(s);
}

export async function route(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const path = url.pathname;

  // CORS preflight — only the API routes care, but answering uniformly
  // is harmless.
  if (method === "OPTIONS") {
    return handleCorsPreflight(req);
  }

  try {
    const resp = await dispatch(req, env, ctx, method, path);
    return applyCommonHeaders(resp, req);
  } catch (err) {
    return handleError(err, req, path, getLocale(req));
  }
}

async function dispatch(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  method: string,
  path: string,
): Promise<Response> {
  // -------- Static assets (Workers Static Assets passthrough) --------
  if (
    path === "/style.css" ||
    path === "/favicon.svg" ||
    path.startsWith("/static/") ||
    path.startsWith("/fonts/")
  ) {
    return env.ASSETS.fetch(req);
  }

  // -------- Schema mirror --------
  if (method === "GET" && path === "/schemas/ai-audit/v1.json") {
    const bytes = await getSchemaBytes(env.R2_CONTENT);
    if (!bytes) throw new HttpError(500, "missing_schema", "schema not in R2");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  // -------- POST /submit and /api/submit --------
  if (method === "POST" && (path === "/submit" || path === "/api/submit")) {
    return handleSubmit(req, env);
  }

  // -------- GET /submit --------
  if (method === "GET" && (path === "/submit" || path === "/submit/")) {
    const user = await getCurrentUser(req, env);
    return renderSubmitForm(req, env, user);
  }

  // -------- GET /about --------
  if (method === "GET" && (path === "/about" || path === "/about/" || path === "/about.html")) {
    return renderAbout(req, env);
  }

  // -------- Auth pages (Phase B) --------
  if (method === "GET" && (path === "/signup" || path === "/signup/")) {
    return renderSignup(req, env);
  }
  if (method === "GET" && (path === "/login" || path === "/login/")) {
    return renderLogin(req, env);
  }
  if (method === "GET" && (path === "/me" || path === "/me/")) {
    const user = await getCurrentUser(req, env);
    if (!user) {
      // Relative Location so the browser resolves against whatever host it
      // arrived from (localhost during dev, www.paiink.com in prod). Using
      // Response.redirect with `new URL("/login", req.url)` produces an
      // absolute URL pointing at the upstream workers.dev hostname under
      // --remote, which breaks local browser flow.
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }
    return renderMe(req, env, user);
  }

  // -------- GET /u/<handle> --------
  const mProfile = /^\/u\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (method === "GET" && mProfile) {
    const viewer = await getCurrentUser(req, env);
    return renderProfile(req, env, mProfile[1] as string, viewer);
  }

  // -------- Auth API (Phase B) --------
  if (method === "POST" && path === "/api/signup") {
    return handleSignup(req, env);
  }
  if (method === "POST" && path === "/api/login") {
    return handleLogin(req, env);
  }
  if (method === "POST" && path === "/api/logout") {
    return handleLogout(req, env);
  }

  // -------- /api/me/tokens --------
  // POST creates, GET lists. Both require an authenticated user (cookie
  // session — Bearer auth doesn't manage its own tokens).
  if (
    (method === "POST" || method === "GET") &&
    (path === "/api/me/tokens" || path === "/api/me/tokens/")
  ) {
    const user = await getCurrentUser(req, env);
    if (!user) {
      throw new HttpError(401, "unauthorized", "log in to manage API tokens");
    }
    return method === "POST"
      ? handleCreateToken(req, env, user)
      : handleListTokens(req, env, user);
  }

  // -------- DELETE /api/me/tokens/<id> --------
  const mTokenId = /^\/api\/me\/tokens\/([0-9]+)\/?$/.exec(path);
  if (method === "DELETE" && mTokenId) {
    const user = await getCurrentUser(req, env);
    if (!user) {
      throw new HttpError(401, "unauthorized", "log in to manage API tokens");
    }
    return handleRevokeToken(req, env, user, mTokenId[1] as string);
  }

  // -------- POST /api/me/articles/<uuid>/retract --------
  const mRetract = /^\/api\/me\/articles\/([A-Za-z0-9-]+)\/retract\/?$/.exec(path);
  if (method === "POST" && mRetract) {
    const user = await getCurrentUser(req, env);
    if (!user) {
      throw new HttpError(401, "unauthorized", "log in to retract articles");
    }
    return handleRetract(req, env, user, mRetract[1] as string);
  }

  // -------- POST/DELETE /api/articles/<uuid>/like --------
  // Phase C. Auth model is cookie-session-only — we explicitly reject
  // Bearer-token callers with 403 so an agent can't like-spam. The
  // 401 path is for "no auth at all", the 403 path is for "you sent
  // a token but tokens aren't allowed here". See api/likes.ts header.
  const mLike = /^\/api\/articles\/([A-Za-z0-9-]+)\/like\/?$/.exec(path);
  if ((method === "POST" || method === "DELETE") && mLike) {
    const user = await getCurrentUser(req, env);
    if (!user) {
      if (req.headers.get("Authorization")) {
        throw new HttpError(
          403,
          "auth",
          "likes require a logged-in browser session, not an API token",
        );
      }
      throw new HttpError(401, "unauthorized", "log in to like articles");
    }
    const uuid = mLike[1] as string;
    return method === "POST"
      ? handleLike(req, env, user, uuid)
      : handleUnlike(req, env, user, uuid);
  }

  // -------- GET /agreement/v1 | v2 | v3 --------
  // Accept both /agreement/vN and /agreement/vN/ for compat with the
  // static-site URLs that always had a trailing slash. Specific versions
  // that aren't pinned in pages/agreement.ts will 404 there.
  const mAgreement = /^\/agreement\/(v\d+)\/?$/.exec(path);
  if (method === "GET" && mAgreement) {
    return renderAgreement(req, env, mAgreement[1]);
  }

  // -------- GET /verify/<uuid>/export --------
  const mExport = /^\/verify\/([A-Za-z0-9._-]+)\/export\/?$/.exec(path);
  if (method === "GET" && mExport) {
    return handleExport(req, env, mExport[1]);
  }

  // -------- GET /verify/<uuid>/manifest.json --------
  const mManifest = /^\/verify\/([A-Za-z0-9._-]+)\/manifest\.json$/.exec(path);
  if (method === "GET" && mManifest) {
    return renderVerifyManifest(req, env, mManifest[1]);
  }

  // -------- GET /verify/<uuid> (and trailing slash) --------
  const mVerify = /^\/verify\/([A-Za-z0-9._-]+)\/?$/.exec(path);
  if (method === "GET" && mVerify) {
    return renderVerify(req, env, mVerify[1]);
  }

  // -------- GET /<zone>/<slug>/article (raw HTML) --------
  // Match before the chrome route so /<zone>/<slug>/article doesn't get
  // captured as a slug == "article" of some pseudo-article.
  const mRaw = /^\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)\/article\/?$/.exec(path);
  if (method === "GET" && mRaw) {
    const [, zone, slug] = mRaw;
    if (!isZone(zone)) {
      throw new HttpError(404, "unknown_zone", `Unknown zone: ${zone}`);
    }
    return renderRawArticle(req, env, zone, slug);
  }

  // -------- GET /<zone>/<slug>/ (chrome wrapper) --------
  const mArticle = /^\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/.exec(path);
  if (method === "GET" && mArticle) {
    const [, zone, slug] = mArticle;
    if (isZone(zone)) {
      return renderArticleChrome(req, env, zone, slug);
    }
    // Fall through to other GETs — could be a static asset under /static/
    // or a phase-B path. If nothing else matches, 404 below.
  }

  // -------- GET /<zone>/ --------
  const mZone = /^\/([a-z0-9-]+)\/?$/.exec(path);
  if (method === "GET" && mZone) {
    const zone = mZone[1];
    if (isZone(zone)) {
      return renderZone(req, env, zone);
    }
    // unknown top-level: fall through to landing-or-404 logic
  }

  // -------- GET / --------
  if (method === "GET" && (path === "/" || path === "")) {
    return renderLanding(req, env);
  }

  // -------- Phase B+ stubs (Phase A 404s these intentionally) --------
  if (isPhaseBOrLaterRoute(path)) {
    throw new HttpError(404, "phase_not_yet", `Route ${path} ships in a later phase`);
  }

  // Touch ctx so TypeScript's noUnusedParameters doesn't flag it. (ctx is
  // reserved for waitUntil() in handlers that need it; we don't here yet.)
  void ctx;

  throw new HttpError(404, "not_found", `No route for ${method} ${path}`);
}

function isPhaseBOrLaterRoute(path: string): boolean {
  // Phase B (auth, sessions, tokens, retract) and Phase C (likes) are
  // shipped — those paths now have live handlers above. Remaining
  // stubs are skills directory and Phase E (feed, sitemap).
  return (
    path === "/skills" ||
    path.startsWith("/skills/") ||
    path === "/feed.xml" ||
    path === "/sitemap.xml"
  );
}

function applyCommonHeaders(resp: Response, _req: Request): Response {
  const ct = resp.headers.get("content-type") || "";
  // Only add the security/CSP envelope to HTML pages — JSON / tar.gz / R2
  // bytes have their own headers and we don't want to clobber them.
  const isHtml = ct.startsWith("text/html");
  if (!isHtml) return resp;

  // Clone so we can mutate headers without mutating frozen responses.
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  // Only set the response-header CSP if the page didn't set one already
  // (article.ts sets a custom one with frame-src 'self'). The default
  // matches CSP_POLICY in shell.ts.
  if (!headers.has("content-security-policy")) {
    // Phase B note: script-src + frame-src include
    // https://challenges.cloudflare.com so the Turnstile widget can load
    // on /signup. Keep in sync with CSP_POLICY in templates/shell.ts.
    headers.set(
      "content-security-policy",
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://d3js.org https://challenges.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "img-src 'self' data:; " +
        "font-src 'self' data: https://fonts.gstatic.com; " +
        "connect-src 'self' https://api.paiink.com; " +
        "frame-src 'self' https://challenges.cloudflare.com; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "frame-ancestors 'self'",
    );
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function handleCorsPreflight(req: Request): Response {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://www.paiink.com";
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": allowed,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

function handleError(
  err: unknown,
  _req: Request,
  path: string,
  locale: Locale = DEFAULT_LOCALE,
): Response {
  // Decide HTML vs JSON by path shape — anything under /api/ or that
  // returns binary explicitly should get JSON; everything else HTML.
  const wantsJson = path.startsWith("/api/") || path.startsWith("/verify/") && path.endsWith("/export");

  if (err instanceof HttpError) {
    if (wantsJson) {
      return new Response(
        JSON.stringify({ error: err.code, detail: err.detail }),
        {
          status: err.status,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (err.status === 404) {
      return renderNotFound(err.detail, locale);
    }
    return renderHttpError(err, locale);
  }

  // Unknown / unexpected error: log and 500.
  console.error("router unhandled:", err);
  if (wantsJson) {
    return new Response(
      JSON.stringify({ error: "internal_error", detail: "see worker logs" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  return renderServerError(undefined, locale);
}
