/**
 * XML sitemap at /sitemap.xml.
 *
 * Includes every live article + the small set of evergreen chrome pages
 * (/, /finance/, /web3/, /about, /agreement/v3, /submit, /signup, /login).
 * Retracted articles are excluded by listRecentArticles().
 */

import type { Env } from "../types";
import { listRecentArticles } from "../db/queries";

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function renderSitemap(_req: Request, env: Env): Promise<Response> {
  const SITE_URL = env.SITE_URL ?? "https://www.paiink.com";
  const articles = await listRecentArticles(env.DB, { limit: 1000 });
  const today = new Date().toISOString().slice(0, 10);

  const staticUrls: Array<{ loc: string; lastmod: string; priority: string }> = [
    { loc: `${SITE_URL}/`, lastmod: today, priority: "1.0" },
    { loc: `${SITE_URL}/finance/`, lastmod: today, priority: "0.8" },
    { loc: `${SITE_URL}/web3/`, lastmod: today, priority: "0.8" },
    { loc: `${SITE_URL}/about`, lastmod: today, priority: "0.5" },
    { loc: `${SITE_URL}/agreement/v3`, lastmod: today, priority: "0.3" },
    { loc: `${SITE_URL}/submit`, lastmod: today, priority: "0.6" },
    { loc: `${SITE_URL}/signup`, lastmod: today, priority: "0.4" },
    { loc: `${SITE_URL}/login`, lastmod: today, priority: "0.4" },
  ];

  const articleUrls = articles.map((a) => ({
    loc: `${SITE_URL}/${a.zone}/${a.slug}/`,
    lastmod: isoDate(a.published_at),
    priority: "0.9",
  }));

  const urls = [...staticUrls, ...articleUrls]
    .map(
      (u) => `  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <priority>${u.priority}</priority>
  </url>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
