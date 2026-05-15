#!/usr/bin/env python3
"""verify_audit.py — validate an ai-audit/v1 manifest.

Usage:
    python verify_audit.py <path-to-ai-audit.json>
    python verify_audit.py --pr-author <github-login> <path>
    python verify_audit.py --offline <path>     # skip network checks
    python verify_audit.py --emit-verifier <path>  # rewrite file with verifier block

Exit codes:
    0  all required checks passed
    1  one or more checks failed
    2  bad invocation / unreadable input

Designed to be:
    - the single source of truth for what "valid" means
    - usable both in GitHub Actions and as a local CLI
    - boring and dependency-light

Pinned constants:
    PINNED_AGREEMENT_HASHES maps each known publishing-agreement version to
    the canonical SHA-256 of its markdown file. The `agreement_hash_pinned`
    check rejects any manifest whose `agreement.sha256` doesn't match the
    pinned value for its `agreement.version`. Add a new entry here when
    rolling a v2 agreement; never edit an existing one.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any

# Third-party deps. Install via tools/requirements.txt.
try:
    import jsonschema
    import requests
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.hazmat.primitives.serialization import load_der_public_key
except ImportError as e:  # pragma: no cover
    sys.stderr.write(f"missing dependency: {e}\n")
    sys.stderr.write("run: pip install -r tools/requirements.txt\n")
    sys.exit(2)

from _jcs import canonicalize


VERIFIER_VERSION = "1.1.0"
SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "ai-audit" / "v1.json"

# Pinned SHA-256 hashes of each published agreement version. The canonical
# v1 markdown lives at content/_meta/agreement-v1.md. Append-only: never
# mutate an existing entry, even to fix a typo — ship a new version instead.
AGREEMENT_V1_SHA256 = "d89b0a30554743958e704b4d825966fad2eb22b6399bc00d0a15809f8deed807"
AGREEMENT_V2_SHA256 = "ec4066647aad291af1e7e88387b3dbfea8c63fce13da3e5ba64f11299793a19d"
PINNED_AGREEMENT_HASHES: dict[str, str] = {
    "v1": AGREEMENT_V1_SHA256,
    "v2": AGREEMENT_V2_SHA256,
}

# Allowed values for article.license. Kept in sync with the enum in
# schemas/ai-audit/v1.json. ARR = All Rights Reserved.
ALLOWED_LICENSES: frozenset[str] = frozenset(
    {"CC-BY-NC-4.0", "CC-BY-4.0", "CC0-1.0", "ARR"}
)


# ---------- result tracking ----------

class Result:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.warned: list[str] = []
        self.failed: list[tuple[str, str]] = []  # (check, message)

    def ok(self, name: str) -> None:
        self.passed.append(name)

    def warn(self, name: str, msg: str) -> None:
        self.warned.append(f"{name}: {msg}")

    def fail(self, name: str, msg: str) -> None:
        self.failed.append((name, msg))

    @property
    def green(self) -> bool:
        return not self.failed


# ---------- individual checks ----------

def check_schema(manifest: dict, result: Result) -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    try:
        jsonschema.Draft202012Validator(schema).validate(manifest)
        result.ok("schema_valid")
    except jsonschema.ValidationError as e:
        result.fail("schema_valid", f"{e.message} at /{'/'.join(map(str, e.absolute_path))}")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def check_content_hash(manifest: dict, manifest_dir: Path, result: Result) -> None:
    article = manifest.get("article", {})
    rel = article.get("content_path")
    expected = article.get("content_sha256")
    if not rel or not expected:
        result.fail("content_hash_match", "missing content_path or content_sha256")
        return
    target = (manifest_dir / rel).resolve()
    try:
        target.relative_to(manifest_dir.resolve())
    except ValueError:
        result.fail("content_hash_match", f"content_path escapes manifest dir: {rel}")
        return
    if not target.is_file():
        result.fail("content_hash_match", f"file not found: {rel}")
        return
    actual = _sha256_file(target)
    if actual != expected.lower():
        result.fail("content_hash_match", f"hash mismatch: expected {expected}, got {actual}")
        return
    result.ok("content_hash_match")


def check_assets(manifest: dict, manifest_dir: Path, result: Result) -> None:
    assets = manifest.get("article", {}).get("assets") or []
    if not assets:
        result.ok("assets_hash_match")  # vacuously true
        return
    bad: list[str] = []
    for a in assets:
        rel = a.get("path")
        expected = a.get("sha256")
        target = (manifest_dir / rel).resolve()
        try:
            target.relative_to(manifest_dir.resolve())
        except ValueError:
            bad.append(f"{rel}: path escapes manifest dir")
            continue
        if not target.is_file():
            bad.append(f"{rel}: not found")
            continue
        actual = _sha256_file(target)
        if actual != expected.lower():
            bad.append(f"{rel}: expected {expected}, got {actual}")
    if bad:
        result.fail("assets_hash_match", "; ".join(bad))
    else:
        result.ok("assets_hash_match")


_SUPPORTED_HOSTS = {
    "github.com": "github",
    "gitlab.com": "gitlab",
    "codeberg.org": "gitea",
    "bitbucket.org": "bitbucket",
}


def _parse_git_url(url: str) -> tuple[str, str, str] | None:
    """Return (host_kind, owner, repo) or None if unsupported."""
    p = urllib.parse.urlparse(url)
    kind = _SUPPORTED_HOSTS.get(p.netloc)
    if not kind:
        return None
    parts = [x for x in p.path.strip("/").split("/") if x]
    if len(parts) < 2:
        return None
    owner, repo = parts[0], parts[1].removesuffix(".git")
    return kind, owner, repo


def check_skill_repo_public(manifest: dict, result: Result, *, offline: bool) -> None:
    repo_url = manifest.get("skill", {}).get("repo_url", "")
    parsed = _parse_git_url(repo_url)
    if not parsed:
        result.fail("skill_repo_public", f"unsupported host or malformed URL: {repo_url}")
        return
    if offline:
        result.warn("skill_repo_public", "skipped (--offline)")
        return
    try:
        r = requests.head(repo_url, allow_redirects=True, timeout=10)
        if r.status_code >= 400:
            result.fail("skill_repo_public", f"{repo_url} returned {r.status_code}")
            return
        result.ok("skill_repo_public")
    except requests.RequestException as e:
        result.fail("skill_repo_public", f"network error: {e}")


def check_skill_commit(manifest: dict, result: Result, *, offline: bool) -> None:
    skill = manifest.get("skill", {})
    repo_url = skill.get("repo_url", "")
    commit = (skill.get("repo_commit") or "").lower()
    if not re.fullmatch(r"[0-9a-f]{7,40}", commit):
        result.fail("skill_commit_exists", "malformed commit hash")
        return
    if offline:
        result.warn("skill_commit_exists", "skipped (--offline)")
        return
    parsed = _parse_git_url(repo_url)
    if not parsed:
        result.fail("skill_commit_exists", "unparseable repo URL")
        return
    kind, owner, repo = parsed
    # Probe via host-specific API; fall back to a raw commit URL HEAD.
    probe_urls: list[str] = []
    if kind == "github":
        probe_urls.append(f"https://api.github.com/repos/{owner}/{repo}/commits/{commit}")
        probe_urls.append(f"https://github.com/{owner}/{repo}/commit/{commit}")
    elif kind == "gitlab":
        probe_urls.append(f"https://gitlab.com/api/v4/projects/{owner}%2F{repo}/repository/commits/{commit}")
    elif kind == "gitea":
        probe_urls.append(f"https://codeberg.org/api/v1/repos/{owner}/{repo}/git/commits/{commit}")
    elif kind == "bitbucket":
        probe_urls.append(f"https://api.bitbucket.org/2.0/repositories/{owner}/{repo}/commit/{commit}")

    last_err = ""
    for url in probe_urls:
        try:
            r = requests.get(url, timeout=10, headers={"Accept": "application/json"})
            if r.status_code == 200:
                result.ok("skill_commit_exists")
                return
            last_err = f"{url} -> {r.status_code}"
        except requests.RequestException as e:
            last_err = f"{url} -> {e}"
    result.fail("skill_commit_exists", last_err or "no probe succeeded")


def check_skill_md_hash(manifest: dict, result: Result, *, offline: bool) -> None:
    skill = manifest.get("skill", {})
    expected = skill.get("skill_md_sha256")
    if not expected:
        result.warn("skill_md_hash_match", "skipped (optional field absent)")
        return
    if offline:
        result.warn("skill_md_hash_match", "skipped (--offline)")
        return
    repo_url = skill.get("repo_url", "")
    commit = skill.get("repo_commit", "")
    entry = skill.get("entry_file") or "SKILL.md"
    parsed = _parse_git_url(repo_url)
    if not parsed:
        result.fail("skill_md_hash_match", "unparseable repo URL")
        return
    kind, owner, repo = parsed
    if kind == "github":
        raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{commit}/{entry}"
    elif kind == "gitlab":
        raw = f"https://gitlab.com/{owner}/{repo}/-/raw/{commit}/{entry}"
    elif kind == "gitea":
        raw = f"https://codeberg.org/{owner}/{repo}/raw/commit/{commit}/{entry}"
    elif kind == "bitbucket":
        raw = f"https://bitbucket.org/{owner}/{repo}/raw/{commit}/{entry}"
    else:
        result.fail("skill_md_hash_match", f"no raw URL builder for host kind {kind}")
        return
    try:
        r = requests.get(raw, timeout=10)
        if r.status_code != 200:
            result.fail("skill_md_hash_match", f"{raw} -> {r.status_code}")
            return
        actual = hashlib.sha256(r.content).hexdigest()
        if actual != expected.lower():
            result.fail("skill_md_hash_match", f"expected {expected}, got {actual}")
            return
        result.ok("skill_md_hash_match")
    except requests.RequestException as e:
        result.fail("skill_md_hash_match", f"network error: {e}")


def _ed25519_pubkey_from_b64(b64: str) -> Ed25519PublicKey:
    """Accept either a 32-byte raw key or a DER SubjectPublicKeyInfo, both base64."""
    raw = base64.b64decode(b64, validate=True)
    if len(raw) == 32:
        return Ed25519PublicKey.from_public_bytes(raw)
    # Try DER
    key = load_der_public_key(raw)
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("public key is not ed25519")
    return key


def check_signature(manifest: dict, result: Result) -> None:
    sig_block = manifest.get("signature")
    if not sig_block:
        result.warn("signature_valid", "no signature present (optional)")
        return
    if sig_block.get("alg") != "ed25519":
        result.fail("signature_valid", f"unsupported alg: {sig_block.get('alg')}")
        return
    try:
        pub = _ed25519_pubkey_from_b64(sig_block["public_key"])
        sig = base64.b64decode(sig_block["sig"], validate=True)
    except Exception as e:
        result.fail("signature_valid", f"malformed signature/key: {e}")
        return
    payload_obj = {k: v for k, v in manifest.items() if k not in ("signature", "verifier")}
    payload = canonicalize(payload_obj)
    try:
        pub.verify(sig, payload)
        result.ok("signature_valid")
    except InvalidSignature:
        result.fail("signature_valid", "ed25519 verify failed")


def check_github_oauth_match(manifest: dict, result: Result, *, pr_author: str | None) -> None:
    # Legacy check from the PR-submission era. The web-upload flow (v2+) does
    # not use GitHub identity at all; author.github is optional. We keep this
    # check around as a no-op warn for backwards compat — it only does
    # anything when --pr-author is supplied AND the manifest has author.github.
    claimed = manifest.get("author", {}).get("github", "")
    if pr_author is None:
        if claimed:
            result.warn("github_oauth_match", "skipped (no --pr-author given; CLI mode)")
        else:
            result.warn("github_oauth_match", "skipped (no author.github; v2+ web-upload manifest)")
        return
    if not claimed:
        result.warn("github_oauth_match", f"--pr-author given as {pr_author!r} but manifest has no author.github")
        return
    if claimed.lower() == pr_author.lower():
        result.ok("github_oauth_match")
    else:
        result.fail("github_oauth_match", f"PR opened by {pr_author!r}, manifest claims {claimed!r}")


def check_agreement_hash_pinned(manifest: dict, result: Result) -> None:
    """Verify the agreement block (if present) matches the pinned hash for
    its version. Legacy manifests with no agreement block produce a warning."""
    agreement = manifest.get("agreement")
    if not agreement:
        result.warn("agreement_hash_pinned", "no agreement (legacy manifest)")
        return
    version = agreement.get("version")
    claimed_hash = (agreement.get("sha256") or "").lower()
    if not version:
        result.fail("agreement_hash_pinned", "agreement.version missing")
        return
    pinned = PINNED_AGREEMENT_HASHES.get(version)
    if pinned is None:
        result.fail(
            "agreement_hash_pinned",
            f"unknown agreement version {version!r}; "
            f"known versions: {sorted(PINNED_AGREEMENT_HASHES)}",
        )
        return
    if claimed_hash != pinned:
        result.fail(
            "agreement_hash_pinned",
            f"agreement.sha256 for {version!r} does not match pinned hash: "
            f"expected {pinned}, got {claimed_hash or '<empty>'}",
        )
        return
    result.ok("agreement_hash_pinned")


def check_license_valid(manifest: dict, result: Result) -> None:
    """Verify article.license (if present) is in the allowed enum.
    Absent license yields a warning to keep legacy manifests passing."""
    license_value = manifest.get("article", {}).get("license")
    if license_value is None:
        result.warn("license_valid", "no license declared (legacy manifest)")
        return
    if license_value not in ALLOWED_LICENSES:
        result.fail(
            "license_valid",
            f"license {license_value!r} not in allowed set: "
            f"{sorted(ALLOWED_LICENSES)}",
        )
        return
    result.ok("license_valid")


# ---------- driver ----------

def verify(manifest_path: Path, *, pr_author: str | None, offline: bool) -> Result:
    result = Result()
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as e:
        result.fail("schema_valid", f"invalid JSON: {e}")
        return result

    manifest_dir = manifest_path.parent

    check_schema(manifest, result)
    if not result.green:
        return result  # don't bother with the rest if schema is broken

    check_content_hash(manifest, manifest_dir, result)
    check_assets(manifest, manifest_dir, result)
    check_skill_repo_public(manifest, result, offline=offline)
    check_skill_commit(manifest, result, offline=offline)
    check_skill_md_hash(manifest, result, offline=offline)
    check_signature(manifest, result)
    check_github_oauth_match(manifest, result, pr_author=pr_author)
    check_agreement_hash_pinned(manifest, result)
    check_license_valid(manifest, result)
    return result


def emit_verifier_block(manifest_path: Path, result: Result) -> None:
    manifest = json.loads(manifest_path.read_text())
    manifest["verifier"] = {
        "verified_at": dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z"),
        "verifier_version": VERIFIER_VERSION,
        "checks_passed": result.passed,
        "checks_warned": result.warned,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Validate an ai-audit/v1 manifest. Runs schema, content-hash, "
            "asset-hash, skill-repo, skill-commit, skill-md-hash, signature, "
            "github-oauth, agreement-hash-pinned, and license checks."
        )
    )
    ap.add_argument("manifest", type=Path, help="Path to ai-audit.json")
    ap.add_argument("--pr-author", help="GitHub login of the PR opener (CI sets this)")
    ap.add_argument("--offline", action="store_true", help="Skip all network checks")
    ap.add_argument("--emit-verifier", action="store_true",
                    help="On success, rewrite the manifest with a verifier{} block")
    ap.add_argument("--json", action="store_true", help="Emit machine-readable result")
    args = ap.parse_args()

    if not args.manifest.is_file():
        sys.stderr.write(f"not a file: {args.manifest}\n")
        return 2

    result = verify(args.manifest, pr_author=args.pr_author, offline=args.offline)

    if args.json:
        print(json.dumps({
            "green": result.green,
            "passed": result.passed,
            "warned": result.warned,
            "failed": [{"check": c, "message": m} for c, m in result.failed],
        }, indent=2))
    else:
        print(f"manifest: {args.manifest}")
        for c in result.passed:
            print(f"  ok    {c}")
        for w in result.warned:
            print(f"  warn  {w}")
        for c, m in result.failed:
            print(f"  FAIL  {c}: {m}")
        print(f"result: {'PASS' if result.green else 'FAIL'}")

    if result.green and args.emit_verifier:
        emit_verifier_block(args.manifest, result)

    return 0 if result.green else 1


if __name__ == "__main__":
    raise SystemExit(main())
