/**
 * Error chrome — 404 / 410 / 5xx pages.
 *
 * Lightweight on purpose; the wrap and footer come from the standard shell
 * so a user landing on a typo'd URL still sees a coherent site.
 */

import type { ArticleRow } from "../types";
import { HttpError } from "../types";
import { escape } from "../util/html";
import { shell } from "../templates/shell";

interface ErrorPageOpts {
  status: number;
  title: string;
  heading: string;
  message: string;
}

function errorPage(opts: ErrorPageOpts): Response {
  const body = `<section class="page-head">
  <p class="eyebrow">${opts.status}</p>
  <h1>${escape(opts.heading)}</h1>
  <p class="lede">${escape(opts.message)}</p>
</section>
<p style="margin-top:24px"><a href="/">← 回首页</a></p>`;
  return new Response(
    shell({
      title: `${opts.title} — pai.ink`,
      body,
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

export function renderNotFound(message = "页面不存在 / Page not found"): Response {
  return errorPage({
    status: 404,
    title: "404",
    heading: "找不到这个页面",
    message,
  });
}

export function renderServerError(message = "内部错误 / Internal error"): Response {
  return errorPage({
    status: 500,
    title: "500",
    heading: "服务出了点问题",
    message,
  });
}

export function renderHttpError(err: HttpError): Response {
  if (err.status === 404) return renderNotFound(err.detail);
  return errorPage({
    status: err.status,
    title: String(err.status),
    heading: err.code,
    message: err.detail,
  });
}

/**
 * 410 Gone for retracted articles. Renders inside the standard shell so
 * the retraction surface still has site nav. Reason text from the D1 row
 * (admin-set via tools/unpublish.py or the future /me retract button).
 */
export function renderRetracted(row: ArticleRow): Response {
  const reason = row.retraction_reason || "(未填写原因)";
  const body = `<section class="page-head">
  <p class="eyebrow">410 · 撤稿 / Retracted</p>
  <h1>${escape(row.title || row.slug)}</h1>
</section>
<section class="agreement-archived">
  <p><strong>本文已撤稿。</strong>${escape(reason)}</p>
  <p>原始 manifest 仍可于 <a href="/verify/${escape(row.uuid)}">详情页</a> 查询，但文章正文不再提供。</p>
</section>`;
  return new Response(
    shell({
      title: `撤稿 / Retracted — pai.ink`,
      body,
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
