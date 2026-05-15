#!/usr/bin/env python3
"""tools/unpublish.py — symmetric counterpart to publish.py.

Removes an article from www.paiink.com. The article goes 404 on the live
site after the CDN rebuilds (~60-90 s after push), but immutable IPFS
historical snapshots remain reachable on per-deploy CIDs — historical
content is append-only. If you genuinely need to scrub a file from IPFS,
that's a different (harder) operation; see README.

Usage:
    python3 tools/unpublish.py <zone>/<slug>
    python3 tools/unpublish.py finance/china-general-nuclear-power-2026-05-13

Or with explicit args:
    python3 tools/unpublish.py --zone finance --slug china-general-nuclear-power-2026-05-13

Flags:
    --reason "<text>"   Free-text reason; goes in the commit message.
    --no-commit         Stop after rm.
    --no-push           Commit but don't push.
    --dry-run           Print plan without writing.
    --yes               Skip the confirmation prompt.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
ZONES = ("finance", "web3")


def _parse_target(arg: str) -> tuple[str, str]:
    """Accept 'zone/slug' or just 'slug' (if unambiguous)."""
    if "/" in arg:
        zone, slug = arg.split("/", 1)
        return zone, slug
    # Try to disambiguate
    candidates = []
    for z in ZONES:
        if (CONTENT / z / arg).is_dir():
            candidates.append((z, arg))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        sys.exit(f"no zone/slug matches '{arg}'. Try one of:\n  " + "\n  ".join(
            f"{z}/{p.name}" for z in ZONES for p in (CONTENT / z).iterdir() if p.is_dir()
        ))
    sys.exit(f"ambiguous slug '{arg}' — also exists in: " + ", ".join(z for z, _ in candidates) +
             ". Pass <zone>/<slug> explicitly.")


def _read_title(target_dir: Path) -> str:
    m = target_dir / "ai-audit.json"
    if not m.is_file():
        return target_dir.name
    try:
        return json.loads(m.read_text()).get("article", {}).get("title", target_dir.name)
    except (json.JSONDecodeError, OSError):
        return target_dir.name


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Unpublish an article from pai.ink",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("target", nargs="?", help="<zone>/<slug> or just <slug>")
    ap.add_argument("--zone", choices=ZONES)
    ap.add_argument("--slug")
    ap.add_argument("--reason", help="Reason appended to the commit message")
    ap.add_argument("--no-commit", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", "-y", action="store_true",
                    help="Skip the confirmation prompt")
    args = ap.parse_args()

    if args.zone and args.slug:
        zone, slug = args.zone, args.slug
    elif args.target:
        zone, slug = _parse_target(args.target)
    else:
        ap.error("provide <zone>/<slug> or --zone + --slug")

    if zone not in ZONES:
        sys.exit(f"unknown zone: {zone!r}. Valid: {ZONES}")

    target_dir = CONTENT / zone / slug
    if not target_dir.is_dir():
        sys.exit(f"not found: {target_dir.relative_to(ROOT)}")

    title = _read_title(target_dir)
    rel = target_dir.relative_to(ROOT)

    print(f"UNPUBLISH")
    print(f"  target:    {rel}")
    print(f"  zone:      {zone}")
    print(f"  slug:      {slug}")
    print(f"  title:     {title}")
    print(f"  reason:    {args.reason or '(none)'}")
    print()
    print("  Live URL will 404 ~60-90s after push.")
    print("  Historical IPFS CIDs remain reachable on per-deploy subdomains.")

    if args.dry_run:
        print("\n(dry-run; nothing removed)")
        return 0

    if not args.yes:
        confirm = input("\nProceed? [y/N] ").strip().lower()
        if confirm not in ("y", "yes"):
            print("aborted.")
            return 1

    shutil.rmtree(target_dir)
    print(f"\nremoved {rel}")

    if args.no_commit:
        print(f"(--no-commit; stage and commit yourself when ready)")
        return 0

    subprocess.run(["git", "add", "-A", str(rel.parent)], cwd=ROOT, check=True)
    msg = f"unpublish: {title}"
    if args.reason:
        msg += f"\n\n{args.reason}"
    subprocess.run(["git", "commit", "-m", msg], cwd=ROOT, check=True)
    print(f"committed: unpublish: {title}")

    if args.no_push:
        return 0

    subprocess.run(["git", "push"], cwd=ROOT, check=True)
    print("pushed; 4EVERLAND will rebuild in ~60-90s and the article will 404")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
