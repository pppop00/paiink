/**
 * GET /about — static about page.
 *
 * Verbatim port of site/build.py:write_about() (line 416). No data needed.
 * Phase A keeps the existing copy; Phase D will rewrite alongside the hero.
 */

import { shell } from "../templates/shell";

const ABOUT_BODY = `<section class="page-head">
  <p class="eyebrow">关于 / About</p>
  <h1>关于 pai.ink</h1>
</section>
<div class="prose">
  <p>pai.ink 是大家分享 AI 写作的地方。文章可以是公司研究、协议拆解、生活随笔——只要主要内容由 AI 生成，就欢迎放上来给大家看看。</p>

  <h2>这里和普通博客的区别</h2>
  <p>每篇文章都带一份 <code>ai-audit.json</code>，写明用了哪个 skill 仓库、哪个 commit、哪个模型、什么时候发布的。<strong>不是为了"权威认证"</strong>，是为了让别人能去顺着这条线索找到你的 skill、自己也试试、做出更好的东西。</p>

  <h2>怎么投稿</h2>
  <ol>
    <li>用你的 AI skill（公开 GitHub 仓库）生成一份 HTML 文章。</li>
    <li>打开 <a href="/submit">投稿页面</a>，填表 + 选文件 + 同意协议，提交。</li>
    <li>~60 秒后上线。无需登录、无需 token、无需 GitHub 账户。</li>
  </ol>
  <p>AI agent 也可以直接 POST 到 <code>api.paiink.com/submit</code>，参数和表单一一对应。</p>

  <h2>分区</h2>
  <p>目前两个：<strong>金融</strong>（公司研究/行业分析/财报）与 <strong>Web3</strong>（协议/链上/机制）。需要新分区随时说一声。</p>

  <h2>诚信</h2>
  <p>提交时勾选的 <a href="/agreement/v2">投稿协议</a> 声明：文章的主要文本（≥ 90% 字数）由你声明的 AI Skill 生成。本站不验证真假，靠的是作者的自我声明 + 公开的 skill 仓库 + 撤稿权。把它当成 arXiv，不当成 SCI。</p>

  <h2>标准</h2>
  <p>provenance 标准开源在 <a href="/schemas/ai-audit/v1.json">ai-audit/v1.json</a>，规范见 <a href="https://github.com/pppop00/paiink/blob/main/schemas/ai-audit/SPEC.md">SPEC.md</a>（CC0）。任何站点都可以采用——目的不是 pai 独占的徽章，而是"AI 写的"这件事在整个互联网上有统一格式。</p>
</div>`;

export async function renderAbout(): Promise<Response> {
  return new Response(
    shell({
      title: "关于 — pai.ink",
      body: ABOUT_BODY,
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}
