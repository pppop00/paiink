#!/usr/bin/env python3
"""emit_audit.py — scaffold an ai-audit.json from a skill output directory.

Given a folder containing your article HTML (and optional assets), this
generates a partial ai-audit.json with all the deterministic fields filled
in: id, content_sha256, asset hashes, word count, language guess,
timestamps. You then edit the file to add skill repo/commit, model,
inputs, and author.

Usage:
    python emit_audit.py path/to/article-dir \\
        --category finance \\
        --title "Apple Q2 2026 Research" \\
        --skill-repo https://github.com/me/equity-research-skill \\
        --skill-commit a1b2c3d \\
        --model claude-opus-4-7 \\
        --github me

Anything not provided is left blank for you to fill in.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import re
import sys
import uuid
from pathlib import Path


CONTENT_FILENAMES = ("index.html", "article.html", "report.html", "main.html")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _word_count(html_path: Path) -> int:
    try:
        text = html_path.read_text(errors="ignore")
    except Exception:
        return 0
    stripped = re.sub(r"<[^>]+>", " ", text)
    return len([w for w in stripped.split() if w.strip()])


def _now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def _pick_content_path(article_dir: Path) -> Path:
    for name in CONTENT_FILENAMES:
        p = article_dir / name
        if p.is_file():
            return p
    # Fall back to the largest .html
    htmls = sorted(
        (p for p in article_dir.glob("*.html") if p.is_file()),
        key=lambda p: p.stat().st_size,
        reverse=True,
    )
    if htmls:
        return htmls[0]
    sys.stderr.write(f"no HTML file found in {article_dir}\n")
    sys.exit(1)


def _collect_assets(article_dir: Path, content_path: Path) -> list[dict]:
    assets = []
    for p in sorted(article_dir.rglob("*")):
        if not p.is_file():
            continue
        if p == content_path:
            continue
        if p.name == "ai-audit.json":
            continue
        rel = p.relative_to(article_dir).as_posix()
        media, _ = mimetypes.guess_type(p.name)
        entry = {
            "path": rel,
            "sha256": _sha256_file(p),
        }
        if media:
            entry["media_type"] = media
        assets.append(entry)
    return assets


def build_manifest(args: argparse.Namespace) -> dict:
    article_dir = Path(args.dir).resolve()
    if not article_dir.is_dir():
        sys.stderr.write(f"not a directory: {article_dir}\n")
        sys.exit(1)
    content_path = _pick_content_path(article_dir)

    manifest = {
        "schema": "https://pai.ink/schemas/ai-audit/v1.json",
        "schema_version": "1.0",
        "article": {
            "id": str(uuid.uuid4()),
            "title": args.title or "",
            "category": args.category,
            "tags": args.tag or [],
            "language": args.language or "",
            "content_sha256": _sha256_file(content_path),
            "content_path": content_path.relative_to(article_dir).as_posix(),
            "assets": _collect_assets(article_dir, content_path),
            "word_count": _word_count(content_path),
        },
        "skill": {
            "name": args.skill_name or "",
            "repo_url": args.skill_repo or "",
            "repo_commit": args.skill_commit or "",
        },
        "generation": {
            "model": args.model or "",
            "harness": args.harness or "claude-code-cli",
            "started_at": args.started_at or _now_iso(),
            "finished_at": args.finished_at or _now_iso(),
            "user_inputs": [],
            "reproducibility_note": ""
        },
        "author": {
            "github": args.github or "",
        },
    }
    if args.subtitle:
        manifest["article"]["subtitle"] = args.subtitle
    if args.skill_version:
        manifest["skill"]["version"] = args.skill_version
    if args.display_name:
        manifest["author"]["display_name"] = args.display_name
    if args.wallet:
        manifest["author"]["wallet"] = args.wallet
    # Strip empties so the file is tidy and easier to fill in
    def _prune(d):
        if isinstance(d, dict):
            return {k: _prune(v) for k, v in d.items() if v not in ("", [], None)}
        if isinstance(d, list):
            return [_prune(x) for x in d]
        return d
    # Keep required fields even if empty so authors notice
    pruned = _prune(manifest)
    for required in ("article", "skill", "generation", "author"):
        pruned.setdefault(required, manifest[required])
    pruned.setdefault("schema", manifest["schema"])
    pruned.setdefault("schema_version", manifest["schema_version"])
    return pruned


def main() -> int:
    ap = argparse.ArgumentParser(description="Scaffold ai-audit.json from a skill output dir")
    ap.add_argument("dir", help="Directory containing the rendered article")
    ap.add_argument("--category", required=True, choices=("finance", "web3"))
    ap.add_argument("--title")
    ap.add_argument("--subtitle")
    ap.add_argument("--tag", action="append", help="Repeatable")
    ap.add_argument("--language", default="zh-CN")
    ap.add_argument("--skill-name")
    ap.add_argument("--skill-repo")
    ap.add_argument("--skill-commit")
    ap.add_argument("--skill-version")
    ap.add_argument("--model")
    ap.add_argument("--harness")
    ap.add_argument("--started-at")
    ap.add_argument("--finished-at")
    ap.add_argument("--github")
    ap.add_argument("--display-name")
    ap.add_argument("--wallet")
    ap.add_argument("--out", help="Where to write the manifest (default: <dir>/ai-audit.json)")
    args = ap.parse_args()

    manifest = build_manifest(args)
    out_path = Path(args.out) if args.out else (Path(args.dir) / "ai-audit.json")
    out_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
