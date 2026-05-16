/**
 * GET / — landing page.
 *
 * Mirrors site/build.py:write_landing() (lines 288-315). Hero block + two
 * zone sections, each showing the top 5 newest articles. Phase A keeps the
 * existing Chinese copy verbatim; the hero rewrite ships in Phase D.
 */

import type { Env, ArticleRow } from "../types";
import { listArticlesByZone } from "../db/queries";
import { escape } from "../util/html";
import { shell } from "../templates/shell";
import { articleRow } from "./_article_row";

const ZONES = [
  {
    key: "finance" as const,
    name: "金融",
    nameEn: "Finance",
    lede: "公司研究、行业分析、财报解读 —— 大家用 AI 写出来的好文章，挑一篇看看。",
  },
  {
    key: "web3" as const,
    name: "Web3",
    nameEn: "",
    lede: "协议解读、链上分析、机制设计 —— 一起分享 AI 帮你写的 Web3 内容。",
  },
];

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function zoneTitle(zone: { name: string; nameEn: string }): string {
  if (zone.nameEn && zone.nameEn !== zone.name) {
    return `${zone.name} / ${zone.nameEn}`;
  }
  return zone.name;
}

export async function renderLanding(_req: Request, env: Env): Promise<Response> {
  // Phase A only knows two zones; pull each in parallel for snappier TTFB.
  const buckets = await Promise.all(
    ZONES.map((z) => listArticlesByZone(env.DB, z.key, { limit: 5 })),
  );

  const parts: string[] = [];
  parts.push(`<section class="hero">
  <h1>AI 写的，值得读的。</h1>
</section>`);

  ZONES.forEach((zone, i) => {
    const items: ArticleRow[] = buckets[i] ?? [];
    const roman = i < ROMAN.length ? ROMAN[i] : String(i + 1);
    parts.push(`<section class="zone">
  <p class="zone-roman">第 ${roman} 区</p>
  <div class="zone-head">
    <h2>${escape(zoneTitle(zone))}</h2>
    <a class="more" href="/${zone.key}/">查看全部 →</a>
  </div>`);
    if (items.length === 0) {
      parts.push('<p class="empty">暂无文章。</p>');
    } else {
      parts.push('<ul class="articles">');
      for (const a of items) {
        parts.push(`<li>${articleRow(a)}</li>`);
      }
      parts.push("</ul>");
    }
    parts.push("</section>");
  });

  return new Response(
    shell({
      title: "pai.ink — AI 写的，值得读的",
      body: parts.join("\n"),
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    },
  );
}
