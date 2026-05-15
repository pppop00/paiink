#!/usr/bin/env python3
"""tools/publish.py — one-shot publisher from a skill output dir to pai.ink.

Usage:
    python3 tools/publish.py <skill-output-dir> \\
        --zone finance \\
        --title "苹果公司 — 权益研究" \\
        [--subtitle "..."] \\
        [--language zh-CN]

Defaults (override with flags or env vars):
    --github         $PAI_GITHUB       (e.g. pppop00)
    --display-name   $PAI_DISPLAY_NAME (e.g. Zelong)
    --model          claude-opus-4-7
    --skill-name     "Anamnesis Research"
    --skill-repo     auto-detected from .git of the skill output dir
    --skill-commit   auto-detected (git rev-parse HEAD)

What it does:
    1. Find the article HTML (prefers research/*_Research_CN.html)
    2. Derive slug from the output dir (strips trailing hash, dashes lowercased)
    3. Copy HTML → content/<zone>/<slug>/index.html
       Copy cards/ → content/<zone>/<slug>/cards/
    4. Auto-detect skill repo URL + commit from the skill's .git
    5. Generate ai-audit.json
    6. Sign with ~/.pai/ed25519.key if present (skip with --no-sign)
    7. Run verify_audit.py --offline as sanity check
    8. git add + commit + push (skip steps with --no-commit / --no-push)

After push, 4EVERLAND auto-rebuilds in ~60-90s.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
CONTENT = ROOT / "content"


# ---------- helpers ----------

def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def _word_count(html_path: Path) -> int:
    try:
        text = html_path.read_text(errors="ignore")
    except Exception:
        return 0
    stripped = re.sub(r"<[^>]+>", " ", text)
    return len([w for w in stripped.split() if w.strip()])


def _slug_from_dir(name: str) -> str:
    """`Waste_Management_2026-05-14_e20146cf` → `waste-management-2026-05-14`."""
    s = re.sub(r"_[0-9a-f]{6,}$", "", name)   # strip trailing hash
    s = s.lower().replace("_", "-")
    s = re.sub(r"[^a-z0-9.-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def _find_article_html(skill_dir: Path) -> Path | None:
    # Anamnesis pattern: research/*_Research_CN.html (skip the skeleton)
    candidates = [
        p for p in sorted(skill_dir.glob("research/*.html"))
        if not p.name.startswith("_locked")
    ]
    if candidates:
        # Prefer the _CN.html if multiple
        cn = [p for p in candidates if "_CN" in p.stem]
        return cn[0] if cn else candidates[0]
    # Generic: any HTML in the dir
    for pattern in ("*.html", "report/*.html", "output/*.html"):
        cs = sorted(skill_dir.glob(pattern))
        if cs:
            return cs[0]
    return None


def _git(cwd: Path, *args: str) -> str | None:
    try:
        r = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=10,
        )
        return r.stdout.strip() if r.returncode == 0 else None
    except (subprocess.SubprocessError, FileNotFoundError):
        return None


def _detect_skill_git(skill_output_dir: Path) -> tuple[str, str]:
    """Walk up from output dir to find a .git, return (repo_url, commit)."""
    cur = skill_output_dir.resolve()
    for _ in range(8):
        if (cur / ".git").exists():
            url = _git(cur, "remote", "get-url", "origin") or ""
            # ssh → https
            m = re.match(r"git@([^:]+):(.+?)(?:\.git)?$", url)
            if m:
                url = f"https://{m.group(1)}/{m.group(2)}"
            url = re.sub(r"\.git$", "", url)
            commit = _git(cur, "rev-parse", "HEAD") or ""
            return url, commit
        if cur.parent == cur:
            break
        cur = cur.parent
    return "", ""


# ---------- main flow ----------

def copy_assets(skill_dir: Path, html_src: Path, target_dir: Path, *, include_cards: bool = True) -> list[str]:
    """Copy article HTML + sibling assets. Returns list of relpaths copied."""
    copied: list[str] = []
    target_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(html_src, target_dir / "index.html")
    copied.append("index.html")

    # Cards (PNG/JPG/SVG/WebP) from cards/ subdir of skill output
    cards = skill_dir / "cards"
    if include_cards and cards.is_dir():
        ALLOWED = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"}
        target_cards = target_dir / "cards"
        for f in sorted(cards.iterdir()):
            if f.is_file() and f.suffix.lower() in ALLOWED:
                target_cards.mkdir(exist_ok=True)
                shutil.copy(f, target_cards / f.name)
                copied.append(f"cards/{f.name}")
    return copied


def build_manifest(args, *, target_dir: Path, repo_url: str, repo_commit: str) -> dict:
    content_path = target_dir / "index.html"
    assets = []
    for p in sorted(target_dir.rglob("*")):
        if not p.is_file() or p == content_path or p.name == "ai-audit.json":
            continue
        rel = p.relative_to(target_dir).as_posix()
        media, _ = mimetypes.guess_type(p.name)
        entry = {"path": rel, "sha256": _sha256_file(p)}
        if media:
            entry["media_type"] = media
        assets.append(entry)

    m = {
        "schema": "https://pai.ink/schemas/ai-audit/v1.json",
        "schema_version": "1.0",
        "article": {
            "id": str(uuid.uuid4()),
            "title": args.title,
            "category": args.zone,
            "language": args.language,
            "content_sha256": _sha256_file(content_path),
            "content_path": "index.html",
            "assets": assets,
            "word_count": _word_count(content_path),
        },
        "skill": {
            "name": args.skill_name,
            "repo_url": repo_url,
            "repo_commit": repo_commit,
        },
        "generation": {
            "model": args.model,
            "harness": args.harness,
            "started_at": args.started_at or _now_iso(),
            "finished_at": args.finished_at or _now_iso(),
            "reproducibility_note": args.note or "",
        },
        "author": {
            "github": args.github,
            "display_name": args.display_name or args.github,
        },
    }
    if args.subtitle:
        m["article"]["subtitle"] = args.subtitle
    if args.tag:
        m["article"]["tags"] = args.tag
    # Trim empties so the file stays tidy
    if not m["generation"]["reproducibility_note"]:
        del m["generation"]["reproducibility_note"]
    return m


def run_sign(manifest_path: Path) -> bool:
    key = Path("~/.pai/ed25519.key").expanduser()
    if not key.is_file():
        print(f"  (no key at {key}; skipping signature — use tools/sign_audit.py keygen to make one)")
        return False
    r = subprocess.run(
        ["python3", str(TOOLS / "sign_audit.py"), "sign", str(key), str(manifest_path)],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        print(f"  signed with {key}")
        return True
    print(f"  WARN: sign failed: {r.stderr.strip()}")
    return False


def run_verify(manifest_path: Path) -> bool:
    r = subprocess.run(
        ["python3", str(TOOLS / "verify_audit.py"), "--offline", str(manifest_path)],
        capture_output=True, text=True,
    )
    for line in r.stdout.splitlines():
        print(f"  {line}")
    return r.returncode == 0


def git_commit_push(target_rel: Path, title: str, *, push: bool) -> None:
    subprocess.run(["git", "add", str(target_rel)], cwd=ROOT, check=True)
    msg = f"publish: {title}"
    subprocess.run(["git", "commit", "-m", msg], cwd=ROOT, check=True)
    print(f"  committed: {msg}")
    if push:
        subprocess.run(["git", "push"], cwd=ROOT, check=True)
        print("  pushed; 4EVERLAND will rebuild in ~60-90s")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Publish a skill output to pai.ink in one shot.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("skill_output_dir", help="Path to the skill's output dir for this run")
    ap.add_argument("--zone", required=True, choices=("finance", "web3"))
    ap.add_argument("--title", required=True)
    ap.add_argument("--subtitle")
    ap.add_argument("--tag", action="append", help="Repeatable")
    ap.add_argument("--language", default="zh-CN")
    ap.add_argument("--slug", help="Override the auto-derived slug")
    ap.add_argument("--note", help="reproducibility_note for the manifest")

    ap.add_argument("--skill-name", default="Anamnesis Research")
    ap.add_argument("--skill-repo", default=os.environ.get("PAI_SKILL_REPO"))
    ap.add_argument("--skill-commit", default=os.environ.get("PAI_SKILL_COMMIT"))

    ap.add_argument("--model", default="claude-opus-4-7")
    ap.add_argument("--harness", default="claude-code-cli")
    ap.add_argument("--started-at")
    ap.add_argument("--finished-at")

    ap.add_argument("--github", default=os.environ.get("PAI_GITHUB", "pppop00"))
    ap.add_argument("--display-name", default=os.environ.get("PAI_DISPLAY_NAME", "Zelong"))

    ap.add_argument("--no-sign", action="store_true")
    ap.add_argument("--no-commit", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--no-cards", action="store_true",
                    help="Publish HTML only; skip the cards/ subdir")
    ap.add_argument("--force", action="store_true",
                    help="Overwrite if target slug already exists")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print planned actions without writing")
    args = ap.parse_args()

    skill_dir = Path(args.skill_output_dir).resolve()
    if not skill_dir.is_dir():
        sys.stderr.write(f"not a directory: {skill_dir}\n")
        return 2

    html_src = _find_article_html(skill_dir)
    if not html_src:
        sys.stderr.write(f"no article HTML found in {skill_dir} "
                         "(looked for research/*.html and *.html)\n")
        return 2

    slug = args.slug or _slug_from_dir(skill_dir.name)
    target_rel = Path("content") / args.zone / slug
    target_dir = ROOT / target_rel
    if target_dir.exists() and not args.force:
        sys.stderr.write(f"already published: {target_rel} (use --force to overwrite)\n")
        return 2

    print(f"PUBLISH")
    print(f"  skill output: {skill_dir}")
    print(f"  article html: {html_src.relative_to(skill_dir)}")
    print(f"  slug:         {slug}")
    print(f"  target:       {target_rel}")
    print(f"  zone:         {args.zone}")
    print(f"  title:        {args.title}")

    repo_url = args.skill_repo
    repo_commit = args.skill_commit
    if not repo_url or not repo_commit:
        det_url, det_commit = _detect_skill_git(skill_dir)
        if not repo_url:
            repo_url = det_url
        if not repo_commit:
            repo_commit = det_commit
    if not repo_url:
        print("  WARN: no skill repo URL — pass --skill-repo or set PAI_SKILL_REPO")
        repo_url = "https://github.com/PLACEHOLDER/PLACEHOLDER"
    if not repo_commit:
        print("  WARN: no skill commit hash — pass --skill-commit or commit your skill")
        repo_commit = "0" * 40
    print(f"  skill repo:   {repo_url}")
    print(f"  skill commit: {repo_commit[:12]}{'…' if len(repo_commit) > 12 else ''}")

    if args.dry_run:
        print("\n(dry-run; nothing written)")
        return 0

    print("\ncopying assets:")
    if target_dir.exists():
        shutil.rmtree(target_dir)
    copied = copy_assets(skill_dir, html_src, target_dir, include_cards=not args.no_cards)
    for c in copied:
        print(f"  + {c}")

    print("\nwriting manifest:")
    manifest = build_manifest(args, target_dir=target_dir,
                              repo_url=repo_url, repo_commit=repo_commit)
    manifest_path = target_dir / "ai-audit.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"  wrote {manifest_path.relative_to(ROOT)}")

    if not args.no_sign:
        print("\nsigning:")
        run_sign(manifest_path)

    print("\nverifying (offline):")
    if not run_verify(manifest_path):
        sys.stderr.write("\nverification FAILED — fix the manifest before committing\n")
        return 1

    if args.no_commit:
        print("\n(--no-commit; staged at " + str(target_rel) + " for you to commit manually)")
        return 0

    print("\ngit:")
    git_commit_push(target_rel, args.title, push=not args.no_push)

    print(f"\ndone. live in ~60-90s at:\n  https://www.paiink.com/{args.zone}/{slug}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
