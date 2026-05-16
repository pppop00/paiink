/**
 * Error chrome — 404 / 410 / 5xx pages.
 *
 * Lightweight on purpose; the wrap and footer come from the standard shell
 * so a user landing on a typo'd URL still sees a coherent site.
 *
 * Locale: all renderers accept an optional `locale` so the chrome (heading,
 * back-home link, retraction banner) matches the rest of the site. The
 * caller is the router's error handler, which threads `getLocale(req)`.
 */

import type { ArticleRow } from "../types";
import { HttpError } from "../types";
import { escape } from "../util/html";
import { shell } from "../templates/shell";
import { DEFAULT_LOCALE, t, type Locale } from "../i18n";

interface ErrorPageOpts {
  status: number;
  title: string;
  heading: string;
  message: string;
  locale: Locale;
}

function errorPage(opts: ErrorPageOpts): Response {
  const body = `<section class="page-head">
  <p class="eyebrow">${opts.status}</p>
  <h1>${escape(opts.heading)}</h1>
  <p class="lede">${escape(opts.message)}</p>
</section>
<p style="margin-top:24px"><a href="/">${escape(t(opts.locale, "error.back_home"))}</a></p>`;
  return new Response(
    shell({
      title: `${opts.title} — pai.ink`,
      body,
      locale: opts.locale,
    }),
    {
      status: opts.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

export function renderNotFound(message?: string, locale: Locale = DEFAULT_LOCALE): Response {
  return errorPage({
    status: 404,
    title: t(locale, "error.404.title"),
    heading: t(locale, "error.404.heading"),
    message: message ?? t(locale, "error.404.default"),
    locale,
  });
}

export function renderServerError(message?: string, locale: Locale = DEFAULT_LOCALE): Response {
  return errorPage({
    status: 500,
    title: t(locale, "error.500.title"),
    heading: t(locale, "error.500.heading"),
    message: message ?? t(locale, "error.500.default"),
    locale,
  });
}

export function renderHttpError(err: HttpError, locale: Locale = DEFAULT_LOCALE): Response {
  if (err.status === 404) return renderNotFound(err.detail, locale);
  return errorPage({
    status: err.status,
    title: String(err.status),
    heading: err.code,
    message: err.detail,
    locale,
  });
}

/**
 * 410 Gone for retracted articles. Renders inside the standard shell so
 * the retraction surface still has site nav. Reason text from the D1 row
 * (admin-set via tools/unpublish.py or the future /me retract button).
 */
export function renderRetracted(row: ArticleRow, locale: Locale = DEFAULT_LOCALE): Response {
  const reason = row.retraction_reason || t(locale, "verify.no_reason");
  const body = `<section class="page-head">
  <p class="eyebrow">${escape(t(locale, "error.retracted_eyebrow"))}</p>
  <h1>${escape(row.title || row.slug)}</h1>
</section>
<section class="agreement-archived">
  <p><strong>${escape(t(locale, "error.retracted_strong"))}</strong>${escape(reason)}</p>
  <p>${t(locale, "error.retracted_manifest_note", { uuid: row.uuid })}</p>
</section>`;
  return new Response(
    shell({
      title: t(locale, "error.retracted_title"),
      body,
      locale,
    }),
    {
      status: 410,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
