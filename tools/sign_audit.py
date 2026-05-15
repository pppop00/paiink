#!/usr/bin/env python3
"""sign_audit.py — author-side ed25519 signer for ai-audit manifests.

Generate a key once:
    python sign_audit.py keygen --out ~/.pai/ed25519.key

Sign a manifest in place:
    python sign_audit.py sign ~/.pai/ed25519.key path/to/ai-audit.json

The key file is a raw 32-byte ed25519 seed in binary (chmod 600). Keep it
out of git. The corresponding public key is embedded in the manifest under
`signature.public_key` as base64.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import stat
import sys
from pathlib import Path

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )
    from cryptography.hazmat.primitives import serialization
except ImportError:
    sys.stderr.write("missing cryptography. run: pip install -r tools/requirements.txt\n")
    sys.exit(2)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _jcs import canonicalize


def cmd_keygen(args: argparse.Namespace) -> int:
    out = Path(args.out).expanduser()
    if out.exists() and not args.force:
        sys.stderr.write(f"refusing to overwrite {out} (pass --force)\n")
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    seed = secrets.token_bytes(32)
    out.write_bytes(seed)
    os.chmod(out, stat.S_IRUSR | stat.S_IWUSR)  # 0600

    sk = Ed25519PrivateKey.from_private_bytes(seed)
    pk_bytes = sk.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    print(f"wrote private key: {out}")
    print(f"public key (base64, raw): {base64.b64encode(pk_bytes).decode()}")
    print("register this public key against your GitHub identity in a public gist or")
    print("a .pai/keys.json file in your profile repo, so verifiers can pin it.")
    return 0


def _load_private(key_path: Path) -> Ed25519PrivateKey:
    seed = key_path.read_bytes()
    if len(seed) != 32:
        raise ValueError(f"expected 32-byte raw ed25519 seed, got {len(seed)} bytes")
    return Ed25519PrivateKey.from_private_bytes(seed)


def cmd_sign(args: argparse.Namespace) -> int:
    key_path = Path(args.key).expanduser()
    manifest_path = Path(args.manifest)
    if not key_path.is_file():
        sys.stderr.write(f"key not found: {key_path}\n")
        return 1
    if not manifest_path.is_file():
        sys.stderr.write(f"manifest not found: {manifest_path}\n")
        return 1
    sk = _load_private(key_path)
    pk_bytes = sk.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    manifest = json.loads(manifest_path.read_text())
    manifest.pop("signature", None)
    manifest.pop("verifier", None)
    payload = canonicalize(manifest)
    sig = sk.sign(payload)
    manifest["signature"] = {
        "alg": "ed25519",
        "public_key": base64.b64encode(pk_bytes).decode(),
        "sig": base64.b64encode(sig).decode(),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"signed {manifest_path}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="ed25519 signer for ai-audit manifests")
    sub = ap.add_subparsers(dest="cmd", required=True)

    kg = sub.add_parser("keygen", help="Generate a fresh ed25519 keypair")
    kg.add_argument("--out", default="~/.pai/ed25519.key")
    kg.add_argument("--force", action="store_true")
    kg.set_defaults(fn=cmd_keygen)

    sg = sub.add_parser("sign", help="Sign a manifest in place")
    sg.add_argument("key", help="Path to private key file")
    sg.add_argument("manifest", help="Path to ai-audit.json")
    sg.set_defaults(fn=cmd_sign)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
