/**
 * RSS 2.0 feed at /feed.xml.
 *
 * The latest 30 live articles, newest first. We keep it RSS 2.0 (not Atom
 * or RSS+JSON) because that's what every Chinese reader app speaks
 * fluently, and we don't have any Atom-only data to express.
 */

import type { Env } from "../types";
import { listRecentArticles } from "../db/queries";

function rfc822(epochSeconds: number): string {
  // RFC 822 / 2822: "Sun, 06 Nov 1994 08:49:37 GMT"
  return new Date(epochSeconds * 1000).toUTCString();
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function renderFeed(_req: Request, env: Env): Promise<Response> {
  const SITE_URL = env.SITE_URL ?? "https://www.paiink.com";
  const articles = await listRecentArticles(env.DB, { limit: 30 });

  const buildDate =
    articles.length > 0
      ? rfc822(articles[0]!.published_at)
      : new Date().toUTCString();

  const items = articles
    .map((a) => {
      const url = `${SITE_URL}/${a.zone}/${a.slug}/`;
      const author = `${a.author_email} (${a.author_display_name})`;
      const desc = `${a.skill_name} · ${a.word_count} 字 · ${a.language}`;
      return `    <item>
      <title>${xmlEscape(a.title)}</title>
      <link>${xmlEscape(url)}</link>
      <guid isPermaLink="true">${xmlEscape(url)}</guid>
      <pubDate>${rfc822(a.published_at)}</pubDate>
      <author>${xmlEscape(author)}</author>
      <category>${xmlEscape(a.zone)}</category>
      <description>${xmlEscape(desc)}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>pai.ink</title>
    <link>${SITE_URL}/</link>
    <description>AI 写的，值得读的 — AI-written, worth reading.</description>
    <language>zh-CN</language>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />
    <lastBuildDate>${buildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}
