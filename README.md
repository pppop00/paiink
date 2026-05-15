# pai — AI-Written Articles, Verifiably

A bilingual (zh/en) publishing platform for articles produced by AI skills.
Every article ships with an **AI provenance manifest** (`ai-audit.json`) that
ties it to a public skill repository, a specific commit, model, and author
identity. Articles live in two zones today — **Finance** and **Web3** — with
more to come.

- Static site, IPFS-pinned, served via 4EVERLAND's global CDN
- Works in both Mainland China and the US without ICP filing
- Submission via GitHub PR; validation via GitHub Actions
- Open standard: `ai-audit/v1` JSON Schema (see `schemas/ai-audit/`)

## Domain

**pai.ink** — chosen 2026-05-14. Register via Cloudflare Registrar; DNS
points at 4EVERLAND (see `docs/DEPLOY.md`).

## Repo layout

```
pai/
├── README.md
├── schemas/ai-audit/         # The provenance manifest standard
│   ├── v1.json               # JSON Schema (Draft 2020-12)
│   ├── SPEC.md               # Human-readable spec
│   └── examples/             # Sample manifests
├── tools/
│   ├── verify_audit.py       # Validator (used in CI + on upload)
│   ├── sign_audit.py         # Author-side signer (ed25519)
│   └── emit_audit.py         # Generates manifest from a skill output dir
├── content/
│   ├── finance/<slug>/       # index.html + ai-audit.json + assets/
│   └── web3/<slug>/
├── site/                     # Astro static site (added in Week 1 step 3)
├── docs/HOSTING.md           # 4EVERLAND deploy guide
└── .github/workflows/        # PR validation
```

## How to publish (author flow)

1. Run your AI skill and produce an HTML article in some folder.
2. Run `tools/emit_audit.py --skill-repo <url> --content <dir>` to produce
   `ai-audit.json` next to your article.
3. (Optional) Sign with `tools/sign_audit.py --key ~/.pai/ed25519.key`.
4. Fork this repo, drop your folder under `content/finance/<slug>/` or
   `content/web3/<slug>/`, open a PR.
5. CI runs `tools/verify_audit.py`. Green = the bot squash-merges. The site
   rebuilds on the next push.

## How to verify (reader flow)

Every article has a `/verify/<id>` page that re-runs the validator in the
browser and shows the audit trail: which skill repo, which commit, which
model, who signed it.

## Status

- [x] Provenance schema `ai-audit/v1` defined
- [x] Validator (Python)
- [x] Example manifests (finance, web3)
- [ ] Astro site scaffold
- [ ] 4EVERLAND deployment
- [ ] Skill-side `emit_audit.py` wired into Equity Research / Equity Photo / Anamnesis
