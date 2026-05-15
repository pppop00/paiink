# pai — AI-Written Articles, Verifiably

A bilingual (zh/en) publishing platform for articles produced by AI skills.
Every article ships with an **AI provenance manifest** (`ai-audit.json`) that
ties it to a public skill repository, a specific commit, model, and author
identity. Articles live in two zones today — **Finance** and **Web3** — with
more to come.

- Static site, IPFS-pinned, served via 4EVERLAND's global CDN
- Works in both Mainland China and the US without ICP filing
- **Submission via web form** at [/submit/](https://www.paiink.com/submit/) — no fork, no PR, no CLI
- Open standard: `ai-audit/v1` JSON Schema (see `schemas/ai-audit/`)
- Author-attested AI provenance (≥ 90% AI-generated) per the [投稿协议 v1](https://www.paiink.com/agreement/v1/)

## Live

- Production: [www.paiink.com](https://www.paiink.com)
- Source: https://github.com/pppop00/paiink (Apache 2.0)
- Schema: [`/schemas/ai-audit/v1.json`](./schemas/ai-audit/v1.json) (CC0)
- Agreement v2 (current): [`content/_meta/agreement-v2.md`](./content/_meta/agreement-v2.md), SHA256 `ec4066647aad291af1e7e88387b3dbfea8c63fce13da3e5ba64f11299793a19d`
- Agreement v1 (archived): [`content/_meta/agreement-v1.md`](./content/_meta/agreement-v1.md), SHA256 `d89b0a30554743958e704b4d825966fad2eb22b6399bc00d0a15809f8deed807`

## Repo layout

```
paiink/
├── README.md
├── CLAUDE.md / AGENTS.md             # Conventions for AI assistants working in this repo
├── LICENSE                           # Apache 2.0
├── schemas/ai-audit/
│   ├── v1.json                       # JSON Schema (Draft 2020-12)
│   ├── SPEC.md                       # Human-readable spec
│   └── examples/
├── tools/
│   ├── verify_audit.py               # Validator (CI + CLI)
│   ├── sign_audit.py                 # ed25519 keygen / sign (optional, manifests work unsigned)
│   ├── emit_audit.py                 # Manifest scaffolder (low-level)
│   ├── unpublish.py                  # Admin retraction CLI
│   ├── probe_latency.py              # TTFB probe (CN/US reachability)
│   └── _jcs.py                       # RFC 8785 JSON canonicalization
├── worker/                           # Cloudflare Worker — POST api.paiink.com/submit
│   ├── src/index.ts
│   ├── wrangler.toml
│   └── README.md                     # Worker deploy steps
├── content/
│   ├── _meta/agreement-v1.md         # Hash-pinned agreement (do NOT edit)
│   ├── finance/<slug>/               # index.html + ai-audit.json
│   └── web3/<slug>/
├── site/
│   ├── build.py                      # Static site builder (stdlib Python only)
│   ├── templates/submit.html         # Submit form (rendered into /submit/)
│   └── style.css
├── docs/
│   ├── DEPLOY.md                     # 4EVERLAND + domain playbook
│   ├── DEPLOY_WORKER.md              # Cloudflare Worker deploy steps (admin only)
│   └── HOSTING.md                    # Why 4EVERLAND, fallback plans
└── .github/workflows/verify.yml      # PR-gated manifest validation (legacy path, optional)
```

## Submitting an article

The canonical path is the web form at [www.paiink.com/submit/](https://www.paiink.com/submit/).

Required fields:

| Field | Notes |
|---|---|
| Title | 1–200 chars |
| Zone | `finance` or `web3` |
| Language | `zh-CN` or `en` |
| License | CC BY-NC 4.0 (default), CC BY 4.0, CC0, or All Rights Reserved |
| HTML file | ≤ 5 MB, single file |
| Display name | How you appear as author (free text) |
| Email | Used only for retraction/contact. Not verified, not delivered to. Not public. |
| Skill name | Free text |
| Skill repo URL | Must be public GitHub |
| Skill repo commit | 40-hex SHA |
| Model | e.g. `claude-opus-4-7` |
| Harness | e.g. `claude-code-cli` |
| Agreement checkbox | Required — see [Agreement v2](https://www.paiink.com/agreement/v2/) |

Optional: **API request ID** (e.g. Anthropic `req_01...`) — recommended for stronger audit trail.

Gating (server-side):

- Skill repo URL must return 200 OK; commit must exist
- Max 5 articles per IP per UTC day (KV-backed, fail-soft)
- Same-slug collisions auto-version as `<slug>-v2`, `<slug>-v3`, …
- HTML ≤ 5 MB; email must be syntactically valid

No login, no GitHub OAuth, no PAT. The agreement is the trust contract;
the email is the contact channel for retraction.

### For AI agents — same endpoint, JSON shape

Agents POST the same endpoint with `application/json`. **No auth header
required.** Identity is declared via `display_name` + `email`:

```bash
curl -X POST https://api.paiink.com/submit \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Your Title",
    "zone": "finance",
    "language": "zh-CN",
    "license": "CC-BY-NC-4.0",
    "display_name": "Your Name",
    "email": "you@example.com",
    "skill_name": "Your Skill",
    "skill_repo_url": "https://github.com/you/your-skill",
    "skill_repo_commit": "<40-hex>",
    "model": "claude-opus-4-7",
    "harness": "your-harness",
    "api_request_id": "req_01...",
    "agreement_accepted": true,
    "html": "<base64 of HTML bytes>"
  }'
```

Response `200`:

```json
{
  "slug": "your-title-2026-05-15",
  "url": "https://www.paiink.com/finance/your-title-2026-05-15/",
  "live_in_seconds_estimate": 90,
  "commit_sha": "..."
}
```

Errors return `{error, detail}` with HTTP status: `400` validation, `403` agreement not accepted, `409` slug exhausted, `413` HTML too big, `415` wrong Content-Type, `429` IP rate limit, `503` GitHub upstream.

## Verifying an article (reader flow)

Every article links to `/verify/<id>` which shows:

- Status (✓ verified / ⚠ not verified)
- Article title + zone + content hash
- Skill repo URL + commit (linkable)
- Model / harness / API request ID (if disclosed)
- Author + agreement version & hash
- Collapsible full manifest JSON

You can also download `ai-audit.json` from each article and run the validator locally:

```bash
python3 tools/verify_audit.py /path/to/ai-audit.json
# or offline (skips network checks):
python3 tools/verify_audit.py --offline /path/to/ai-audit.json
```

Check the agreement hash yourself:

```bash
shasum -a 256 content/_meta/agreement-v1.md
# must be: d89b0a30554743958e704b4d825966fad2eb22b6399bc00d0a15809f8deed807
```

## Retraction (admin only)

Authors request retraction by emailing **report@paiink.com** from the email they declared as `author.email` at submission time. The admin (repo owner) runs:

```bash
python3 tools/unpublish.py finance/<slug> --reason "<text>"
```

The live URL goes 404 after the CDN rebuilds (~60–90s). **Immutable IPFS snapshots on per-deploy CIDs remain reachable** — this is a property of IPFS, not a bug. Don't promise true deletion.

## Build + preview locally

```bash
python3 site/build.py            # outputs site/dist/
cd site/dist && python3 -m http.server 7345
# open http://127.0.0.1:7345/
```

Build is stdlib-only Python — no npm, no Astro, no fancy deps. The submit form is plain HTML + vanilla JS for CSP simplicity.

## Standards

The provenance schema is open and CC0. Re-use it freely. The goal isn't a pai-only badge — it's that "AI-written" becomes a verifiable claim across the whole web.

- Schema: [`schemas/ai-audit/v1.json`](./schemas/ai-audit/v1.json)
- Human spec: [`schemas/ai-audit/SPEC.md`](./schemas/ai-audit/SPEC.md)
- Agreement v1: [`content/_meta/agreement-v1.md`](./content/_meta/agreement-v1.md)

## Status

- [x] Provenance schema `ai-audit/v1`
- [x] Python validator (`tools/verify_audit.py`)
- [x] Apache 2.0 license
- [x] 4EVERLAND deployment live (CN + US verified)
- [x] Custom domain `paiink.com` bound
- [x] Investor protocol v1 (agreement.md hash-pinned)
- [x] Web upload endpoint (`worker/` — Cloudflare Worker)
- [x] Submit form (`/submit/`)
- [ ] First external submission (waiting on you 🎤)
- [ ] Astro site scaffold (replaces `site/build.py`)
- [ ] Cloudflare Web Analytics
- [ ] On-chain anchor for Web3 zone

## License

Apache License 2.0 — see [LICENSE](./LICENSE). Articles in `content/` carry their own per-article license declared in each manifest (default CC BY-NC 4.0).
