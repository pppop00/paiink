#!/usr/bin/env python3
"""
migrate_to_d1.py — one-shot migration of pre-existing GitHub-tracked
content into Cloudflare D1 + R2.

Produces two artifacts:
  - tools/migrate.sql : INSERT statements for the `users` and `articles`
    tables. Run with:
        wrangler d1 execute paiink --file tools/migrate.sql
  - tools/migrate.sh  : `wrangler r2 object put ...` invocations that
    upload article bytes (HTML + manifest), the two pinned agreement
    markdown files, and the schema mirror. Run with:
        bash tools/migrate.sh

The script does NOT execute anything itself — it only writes those two
files. The user is expected to inspect them before applying.

Design notes
------------
* The article's manifest bytes on R2 must round-trip sha256-identical to
  what's in content/<zone>/<slug>/ai-audit.json today. We DO NOT
  regenerate the manifest; the file is uploaded as-is via `r2 object put`.
* D1's `articles.uuid` column reuses the existing manifest's
  `article.id` (a UUID v4 string) so /verify/<uuid> URLs minted before
  the migration keep working. New articles (Phase A+) get a fresh ULID.
* Three of the four legacy manifests pre-date agreement v2 and lack the
  `agreement` block + `license` + `published_at`. We synthesize:
    - agreement_version = "v1", agreement_sha256 = pinned v1 hash
    - license           = "CC-BY-NC-4.0" (the default)
    - published_at      = parsed from the slug's date suffix
  None of these synthesized values are written back to the manifest on
  R2 — they live only in the D1 row, which is reasonable because D1 is
  derived state. The manifest itself is the immutable source of truth.

Founder user (id=1):
  email        = oliverun6@gmail.com
  display_name = Zelong
  handle       = zelong
  ui_lang      = zh-CN
  password_hash = NULL  (Phase B signup will claim it via the same email)
  created_at    = earliest article published_at
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import shlex
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTENT_DIR = REPO_ROOT / "content"
META_DIR = CONTENT_DIR / "_meta"
SCHEMA_PATH = REPO_ROOT / "schemas" / "ai-audit" / "v1.json"
OUTPUT_SQL = REPO_ROOT / "tools" / "migrate.sql"
OUTPUT_SH = REPO_ROOT / "tools" / "migrate.sh"
R2_BUCKET = "paiink-content"

AGREEMENT_V1_SHA256 = "d89b0a30554743958e704b4d825966fad2eb22b6399bc00d0a15809f8deed807"
AGREEMENT_V2_SHA256 = "ec4066647aad291af1e7e88387b3dbfea8c63fce13da3e5ba64f11299793a19d"

PINNED_HASHES = {
    "v1": AGREEMENT_V1_SHA256,
    "v2": AGREEMENT_V2_SHA256,
}

DEFAULT_LICENSE = "CC-BY-NC-4.0"

FOUNDER = {
    "email": "oliverun6@gmail.com",
    "display_name": "Zelong",
    "handle": "zelong",
    "ui_lang": "zh-CN",
}

SLUG_DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})$")


def sql_escape(value: str | None) -> str:
    """Render a Python string as a SQLite literal."""
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def sql_int(value: int | None) -> str:
    if value is None:
        return "NULL"
    return str(int(value))


def iso_to_epoch(value: str) -> int:
    """Parse ISO 8601 (possibly with trailing Z) to integer unix seconds."""
    cleaned = value.replace("Z", "+00:00")
    return int(dt.datetime.fromisoformat(cleaned).timestamp())


def slug_to_published_at(slug: str) -> int:
    """Fallback for v1 manifests: derive epoch from -YYYY-MM-DD suffix."""
    m = SLUG_DATE_RE.search(slug)
    if not m:
        raise RuntimeError(f"slug {slug!r} has no -YYYY-MM-DD date suffix")
    y, mo, d = (int(x) for x in m.groups())
    return int(dt.datetime(y, mo, d, 12, 0, 0, tzinfo=dt.timezone.utc).timestamp())


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def discover_articles() -> list[dict]:
    """Walk content/<zone>/<slug>/ and yield manifest+slug+zone for each."""
    rows: list[dict] = []
    for zone_dir in sorted(p for p in CONTENT_DIR.iterdir() if p.is_dir() and not p.name.startswith("_")):
        zone = zone_dir.name
        for slug_dir in sorted(p for p in zone_dir.iterdir() if p.is_dir()):
            slug = slug_dir.name
            manifest_path = slug_dir / "ai-audit.json"
            html_path = slug_dir / "index.html"
            if not manifest_path.exists() or not html_path.exists():
                continue
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            rows.append(
                {
                    "zone": zone,
                    "slug": slug,
                    "manifest": manifest,
                    "manifest_path": manifest_path,
                    "html_path": html_path,
                }
            )
    return rows


def normalize_article(row: dict) -> dict:
    """Map a manifest + filesystem entry into the canonical D1 article row."""
    manifest = row["manifest"]
    article = manifest["article"]
    skill = manifest.get("skill", {})
    generation = manifest.get("generation", {})
    author = manifest.get("author", {})
    agreement = manifest.get("agreement")

    if agreement:
        agreement_version = agreement["version"]
        agreement_sha256 = agreement["sha256"]
        accepted_at = agreement.get("accepted_at")
        # Trust the manifest's pinned hash even if PINNED_HASHES disagrees;
        # the verifier owns hash policy.
    else:
        # v1-era manifest, predates the agreement block.
        agreement_version = "v1"
        agreement_sha256 = AGREEMENT_V1_SHA256
        accepted_at = None

    published_at_iso = article.get("published_at")
    if published_at_iso:
        published_at = iso_to_epoch(published_at_iso)
    else:
        # Fallback: parse the date out of the slug suffix.
        published_at = slug_to_published_at(row["slug"])

    finished_at_iso = generation.get("finished_at")
    if finished_at_iso:
        finished_at = iso_to_epoch(finished_at_iso)
    else:
        finished_at = published_at

    license_ = article.get("license", DEFAULT_LICENSE)

    # Sanity: content_sha256 must match the bytes we're about to upload.
    on_disk = file_sha256(row["html_path"])
    if on_disk != article["content_sha256"]:
        raise RuntimeError(
            f"{row['slug']}: manifest content_sha256 {article['content_sha256']!r} "
            f"does not match index.html sha256 {on_disk!r} — refuse to migrate"
        )

    return {
        "uuid": article["id"],
        "zone": article.get("category", row["zone"]),
        "slug": row["slug"],
        "language": article["language"],
        "title": article["title"],
        "author_email": author.get("email") or FOUNDER["email"],
        "author_display_name": author.get("display_name") or FOUNDER["display_name"],
        "content_sha256": article["content_sha256"],
        "word_count": int(article.get("word_count", 0)),
        "license": license_,
        "agreement_version": agreement_version,
        "agreement_sha256": agreement_sha256,
        "skill_name": skill.get("name", ""),
        "skill_repo_url": skill.get("repo_url", ""),
        "skill_repo_commit": skill.get("repo_commit", ""),
        "model": generation.get("model", ""),
        "harness": generation.get("harness", ""),
        "api_request_id": generation.get("api_request_id"),
        "finished_at": finished_at,
        "published_at": published_at,
        "accepted_at": accepted_at,  # not stored in D1 directly, kept for reference
        "html_path": row["html_path"],
        "manifest_path": row["manifest_path"],
    }


def build_sql(articles: list[dict], founder_created_at: int) -> str:
    lines: list[str] = []
    lines.append("-- migrate.sql — apply with `wrangler d1 execute paiink --file tools/migrate.sql`")
    lines.append("-- Generated by tools/migrate_to_d1.py — do not hand-edit; rerun the generator.")
    lines.append("")
    lines.append("BEGIN TRANSACTION;")
    lines.append("")
    lines.append("-- Founder user. password_hash NULL means \"unclaimed\"; Phase B signup will set it.")
    lines.append(
        "INSERT INTO users (id, email, password_hash, display_name, handle, ui_lang, created_at) VALUES "
        f"(1, {sql_escape(FOUNDER['email'])}, NULL, {sql_escape(FOUNDER['display_name'])}, "
        f"{sql_escape(FOUNDER['handle'])}, {sql_escape(FOUNDER['ui_lang'])}, {founder_created_at});"
    )
    lines.append("")
    lines.append("-- Articles (author_id=1 — all current content is Zelong's).")
    for a in articles:
        lines.append(
            "INSERT INTO articles (\n"
            "  uuid, zone, slug, language, title, author_id, author_email,\n"
            "  author_display_name, content_sha256, word_count, license,\n"
            "  agreement_version, agreement_sha256, skill_name, skill_repo_url,\n"
            "  skill_repo_commit, model, harness, api_request_id, finished_at,\n"
            "  published_at\n"
            ") VALUES (\n"
            f"  {sql_escape(a['uuid'])},\n"
            f"  {sql_escape(a['zone'])},\n"
            f"  {sql_escape(a['slug'])},\n"
            f"  {sql_escape(a['language'])},\n"
            f"  {sql_escape(a['title'])},\n"
            "  1,\n"
            f"  {sql_escape(a['author_email'])},\n"
            f"  {sql_escape(a['author_display_name'])},\n"
            f"  {sql_escape(a['content_sha256'])},\n"
            f"  {sql_int(a['word_count'])},\n"
            f"  {sql_escape(a['license'])},\n"
            f"  {sql_escape(a['agreement_version'])},\n"
            f"  {sql_escape(a['agreement_sha256'])},\n"
            f"  {sql_escape(a['skill_name'])},\n"
            f"  {sql_escape(a['skill_repo_url'])},\n"
            f"  {sql_escape(a['skill_repo_commit'])},\n"
            f"  {sql_escape(a['model'])},\n"
            f"  {sql_escape(a['harness'])},\n"
            f"  {sql_escape(a['api_request_id'])},\n"
            f"  {sql_int(a['finished_at'])},\n"
            f"  {sql_int(a['published_at'])}\n"
            ");"
        )
        lines.append("")
    lines.append("COMMIT;")
    lines.append("")
    return "\n".join(lines)


def build_shell(articles: list[dict]) -> str:
    rel = lambda p: shlex.quote(str(p.relative_to(REPO_ROOT)))
    lines: list[str] = []
    lines.append("#!/usr/bin/env bash")
    lines.append("# migrate.sh — apply with `bash tools/migrate.sh`")
    lines.append("# Generated by tools/migrate_to_d1.py — do not hand-edit; rerun the generator.")
    lines.append("#")
    lines.append("# Uploads existing article bytes (HTML + manifest), pinned agreement")
    lines.append("# markdown for v1 and v2, and the v1 schema mirror into the paiink-content")
    lines.append("# R2 bucket. Run from the repo root.")
    lines.append("set -euo pipefail")
    lines.append("")
    lines.append("cd \"$(dirname \"$0\")/..\"")
    lines.append("")
    lines.append("echo '== uploading articles =='")
    for a in articles:
        uuid = a["uuid"]
        lines.append(f"echo '  -> {a['zone']}/{a['slug']} (uuid {uuid})'")
        lines.append(
            f"wrangler r2 object put {R2_BUCKET}/articles/{uuid}/index.html "
            f"--file {rel(a['html_path'])} "
            f"--content-type 'text/html; charset=utf-8'"
        )
        lines.append(
            f"wrangler r2 object put {R2_BUCKET}/articles/{uuid}/ai-audit.json "
            f"--file {rel(a['manifest_path'])} "
            f"--content-type 'application/json; charset=utf-8'"
        )
    lines.append("")
    lines.append("echo '== uploading agreements =='")
    lines.append(
        f"wrangler r2 object put {R2_BUCKET}/agreements/agreement-v1.md "
        f"--file content/_meta/agreement-v1.md "
        f"--content-type 'text/markdown; charset=utf-8'"
    )
    lines.append(
        f"wrangler r2 object put {R2_BUCKET}/agreements/agreement-v2.md "
        f"--file content/_meta/agreement-v2.md "
        f"--content-type 'text/markdown; charset=utf-8'"
    )
    lines.append("")
    lines.append("echo '== uploading schema mirror =='")
    lines.append(
        f"wrangler r2 object put {R2_BUCKET}/schemas/ai-audit/v1.json "
        f"--file schemas/ai-audit/v1.json "
        f"--content-type 'application/json; charset=utf-8'"
    )
    lines.append("")
    lines.append("echo '== done =='")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    if not CONTENT_DIR.exists():
        print(f"FATAL: {CONTENT_DIR} not found", file=sys.stderr)
        return 1
    for must in [META_DIR / "agreement-v1.md", META_DIR / "agreement-v2.md", SCHEMA_PATH]:
        if not must.exists():
            print(f"FATAL: required input missing: {must}", file=sys.stderr)
            return 1

    rows = discover_articles()
    if not rows:
        print("WARN: no articles found under content/", file=sys.stderr)
        return 1
    normalized = [normalize_article(r) for r in rows]

    # Sanity: verify each pinned agreement hash matches the file on disk.
    for v, expected in PINNED_HASHES.items():
        actual = file_sha256(META_DIR / f"agreement-{v}.md")
        if actual != expected:
            print(
                f"FATAL: agreement-{v}.md hash mismatch ({actual} vs pinned {expected}) — "
                "did the markdown get edited? Refusing to generate migration.",
                file=sys.stderr,
            )
            return 1

    founder_created_at = min(a["published_at"] for a in normalized)

    OUTPUT_SQL.write_text(build_sql(normalized, founder_created_at), encoding="utf-8")
    OUTPUT_SH.write_text(build_shell(normalized), encoding="utf-8")
    OUTPUT_SH.chmod(0o755)

    print(f"wrote {OUTPUT_SQL} ({len(normalized)} article rows + 1 user row)")
    print(f"wrote {OUTPUT_SH} ({len(normalized) * 2 + 3} R2 uploads)")
    print()
    print("next steps:")
    print("  1. wrangler d1 create paiink        # if not already created")
    print("  2. wrangler d1 execute paiink --file worker/migrations/0001_initial.sql")
    print("  3. wrangler r2 bucket create paiink-content")
    print("  4. bash tools/migrate.sh")
    print("  5. wrangler d1 execute paiink --file tools/migrate.sql")
    return 0


if __name__ == "__main__":
    sys.exit(main())
