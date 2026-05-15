# pai — AI-Written Articles, Verifiably

A bilingual (zh/en) publishing platform for articles produced by AI skills.
Every article ships with an **AI provenance manifest** (`ai-audit.json`) that
ties it to a public skill repository, a specific commit, model, and author
identity. Articles live in two zones today — **Finance** and **Web3** — with
more to come.

- Static site, IPFS-pinned, served via 4EVERLAND's global CDN
- Works in both Mainland China and the US without ICP filing
- Submission via GitHub PR (or direct push for repo owners); validation via GitHub Actions
- Open standard: `ai-audit/v1` JSON Schema (see `schemas/ai-audit/`)

## Live

- Production: [www.paiink.com](https://www.paiink.com)
- Source: https://github.com/pppop00/paiink
- Schema: [`/schemas/ai-audit/v1.json`](./schemas/ai-audit/v1.json) (CC0)

## Repo layout

```
pai/
├── README.md
├── CLAUDE.md                    # Conventions for AI assistants working in this repo
├── schemas/ai-audit/            # The provenance manifest standard
│   ├── v1.json                  # JSON Schema (Draft 2020-12)
│   ├── SPEC.md                  # Human-readable spec
│   └── examples/                # Sample manifests
├── tools/
│   ├── publish.py               # One-shot publisher (see below) ← start here
│   ├── verify_audit.py          # Validator (CI + CLI)
│   ├── sign_audit.py            # ed25519 keygen / sign
│   ├── emit_audit.py            # Manifest scaffolder (publish.py wraps this)
│   ├── probe_latency.py         # TTFB probe (CN/US reachability)
│   └── _jcs.py                  # RFC 8785 JSON canonicalization
├── content/
│   ├── finance/<slug>/          # index.html + ai-audit.json + assets/
│   └── web3/<slug>/
├── site/                        # Static site builder + CSS
│   ├── build.py                 # placeholder builder (Astro arrives in step A)
│   ├── style.css
│   └── favicon.svg
├── docs/
│   ├── DEPLOY.md                # 4EVERLAND + domain playbook
│   └── HOSTING.md               # Why 4EVERLAND, fallback plans
└── .github/workflows/verify.yml # PR-gated manifest validation
```

## Publishing — the one-command path

If your AI skill output sits in some directory and you want it on pai.ink:

```bash
python3 tools/publish.py /path/to/skill/output/<run-dir> \
    --zone finance \
    --title "苹果公司 — 权益研究"
```

That's it. The script:

1. **Finds the article HTML** (knows the anamnesis pattern `research/*_Research_CN.html`; falls back to any `*.html` in the dir).
2. **Derives a clean slug** from the dir name (`Apple_2026-06-15_abc12345` → `apple-2026-06-15`).
3. **Copies HTML and assets** (`cards/*.png` etc.) into `content/<zone>/<slug>/`.
4. **Auto-detects the skill repo URL and commit hash** from the skill's `.git` (no need to pass them).
5. **Generates `ai-audit.json`** with hashes for the article + every asset.
6. **Signs with `~/.pai/ed25519.key`** if you have one (skip with `--no-sign`).
7. **Runs `verify_audit.py --offline`** as a sanity check.
8. **`git add` + commit + push.**
9. Prints the live URL. **4EVERLAND auto-rebuilds in ~60–90 s.**

### Optional flags

| Flag | Default | Notes |
|---|---|---|
| `--subtitle` | — | Dek shown under the title on cards |
| `--tag X` | — | Repeatable, ≤12 tags |
| `--language` | `zh-CN` | BCP-47 tag |
| `--slug` | auto | Override the derived slug |
| `--note` | — | Free text for `reproducibility_note` (declare manual edits, retries) |
| `--skill-name` | `Anamnesis Research` | Override for non-anamnesis skills |
| `--skill-repo` | auto | Defaults to `$PAI_SKILL_REPO` or git-detected |
| `--skill-commit` | auto | Defaults to `$PAI_SKILL_COMMIT` or git-detected |
| `--model` | `claude-opus-4-7` | Model ID |
| `--github` | `$PAI_GITHUB` → `pppop00` | Author GitHub login |
| `--display-name` | `$PAI_DISPLAY_NAME` → `Zelong` | Pen name on the article card |
| `--no-sign` | off | Skip signature step |
| `--no-commit` | off | Stop after writing the manifest |
| `--no-push` | off | Commit but don't push |
| `--force` | off | Overwrite existing slug |
| `--dry-run` | off | Print plan without writing |

### One-time setup (~2 min)

```bash
# Author key (used to sign every future manifest)
python3 tools/sign_audit.py keygen --out ~/.pai/ed25519.key

# Optional: persist defaults to your shell rc
export PAI_GITHUB=pppop00
export PAI_DISPLAY_NAME=Zelong

# Optional: a shell alias for less typing
alias pai-publish='python3 ~/Desktop/Projects/pai/tools/publish.py'
```

The printed public key goes in a public gist as `pai-public-key.txt` so verifiers can pin it to your GitHub identity.

## Unpublishing

Symmetric to publish:

```bash
python3 tools/unpublish.py finance/<slug>
# or
python3 tools/unpublish.py --zone finance --slug <slug> --reason "broken chart"
```

What it does:

1. Removes `content/<zone>/<slug>/`.
2. Commits with `unpublish: <title>` + your reason.
3. Pushes. 4EVERLAND rebuilds in ~60–90s and the live URL goes 404.

**Caveat:** historical IPFS CIDs are immutable. A reader who has an old
deployment-pinned CID can still reach the unpublished article through public
IPFS gateways. If you need to scrub a file from IPFS entirely (because it's
defamatory, contains PII, etc.), that's a different operation — ask the
hosting provider to unpin the CID, and accept that public IPFS gateways may
have already cached it.

Flags: `--dry-run`, `--no-push`, `--no-commit`, `--yes` (skip confirmation).

## Requirements for your skill repo

For a manifest to pass CI, the **skill itself must be on GitHub publicly**:

- `skill.repo_url` must resolve unauthenticated (200 OK).
- `skill.repo_commit` must exist on a branch of that repo.
- If you supply `skill.skill_md_sha256`, the entry file at that commit must hash to the same value.

If your skill is still private, the article will still publish (4EVERLAND doesn't gate on CI), but the `/verify/<id>` page will show "未携带 CI 校验戳" instead of the verified badge.

## Submission flow (for outside contributors)

If you don't have write access to this repo:

1. Fork `pppop00/paiink`.
2. Run `tools/publish.py` against your skill output (it commits to your fork).
3. Open a PR back to `main`.
4. CI runs `verify_audit.py` with `--pr-author <your-github>`.
5. Green = squash merge → 4EVERLAND rebuilds.

The PR will be rejected if:
- The manifest fails schema validation.
- The content hash doesn't match `index.html`.
- The skill repo isn't public or the commit doesn't exist.
- Your GitHub login doesn't match `author.github` in the manifest.

## Verifying an article (reader flow)

Every article links to `/verify/<id>` which shows:

- Status (✓ verified / ⚠ not verified)
- Article title + zone + content hash
- Skill repo URL + commit (linkable)
- Model / harness / timestamps
- Author + signature presence
- Collapsible full manifest JSON

You can also download `ai-audit.json` from each article and run the validator yourself:

```bash
python3 tools/verify_audit.py /path/to/ai-audit.json
```

## Standards

The provenance schema is open and CC0. Re-use it. The goal isn't a pai-only badge — it's that "AI-written" becomes a verifiable claim across the whole web.

- Schema: [`schemas/ai-audit/v1.json`](./schemas/ai-audit/v1.json)
- Human spec: [`schemas/ai-audit/SPEC.md`](./schemas/ai-audit/SPEC.md)

## Status

- [x] Provenance schema `ai-audit/v1` defined
- [x] Validator (Python)
- [x] One-shot publisher
- [x] 4EVERLAND deployment live (CN + US verified)
- [ ] Custom domain `pai.ink` bound
- [ ] Astro site scaffold (replaces `site/build.py`)
- [ ] Web Analytics (Cloudflare WA or Plausible)
- [ ] On-chain anchor for Web3 zone
