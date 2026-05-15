#!/usr/bin/env python3
"""site/build.py — minimal static-site builder for pai.

This is the *placeholder* builder used until step A replaces it with
Astro. It walks `content/<zone>/<slug>/`, copies each article verbatim
into `site/dist/<zone>/<slug>/`, and generates four kinds of index
pages from the manifests:

    site/dist/index.html              — landing
    site/dist/<zone>/index.html       — zone listing
    site/dist/verify/<id>/index.html  — per-article verification page

No templating engine. No deps beyond stdlib. The point is for 4EVERLAND
to have *something* to serve while we get latency data; Astro arrives
in step A.

Run from repo root:
    python site/build.py
"""

from __future__ import annotations

import datetime as dt
import html
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
DIST = ROOT / "site" / "dist"
ZONES = ["finance", "web3"]
ZONE_LABELS = {"finance": "金融区 / Finance", "web3": "Web3 区 / Web3"}


def _read_manifest(article_dir: Path) -> dict | None:
    m = article_dir / "ai-audit.json"
    if not m.is_file():
        return None
    try:
        return json.loads(m.read_text())
    except json.JSONDecodeError:
        return None


def _slug_of(article_dir: Path) -> str:
    return article_dir.name


def collect_articles() -> dict[str, list[dict]]:
    """Return {zone: [{slug, manifest, ...}, ...]}."""
    out: dict[str, list[dict]] = {z: [] for z in ZONES}
    for zone in ZONES:
        zone_dir = CONTENT / zone
        if not zone_dir.is_dir():
            continue
        for article_dir in sorted(zone_dir.iterdir()):
            if not article_dir.is_dir():
                continue
            manifest = _read_manifest(article_dir)
            if not manifest:
                continue
            out[zone].append({
                "slug": _slug_of(article_dir),
                "dir": article_dir,
                "manifest": manifest,
            })
    return out


# ---------- HTML helpers (yes, plain f-strings; this gets replaced) ----------

CSS = """
:root { --fg:#1a2c4e; --muted:#6e6e6e; --bg:#f5f3ee; --card:#fff; --accent:#2e7d4f; --border:#cfc9bd; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Helvetica Neue", "PingFang SC", "Noto Sans SC", sans-serif; color: var(--fg); background: var(--bg); margin: 0; line-height: 1.6; }
.wrap { max-width: 900px; margin: 0 auto; padding: 40px 24px; }
header.site { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
header.site h1 { font-size: 28px; margin: 0; }
header.site nav a { margin-left: 16px; color: var(--fg); text-decoration: none; }
header.site nav a:hover { color: var(--accent); }
h2 { font-size: 22px; margin-top: 40px; border-left: 4px solid var(--accent); padding-left: 12px; }
.article { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 20px; margin: 16px 0; }
.article h3 { margin: 0 0 6px; font-size: 18px; }
.article a { color: var(--fg); text-decoration: none; }
.article a:hover { color: var(--accent); }
.article .meta { color: var(--muted); font-size: 13px; margin-top: 8px; }
.article .meta a { color: var(--muted); text-decoration: underline; }
.verify { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 20px; }
.verify h2 { border: none; padding: 0; margin: 0 0 16px; }
.verify pre { background: #f8f6f1; padding: 12px; overflow-x: auto; border-radius: 4px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; margin-left: 8px; }
.badge.ok { background: #e6f4ea; color: var(--accent); }
.badge.warn { background: #fdf2e9; color: #b8842a; }
.badge.unverified { background: #f5ebea; color: #a83232; }
footer { color: var(--muted); font-size: 13px; margin-top: 64px; padding-top: 16px; border-top: 1px solid var(--border); }
footer a { color: var(--muted); }
"""


def _shell(title: str, body: str, *, base_depth: int = 0) -> str:
    css_href = "../" * base_depth + "style.css"
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title>
<link rel="stylesheet" href="{css_href}">
</head>
<body>
<div class="wrap">
<header class="site">
  <h1><a href="{'../' * base_depth or './'}" style="text-decoration:none;color:inherit">pai.ink</a></h1>
  <nav>
    <a href="{'../' * base_depth}finance/">金融</a>
    <a href="{'../' * base_depth}web3/">Web3</a>
    <a href="{'../' * base_depth}about.html">关于</a>
  </nav>
</header>
{body}
<footer>
  AI-written, verifiably. 本站所有文章带可校验 <code>ai-audit.json</code> 证明。
  Schema: <a href="https://pai.ink/schemas/ai-audit/v1.json">ai-audit/v1</a>.
</footer>
</div>
</body>
</html>
"""


def _article_card(zone: str, slug: str, manifest: dict, *, base_depth: int) -> str:
    art = manifest.get("article", {})
    skill = manifest.get("skill", {})
    author = manifest.get("author", {})
    verifier = manifest.get("verifier", {})
    title = html.escape(art.get("title", slug))
    subtitle = html.escape(art.get("subtitle", ""))
    article_href = f"{'../' * base_depth}{zone}/{slug}/"
    verify_href = f"{'../' * base_depth}verify/{art.get('id', '')}/"
    author_name = html.escape(author.get("display_name") or author.get("github", "anonymous"))
    skill_name = html.escape(skill.get("name", "—"))
    badge = '<span class="badge ok">✓ verified</span>' if verifier.get("verified_at") else '<span class="badge unverified">unverified locally</span>'
    return f"""<div class="article">
  <h3><a href="{article_href}">{title}</a>{badge}</h3>
  {('<div style="color:var(--muted);font-size:14px">' + subtitle + '</div>') if subtitle else ''}
  <div class="meta">
    {author_name} · {skill_name} ·
    <a href="{verify_href}">校验 →</a>
  </div>
</div>"""


def write_landing(articles: dict[str, list[dict]]) -> None:
    body_parts = [
        "<p style='font-size:18px;color:var(--muted);margin-top:24px'>",
        "AI 写作发布平台。每篇文章都带<strong>可机器校验的 AI 出处证明</strong>——",
        "skill 仓库 commit、模型、输入、作者签名全可追溯。",
        "</p>",
    ]
    for zone in ZONES:
        body_parts.append(f"<h2>{html.escape(ZONE_LABELS[zone])}</h2>")
        if not articles[zone]:
            body_parts.append(f"<p style='color:var(--muted)'>暂无文章。<a href='{zone}/'>查看 {zone}/ →</a></p>")
            continue
        for a in articles[zone][:5]:
            body_parts.append(_article_card(zone, a["slug"], a["manifest"], base_depth=0))
    (DIST / "index.html").write_text(_shell("pai.ink — AI-written, verifiably", "\n".join(body_parts), base_depth=0))


def write_zone_index(zone: str, items: list[dict]) -> None:
    body = [f"<h2>{html.escape(ZONE_LABELS[zone])}</h2>"]
    if not items:
        body.append("<p style='color:var(--muted)'>暂无文章。</p>")
    for a in items:
        body.append(_article_card(zone, a["slug"], a["manifest"], base_depth=1))
    (DIST / zone).mkdir(parents=True, exist_ok=True)
    (DIST / zone / "index.html").write_text(_shell(f"{ZONE_LABELS[zone]} — pai.ink", "\n".join(body), base_depth=1))


def write_verify_page(zone: str, slug: str, manifest: dict) -> None:
    art_id = manifest.get("article", {}).get("id")
    if not art_id:
        return
    art = manifest.get("article", {})
    skill = manifest.get("skill", {})
    gen = manifest.get("generation", {})
    author = manifest.get("author", {})
    verifier = manifest.get("verifier") or {}
    passed = verifier.get("checks_passed") or []
    warned = verifier.get("checks_warned") or []
    has_sig = "signature" in manifest

    rows = []
    rows.append(("文章 / Article", html.escape(art.get("title", ""))))
    rows.append(("分区 / Zone", html.escape(art.get("category", ""))))
    rows.append(("内容哈希 / SHA-256", f"<code>{art.get('content_sha256', '')}</code>"))
    rows.append(("Skill 仓库", f'<a href="{html.escape(skill.get("repo_url", ""))}">{html.escape(skill.get("repo_url", ""))}</a>'))
    rows.append(("Skill commit", f"<code>{html.escape(skill.get('repo_commit', ''))}</code>"))
    rows.append(("模型", html.escape(gen.get("model", ""))))
    rows.append(("Harness", html.escape(gen.get("harness", ""))))
    rows.append(("生成开始", html.escape(gen.get("started_at", ""))))
    rows.append(("生成结束", html.escape(gen.get("finished_at", ""))))
    rows.append(("作者 GitHub", html.escape(author.get("github", ""))))
    if author.get("wallet"):
        rows.append(("钱包", html.escape(author["wallet"])))
    rows.append(("ed25519 签名", "✓ 存在" if has_sig else "—"))

    body = [f'<h2>校验 / Verify <code>{html.escape(art_id)}</code></h2>']
    if passed:
        body.append('<p>CI 校验通过：</p><ul>')
        for c in passed:
            body.append(f'<li class="badge ok">✓ {html.escape(c)}</li> ')
        body.append('</ul>')
    if warned:
        body.append('<p>警告（不阻断）：</p><ul>')
        for w in warned:
            body.append(f'<li class="badge warn">⚠ {html.escape(w)}</li> ')
        body.append('</ul>')
    if not verifier:
        body.append('<p class="badge unverified">⚠ 本文未携带 CI 验证戳。可下载 <a href="ai-audit.json">ai-audit.json</a> 自行校验。</p>')
    body.append('<table style="margin-top:24px;border-collapse:collapse;width:100%">')
    for k, v in rows:
        body.append(f'<tr><td style="padding:6px 12px;border-bottom:1px solid var(--border);color:var(--muted);width:160px">{k}</td><td style="padding:6px 12px;border-bottom:1px solid var(--border);word-break:break-all">{v}</td></tr>')
    body.append('</table>')
    body.append(f'<p style="margin-top:24px"><a href="../../{zone}/{slug}/">→ 阅读文章</a> · <a href="../../{zone}/{slug}/ai-audit.json">下载 manifest</a></p>')
    out = DIST / "verify" / art_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(_shell(f"校验 {art_id[:8]} — pai.ink", "\n".join(body), base_depth=2))


def write_about() -> None:
    body = """
<h2>关于 pai.ink</h2>
<p>pai 是一个用 AI skill 写作并对外发布的平台。和普通博客最大的差别：</p>
<ul>
  <li>每篇文章都附一个 <code>ai-audit.json</code>，把"是用哪个 skill 仓库的哪个 commit、哪个模型、哪些输入"全部锁死。</li>
  <li>CI 会做 9 项检查（内容哈希、skill commit 是否存在、作者签名等），失败直接拒绝合并。</li>
  <li>金融区放公司研究/行业分析，Web3 区放协议解读/链上分析。后续会加更多分区。</li>
</ul>
<h2>怎么投稿</h2>
<ol>
  <li>用你的 AI skill（公开仓库）生成 HTML 文章。</li>
  <li>跑 <code>tools/emit_audit.py</code> 生成 manifest，<code>tools/sign_audit.py sign</code> 用 ed25519 签名。</li>
  <li>Fork 仓库 → 放到 <code>content/&lt;zone&gt;/&lt;slug&gt;/</code> → 开 PR。</li>
  <li>CI 绿了机器人合并。</li>
</ol>
<p>标准开源在 <a href="https://pai.ink/schemas/ai-audit/v1.json">ai-audit/v1.json</a>（CC0）。任何站点都可以采用同一份 schema。</p>
"""
    (DIST / "about.html").write_text(_shell("关于 — pai.ink", body, base_depth=0))


def copy_articles(articles: dict[str, list[dict]]) -> None:
    for zone, items in articles.items():
        for a in items:
            src = a["dir"]
            dst = DIST / zone / a["slug"]
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)
    (DIST / "style.css").write_text(CSS)

    articles = collect_articles()
    n = sum(len(v) for v in articles.values())
    print(f"discovered {n} articles across {len([z for z, v in articles.items() if v])} zones")

    copy_articles(articles)
    write_landing(articles)
    for zone in ZONES:
        write_zone_index(zone, articles.get(zone, []))
        for a in articles.get(zone, []):
            write_verify_page(zone, a["slug"], a["manifest"])
    write_about()
    print(f"built {DIST.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
