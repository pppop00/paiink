#!/usr/bin/env python3
"""site/build.py — static site builder for pai.ink.

Placeholder until step A replaces it with Astro. Walks `content/<zone>/<slug>/`,
copies each article verbatim into `dist/<zone>/<slug>/`, generates landing,
zone listings, verify pages, and about page.

Run from repo root:
    python site/build.py

CSP / security headers strategy (2026-05-15):
---------------------------------------------
Production is served from IPFS (4EVERLAND-pinned) through BunnyCDN. A
`curl -sI https://www.paiink.com/` shows BunnyCDN-BO1 returns content with
NO Netlify-style `_headers` processing applied (no CSP, no XCTO, no XFO).
Plain IPFS gateways also cannot honor a `_headers` file because content
is content-addressed and served as-is. There is no documented evidence
that 4EVERLAND post-processes a `_headers` file.

Choice: Option B — inject `<meta http-equiv="Content-Security-Policy" ...>`
into the `<head>` of every pai-chrome page (landing, zone indexes, verify,
about, agreement, submit). The CSP is NOT injected into the
self-contained article HTMLs copied verbatim from `content/<zone>/<slug>/`,
both because (a) CLAUDE.md forbids modifying article HTML (would invalidate
content_sha256) and (b) anamnesis articles load d3 / chart.js from
jsdelivr / Google Fonts, which the project-wide CSP intentionally does not
allow on pai-chrome surfaces.

We still emit a `dist/_headers` file (Netlify/CF Pages syntax). It is a
no-op on the current BunnyCDN+IPFS path but is wired up so that whenever an
edge layer that honors it is added (BunnyCDN edge rules, CF Pages, Vercel,
etc.), the security posture upgrades automatically. `frame-ancestors`
cannot be set via <meta>, so the `_headers` file is the canonical place
to declare anti-clickjacking; until the edge honors it, browsers fall back
to the meta-tag policy (which omits frame-ancestors) plus `X-Frame-Options`
will only apply once the edge honors the file.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
CONTENT = ROOT / "content"
SCHEMAS = ROOT / "schemas"
TEMPLATES = SITE / "templates"
DIST = SITE / "dist"

# Pinned hash of content/_meta/agreement-v1.md. The build asserts the
# on-disk file matches this constant so a stray whitespace edit fails the
# build loudly rather than silently drifting from manifests that reference
# this hash.
AGREEMENT_V1_SHA256 = "d89b0a30554743958e704b4d825966fad2eb22b6399bc00d0a15809f8deed807"
AGREEMENT_V2_SHA256 = "ec4066647aad291af1e7e88387b3dbfea8c63fce13da3e5ba64f11299793a19d"
AGREEMENT_CURRENT_VERSION = "v2"

# Content-Security-Policy applied to pai-chrome pages via <meta>. Allows
# inline scripts/styles (the submit form has inline JS, the global chrome
# has an inline cursor script, anamnesis articles have inline Sankey/waterfall
# scripts but the CSP is not injected into article HTML).
# `connect-src` allows api.paiink.com for the submit form fetch.
# `data:` covers chart libraries that embed images as URIs.
CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self' data:; "
    "connect-src 'self' https://api.paiink.com; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'"
)

# Headers file content (Option-A artifact, no-op on current CDN path).
HEADERS_FILE = f"""/*
  Content-Security-Policy: {CSP_POLICY}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=()
"""

ZONES = [
    {"key": "finance", "name": "金融", "name_en": "Finance",
     "lede": "公司研究、行业分析、财报解读 —— 大家用 AI 写出来的好文章，挑一篇看看。"},
    {"key": "web3",    "name": "Web3",  "name_en": "",
     "lede": "协议解读、链上分析、机制设计 —— 一起分享 AI 帮你写的 Web3 内容。"},
]


def _zone_title(zone: dict) -> str:
    if zone["name_en"] and zone["name_en"] != zone["name"]:
        return f"{zone['name']} / {zone['name_en']}"
    return zone["name"]
ZONES_BY_KEY = {z["key"]: z for z in ZONES}


# ---------- collection ----------

def _read_manifest(article_dir: Path) -> dict | None:
    m = article_dir / "ai-audit.json"
    if not m.is_file():
        return None
    try:
        return json.loads(m.read_text())
    except json.JSONDecodeError:
        return None


def collect_articles() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {z["key"]: [] for z in ZONES}
    for zone in ZONES:
        # Defense in depth: never treat an underscore-prefixed top-level
        # directory (e.g. `content/_meta/`) as a zone. ZONES is hardcoded
        # but a future bug could append "_meta" — guard anyway.
        if zone["key"].startswith("_"):
            continue
        zone_dir = CONTENT / zone["key"]
        if not zone_dir.is_dir():
            continue
        for d in sorted(zone_dir.iterdir()):
            if not d.is_dir():
                continue
            if d.name.startswith("_") or d.name.startswith("."):
                continue
            m = _read_manifest(d)
            if not m:
                continue
            out[zone["key"]].append({"slug": d.name, "dir": d, "manifest": m})
    # newest first by finished_at
    for k in out:
        out[k].sort(
            key=lambda a: a["manifest"].get("generation", {}).get("finished_at", ""),
            reverse=True,
        )
    return out


# ---------- helpers ----------

def _h(s: str | None) -> str:
    return html.escape(s or "", quote=True)


def _date_of(article: dict | None = None, *, manifest: dict | None = None, slug: str | None = None) -> str:
    """Best date for display. Prefer a date embedded in the slug
    (`...-YYYY-MM-DD`), falling back to manifest.generation.finished_at."""
    if slug:
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})$", slug)
        if m:
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if manifest:
        ts = manifest.get("generation", {}).get("finished_at", "")
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", ts or "")
        if m:
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return ""


def _author_name(manifest: dict) -> str:
    a = manifest.get("author", {}) or {}
    return a.get("display_name") or a.get("github") or "anonymous"


def _shell(*, title: str, body: str, base: str, active: str | None = None,
           extra_head: str = "") -> str:
    """Render one page. `base` is the prefix to root, e.g. '', '../', '../../'."""
    def link(href: str, label: str, key: str) -> str:
        attr = ' aria-current="page"' if active == key else ""
        return f'<a href="{base}{href}"{attr}>{label}</a>'
    csp_meta = f'<meta http-equiv="Content-Security-Policy" content="{_h(CSP_POLICY)}">'
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
{csp_meta}
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>{_h(title)}</title>
<link rel="icon" href="{base}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{base}style.css">
{extra_head}
</head>
<body>
<div class="wrap">
<header class="masthead">
  <div class="brand"><a href="{base or './'}">pai.ink</a></div>
  <nav>
    {link("finance/", "金融", "finance")}
    {link("web3/", "Web3", "web3")}
    {link("submit/", "投稿 / Submit", "submit")}
  </nav>
</header>
{body}
<footer class="site">
  <div><a href="{base or './'}">pai.ink</a> · AI 写的，值得读的</div>
  <div>
    <a href="{base}about.html">关于</a> ·
    <a href="{base}submit/">投稿 / Submit</a> ·
    <a href="{base}agreement/v2/">投稿协议 / Agreement</a> ·
    <a href="https://github.com/pppop00/paiink">源代码 / Source</a> ·
    <a href="https://github.com/pppop00/paiink/blob/main/LICENSE">Apache 2.0</a> ·
    <a href="{base}schemas/ai-audit/v1.json">Schema</a>
  </div>
</footer>
</div>
<script>
(function () {{
  if (!window.matchMedia('(pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('div');
  c.className = 'cursor';
  document.body.appendChild(c);
  let x = 0, y = 0, raf = 0;
  window.addEventListener('mousemove', function (e) {{
    x = e.clientX; y = e.clientY;
    if (!raf) raf = requestAnimationFrame(function () {{
      c.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) translate(-50%,-50%)';
      raf = 0;
    }});
  }}, {{ passive: true }});
  document.addEventListener('mouseleave', function () {{ c.classList.add('hidden'); }});
  document.addEventListener('mouseenter', function () {{ c.classList.remove('hidden'); }});
  const sel = 'a, button, summary, input, textarea, label, [role="button"], [data-clickable]';
  document.addEventListener('mouseover', function (e) {{
    if (e.target && e.target.closest && e.target.closest(sel)) c.classList.add('hovering');
  }});
  document.addEventListener('mouseout', function (e) {{
    if (e.target && e.target.closest && e.target.closest(sel)) c.classList.remove('hovering');
  }});
}})();
</script>
</body>
</html>
"""


def _article_link(article: dict, *, base: str) -> str:
    m = article["manifest"]
    art = m.get("article", {})
    skill = m.get("skill", {})
    zone = art.get("category", "")
    art_id = art.get("id", "")
    href = f"{base}{zone}/{article['slug']}/"
    verify_href = f"{base}verify/{art_id}/"
    title = _h(art.get("title", article["slug"]))
    dek = _h(art.get("subtitle", ""))
    meta_bits = [
        _h(_author_name(m)),
        _h(skill.get("name", "")),
        _date_of(manifest=m, slug=article["slug"]),
    ]
    meta = '<span class="sep">·</span>'.join(b for b in meta_bits if b)
    dek_html = f'<p class="dek">{dek}</p>' if dek else ""
    return f"""<div class="article-row">
  <a class="article-link" href="{href}">
    <h3>{title}</h3>
    {dek_html}
    <p class="meta">{meta}</p>
  </a>
  <div class="article-side">
    <a class="side-link" href="{verify_href}">详情 →</a>
  </div>
</div>"""


# ---------- pages ----------

_ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]


def write_landing(articles: dict[str, list[dict]]) -> None:
    parts: list[str] = []
    parts.append("""<section class="hero">
  <h1>AI 写的，值得读的。</h1>
  <p>把你用 AI 写的文章分享出来，看看别人怎么写，相互启发、相互欣赏。每篇都附一份 <a href="/agreement/v2/"><code>ai-audit.json</code></a>，记录是谁、用哪个 skill、什么模型生成的 —— 透明，但不严肃。</p>
</section>""")

    for i, zone in enumerate(ZONES):
        key = zone["key"]
        items = articles.get(key, [])[:5]
        roman = _ROMAN[i] if i < len(_ROMAN) else str(i + 1)
        parts.append(f"""<section class="zone">
  <p class="zone-roman">第 {roman} 区</p>
  <div class="zone-head">
    <h2>{_h(_zone_title(zone))}</h2>
    <a class="more" href="{key}/">查看全部 →</a>
  </div>""")
        if not items:
            parts.append('<p class="empty">暂无文章。</p>')
        else:
            parts.append('<ul class="articles">')
            for a in items:
                parts.append(f'<li>{_article_link(a, base="")}</li>')
            parts.append('</ul>')
        parts.append('</section>')

    (DIST / "index.html").write_text(
        _shell(title="pai.ink — AI 写的，值得读的", body="\n".join(parts), base="")
    )


def write_zone_index(zone: dict, items: list[dict]) -> None:
    key = zone["key"]
    body_parts = [f"""<section class="page-head">
  <h1>{_h(_zone_title(zone))}</h1>
  <p class="lede">{_h(zone['lede'])}</p>
</section>"""]
    if not items:
        body_parts.append('<p class="empty">暂无文章。</p>')
    else:
        body_parts.append('<ul class="articles">')
        for a in items:
            body_parts.append(f'<li>{_article_link(a, base="../")}</li>')
        body_parts.append('</ul>')
    out = DIST / key
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(
        _shell(title=f"{_zone_title(zone)} — pai.ink",
               body="\n".join(body_parts), base="../", active=key)
    )


def write_verify_page(zone: str, slug: str, manifest: dict) -> None:
    art = manifest.get("article", {})
    skill = manifest.get("skill", {})
    gen = manifest.get("generation", {})
    author = manifest.get("author", {})
    art_id = art.get("id")
    if not art_id:
        return
    has_sig = "signature" in manifest

    repo_url = skill.get("repo_url", "")
    repo_commit = skill.get("repo_commit", "")
    repo_link = f'<a href="{_h(repo_url)}">{_h(repo_url)}</a>' if repo_url else "—"
    short_commit = (repo_commit[:8] + "…") if len(repo_commit) > 12 else repo_commit
    if repo_url and repo_commit:
        commit_link = f'<a href="{_h(repo_url)}/commit/{_h(repo_commit)}"><code>{_h(short_commit)}</code></a>'
    else:
        commit_link = f"<code>{_h(short_commit)}</code>"

    article_href = f"../../{zone}/{slug}/"
    manifest_href = f"../../{zone}/{slug}/ai-audit.json"
    content_hash = art.get("content_sha256", "")
    short_hash = content_hash[:16] + "…" if len(content_hash) > 20 else content_hash

    rows = [
        ("文章 / Article", f'<a href="{article_href}">{_h(art.get("title", ""))}</a>'),
        ("分区 / Zone", _h(zone)),
        ("作者 / Author", _h(_author_name(manifest))),
        ("Skill", _h(skill.get("name", "")) or "—"),
        ("Skill 仓库", repo_link),
        ("Skill commit", commit_link),
        ("模型 / Model", f'<code>{_h(gen.get("model", ""))}</code>'),
        ("Harness", _h(gen.get("harness", "")) or "—"),
    ]
    # Legacy manifests (pre-v2) have generation.started_at/finished_at; new ones don't.
    started_at = gen.get("started_at", "")
    finished_at = gen.get("finished_at", "")
    if started_at or finished_at:
        rows.append(("生成时间", f'{_h(started_at)} → {_h(finished_at)}'))
    api_req_id = gen.get("api_request_id", "")
    if api_req_id:
        rows.append(("API request id", f'<code>{_h(api_req_id)}</code>'))
    rows.extend([
        ("发布时间", _h(art.get("published_at", "")) or "—"),
        ("内容哈希", f'<code title="{_h(content_hash)}">{_h(short_hash)}</code>'),
        ("ed25519 签名", "存在" if has_sig else "—"),
    ])
    if author.get("wallet"):
        rows.append(("钱包", f'<code>{_h(author["wallet"])}</code>'))

    raw_json = html.escape(json.dumps(manifest, indent=2, ensure_ascii=False))

    body = [f"""<section class="verify-head">
  <p class="eyebrow">详情 / Details</p>
  <h1>{_h(art.get("title", ""))}</h1>
  <p class="sub">出处与 manifest。可下载源 <a href="{manifest_href}">ai-audit.json</a> 本地校验。</p>
</section>

<dl class="manifest">"""]
    for k, v in rows:
        body.append(f'  <dt>{_h(k)}</dt><dd>{v}</dd>')
    body.append("</dl>")

    body.append(f'<p style="font-size:14px;margin-top:24px"><a href="{article_href}">→ 阅读文章</a> · <a href="{manifest_href}">下载 ai-audit.json</a></p>')

    body.append(f"""<details class="raw">
  <summary>完整 manifest (raw)</summary>
  <pre>{raw_json}</pre>
</details>""")

    out = DIST / "verify" / art_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(
        _shell(title=f"详情 {art_id[:8]} — pai.ink", body="\n".join(body), base="../../")
    )



def write_about() -> None:
    body = """<section class="page-head">
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
    <li>打开 <a href="submit/">投稿页面</a>，填表 + 选文件 + 同意协议，提交。</li>
    <li>~60 秒后上线。无需登录、无需 token、无需 GitHub 账户。</li>
  </ol>
  <p>AI agent 也可以直接 POST 到 <code>api.paiink.com/submit</code>，参数和表单一一对应。</p>

  <h2>分区</h2>
  <p>目前两个：<strong>金融</strong>（公司研究/行业分析/财报）与 <strong>Web3</strong>（协议/链上/机制）。需要新分区随时说一声。</p>

  <h2>诚信</h2>
  <p>提交时勾选的 <a href="agreement/v2/">投稿协议</a> 声明：文章的主要文本（≥ 90% 字数）由你声明的 AI Skill 生成。本站不验证真假，靠的是作者的自我声明 + 公开的 skill 仓库 + 撤稿权。把它当成 arXiv，不当成 SCI。</p>

  <h2>标准</h2>
  <p>provenance 标准开源在 <a href="schemas/ai-audit/v1.json">ai-audit/v1.json</a>，规范见 <a href="schemas/ai-audit/SPEC.md">SPEC.md</a>（CC0）。任何站点都可以采用——目的不是 pai 独占的徽章，而是"AI 写的"这件事在整个互联网上有统一格式。</p>
</div>"""
    (DIST / "about.html").write_text(
        _shell(title="关于 — pai.ink", body=body, base="")
    )


# ---------- minimal markdown -> html ----------

_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_ITALIC_RE = re.compile(r"(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def _md_inline(text: str) -> str:
    """Apply inline markdown to one line of (already HTML-escaped) text."""
    # Inline code first, with placeholder so its contents are not re-styled.
    codes: list[str] = []

    def _code_sub(m: re.Match) -> str:
        codes.append(m.group(1))
        return f"\x00CODE{len(codes) - 1}\x00"

    text = _INLINE_CODE_RE.sub(_code_sub, text)
    text = _BOLD_RE.sub(lambda m: f"<strong>{m.group(1)}</strong>", text)
    text = _ITALIC_RE.sub(lambda m: f"<em>{m.group(1)}</em>", text)

    def _link_sub(m: re.Match) -> str:
        label, url = m.group(1), m.group(2)
        # url is already escaped from the source escape pass; re-escape attr-safely
        return f'<a href="{url}">{label}</a>'

    text = _LINK_RE.sub(_link_sub, text)

    # Restore codes (escape again so backtick contents stay literal).
    def _restore(m: re.Match) -> str:
        idx = int(m.group(1))
        return f"<code>{codes[idx]}</code>"

    text = re.sub(r"\x00CODE(\d+)\x00", _restore, text)
    return text


def md_to_html(md: str) -> str:
    """Minimal markdown -> HTML for the agreement page.

    Supports: # / ## / ### headings, paragraphs, blank lines, `-` bullet
    lists, blockquotes (`>`), horizontal rules (`---`), **bold**, _italic_,
    `code`, [text](url). No fenced code blocks, no nested lists, no tables.
    """
    # Escape everything first so any raw HTML in source is rendered as text;
    # the parser only re-introduces tags it explicitly recognizes.
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    in_list = False
    in_blockquote = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    def close_blockquote() -> None:
        nonlocal in_blockquote
        if in_blockquote:
            out.append("</blockquote>")
            in_blockquote = False

    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()

        if not stripped:
            close_list()
            close_blockquote()
            i += 1
            continue

        if stripped == "---":
            close_list()
            close_blockquote()
            out.append("<hr>")
            i += 1
            continue

        # Headings
        m_h = re.match(r"^(#{1,3})\s+(.*)$", stripped)
        if m_h:
            close_list()
            close_blockquote()
            level = len(m_h.group(1))
            content = _md_inline(html.escape(m_h.group(2)))
            out.append(f"<h{level}>{content}</h{level}>")
            i += 1
            continue

        # Bullet list item
        m_li = re.match(r"^-\s+(.*)$", stripped)
        if m_li:
            close_blockquote()
            if not in_list:
                out.append("<ul>")
                in_list = True
            content = _md_inline(html.escape(m_li.group(1)))
            out.append(f"<li>{content}</li>")
            i += 1
            continue

        # Blockquote
        m_bq = re.match(r"^>\s?(.*)$", stripped)
        if m_bq:
            close_list()
            if not in_blockquote:
                out.append("<blockquote>")
                in_blockquote = True
            content = _md_inline(html.escape(m_bq.group(1)))
            out.append(f"<p>{content}</p>")
            i += 1
            continue

        # Paragraph: gather contiguous non-blank, non-special lines.
        close_list()
        close_blockquote()
        para_lines = [stripped]
        j = i + 1
        while j < len(lines):
            nxt = lines[j].strip()
            if not nxt:
                break
            if re.match(r"^(#{1,3})\s+", nxt):
                break
            if re.match(r"^-\s+", nxt):
                break
            if re.match(r"^>\s?", nxt):
                break
            if nxt == "---":
                break
            para_lines.append(nxt)
            j += 1
        joined = " ".join(para_lines)
        content = _md_inline(html.escape(joined))
        out.append(f"<p>{content}</p>")
        i = j

    close_list()
    close_blockquote()
    return "\n".join(out)


# ---------- agreement page ----------

def _write_agreement_version(version: str, expected_hash: str, *, is_archived: bool) -> None:
    src = CONTENT / "_meta" / f"agreement-{version}.md"
    if not src.is_file():
        raise RuntimeError(f"agreement source missing: {src}")
    raw = src.read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected_hash:
        raise RuntimeError(
            f"agreement-{version}.md hash drift!\n"
            f"  expected: {expected_hash}\n"
            f"  actual:   {actual}\n"
            "Refusing to build. If you intentionally edited the agreement, "
            "ship a new version — do not modify a published version."
        )
    md_text = raw.decode("utf-8")
    body_md = md_to_html(md_text)
    short = expected_hash[:8] + "…" + expected_hash[-3:]
    archived_banner = ""
    if is_archived:
        archived_banner = (
            '<section class="agreement-archived">'
            f'<p><strong>归档版本。</strong>新投稿适用 <a href="../{AGREEMENT_CURRENT_VERSION}/">最新版本</a>。'
            '已发布文章的 manifest 永久绑定其上传时的协议版本。</p>'
            '</section>'
        )
    notice = (
        '<section class="agreement-hash">'
        '<p class="eyebrow">协议哈希 / Agreement hash</p>'
        f'<p>本协议哈希: <code title="{expected_hash}">{_h(short)}</code>'
        f' — 文件: <code>content/_meta/agreement-{version}.md</code>. '
        '任何人可下载源文件并本地复算验证。</p>'
        '<p class="agreement-verify">'
        f'<code>shasum -a 256 content/_meta/agreement-{version}.md</code>'
        '</p>'
        '</section>'
    )
    body = f'{archived_banner}{notice}\n<article class="prose agreement-body">\n{body_md}\n</article>'
    out = DIST / "agreement" / version
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(
        _shell(title=f"投稿协议 {version} — pai.ink", body=body, base="../../")
    )


def write_agreement() -> None:
    # v1 is archived (its retraction flow assumed GitHub identity); v2 is current.
    _write_agreement_version("v1", AGREEMENT_V1_SHA256, is_archived=True)
    _write_agreement_version("v2", AGREEMENT_V2_SHA256, is_archived=False)


# ---------- submit page ----------

def write_submit() -> None:
    tpl = TEMPLATES / "submit.html"
    if tpl.is_file():
        body = tpl.read_text()
    else:
        body = (
            '<section class="page-head">'
            '<p class="eyebrow">SUBMIT · 投稿</p>'
            '<h1>投稿</h1></section>\n'
            '<!-- TODO: form goes here -->'
        )
    out = DIST / "submit"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(
        _shell(title="投稿 / Submit — pai.ink", body=body, base="../", active="submit")
    )


def copy_articles(articles: dict[str, list[dict]]) -> None:
    for zone_key, items in articles.items():
        for a in items:
            dst = DIST / zone_key / a["slug"]
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(a["dir"], dst)


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    # Static assets
    shutil.copy(SITE / "style.css", DIST / "style.css")
    shutil.copy(SITE / "favicon.svg", DIST / "favicon.svg")
    # Publish the schema directory so /schemas/ai-audit/v1.json and friends
    # are resolvable on the live site (www.paiink.com).
    if SCHEMAS.is_dir():
        shutil.copytree(SCHEMAS, DIST / "schemas", dirs_exist_ok=True)

    articles = collect_articles()
    total = sum(len(v) for v in articles.values())
    print(f"discovered {total} articles across {sum(1 for v in articles.values() if v)} zones")

    copy_articles(articles)
    write_landing(articles)
    for zone in ZONES:
        write_zone_index(zone, articles.get(zone["key"], []))
        for a in articles.get(zone["key"], []):
            write_verify_page(zone["key"], a["slug"], a["manifest"])
    write_about()
    write_agreement()
    write_submit()

    # Forward-compat security headers. No-op on the current BunnyCDN+IPFS
    # path; would activate automatically on any Netlify/CF Pages-style edge.
    (DIST / "_headers").write_text(HEADERS_FILE)

    print(f"built {DIST.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
