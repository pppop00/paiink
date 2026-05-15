# `ai-audit/v1` — AI Provenance Manifest

**Status:** Draft 1 — 2026-05-14
**Schema:** [`v1.json`](./v1.json) (JSON Schema Draft 2020-12)
**Canonical URL:** `https://pai.ink/schemas/ai-audit/v1.json`

This document is the normative human-readable companion to `v1.json`. Where
the two disagree, the JSON Schema wins.

## 1. Purpose

`ai-audit.json` is a side-car file that ships next to every article on pai.
It answers four questions about the article:

1. **What was produced?** (`article` — exact bytes, hashed)
2. **Who/what produced it?** (`skill` — public repo + commit, `generation` — model + inputs)
3. **Who is taking responsibility for publishing it?** (`author`, optional `signature`)
4. **Did anyone independent check the above?** (`verifier` — filled by pai's CI)

The manifest is **machine-verifiable**. The pai CI rejects any article whose
manifest doesn't pass the checks in §5.

## 2. File location

```
content/<category>/<slug>/
├── index.html       ← the rendered article
├── ai-audit.json    ← THIS manifest
└── assets/          ← optional images, data, etc.
```

`content_path` in the manifest is relative to `ai-audit.json`'s directory.

## 3. The nine sections

### 3.1 `schema` + `schema_version`
Locks readers to v1. Future versions ship as `v2.json` etc.; pai will
support old versions for at least 12 months after a new one lands.

### 3.2 `article`

| Field | Required | Notes |
|---|---|---|
| `id` | yes | UUID v4. The author generates this. Becomes the URL slug on `/verify/<id>`. |
| `title` | yes | What appears on the listing page. |
| `subtitle` | no | Optional dek. |
| `category` | yes | `finance` or `web3` today. New zones added by PR'ing `config/categories.yaml`. |
| `tags` | no | Free-form, ≤12. |
| `language` | no | BCP-47 (`zh-CN`, `en-US`, etc.). |
| `license` | no | One of `CC-BY-NC-4.0`, `CC-BY-4.0`, `CC0-1.0`, `ARR`. Optional for legacy CLI/PR manifests; the web-upload flow requires the author to pick one before publish. `ARR` = All Rights Reserved. |
| `published_at` | no | ISO 8601 UTC timestamp. **Server-set** by the web-upload flow when the article is published; CLI/PR manifests can leave it absent. |
| `content_sha256` | yes | SHA-256 of the article file **verbatim, byte-for-byte**. No normalization. |
| `content_path` | yes | Relative path, typically `index.html`. |
| `assets` | no | Each asset hashed. Use this for screenshots, CSV data files, etc. |
| `word_count` | no | Informational. |

Why hash bytes verbatim and not normalize: any normalization step is a
source of bugs and ambiguity. If you change a single space, the hash
changes — that's the point.

### 3.3 `skill`

The skill is the **public** Git repository that contains the prompt(s),
agents, and tooling used to write the article.

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Human-readable. |
| `version` | no | Semver if the skill publishes versions. |
| `repo_url` | yes | Must resolve to a public repo on GitHub / GitLab / Codeberg / Bitbucket. Verifier `GET`s it without auth. |
| `repo_commit` | yes | 7–40 char hex commit hash. The verifier confirms the commit is reachable from a branch in the public mirror. |
| `skill_md_sha256` | no but recommended | SHA-256 of the skill's entry file (`SKILL.md`, `skill.yaml`, etc.) at `repo_commit`. Defends against a malicious repo owner replacing history *after* publication. |
| `entry_file` | no | Path to the entry file. Defaults to `SKILL.md`. |

**Private skill repos are not allowed.** The point is reproducibility — if
no one can read the recipe, the manifest is theatre.

### 3.4 `generation`

| Field | Required | Notes |
|---|---|---|
| `model` | yes | Model ID, e.g. `claude-opus-4-7`. |
| `api_request_id` | no | The Anthropic API `request_id` (e.g. `req_01ABcdef...`) returned by the run that produced this article. Useful for post-hoc support / forensic lookups; never required because not every harness surfaces it. |
| `harness` | no | `claude-code-cli`, `claude-agent-sdk`, `anthropic-api`, etc. |
| `started_at` / `finished_at` | yes | ISO 8601. |
| `prompt_template_sha256` | no | SHA-256 of the system/agent prompt used. Useful if the skill renders prompts dynamically and you want to pin which template version was active. |
| `user_inputs[]` | no | One entry per logical input the user supplied. `role` is required; `value` is inline for small strings, otherwise put a `url` + `sha256`. Don't embed full PDFs — hash and link. |
| `transcript_sha256` | no | If you publish the agent transcript (JSONL), its hash. |
| `transcript_storage` | no | Where the transcript lives — IPFS, Arweave, R2, etc. |
| `reproducibility_note` | no | Free text. **Be honest here.** This is where you disclose: "I edited the conclusion paragraph by hand," "I re-ran the skill three times and picked the best output," etc. The whole standard is worth nothing if authors lie in this field, so the field exists specifically to make lying explicit.

### 3.5 `author`

| Field | Required | Notes |
|---|---|---|
| `github` | yes | GitHub login. CI checks the PR author matches. |
| `display_name` | no | Pen name shown on the article page. |
| `wallet` | no | EVM address or `.eth` ENS. Required for Web3-zone if the author wants on-chain timestamping. |
| `wallet_sig` | no | EIP-191 signature by `wallet` over the canonical manifest. |

### 3.6 `agreement` (web-upload flow only)

When an author submits via the web-upload flow they must accept a versioned
publishing agreement. The accepted state is recorded here so a verifier can
prove the article was published under a specific set of terms.

| Field | Required (when block present) | Notes |
|---|---|---|
| `version` | yes | Agreement version tag, e.g. `v1`. |
| `sha256` | yes | SHA-256 of the agreement markdown file the author saw. For `v1`, the canonical agreement lives at `content/_meta/agreement-v1.md`. |
| `accepted_at` | yes | ISO 8601 UTC timestamp at which the author clicked accept. |

The verifier (`tools/verify_audit.py`) **pins the canonical sha256 for each
known agreement version directly in code** (`PINNED_AGREEMENT_HASHES`). The
check `agreement_hash_pinned` fails if the manifest's `agreement.sha256`
doesn't match the pinned value for `agreement.version`, or if the version is
unknown. This prevents a malicious server from silently swapping the
agreement text after the author accepted it.

Legacy CLI/PR manifests (no `agreement` block) are still accepted; the
verifier emits a non-blocking warning instead.

### 3.7 `signature` (optional but recommended)

An ed25519 signature by the author over the **canonical** form of the
manifest (RFC 8785 JSON Canonicalization Scheme), with the `signature`
field itself removed before canonicalization. The verifier:

1. Loads the manifest.
2. Deletes `signature` and `verifier`.
3. Canonicalizes via JCS.
4. Verifies `sig` against `public_key`.

The author registers `public_key` against their GitHub identity once (via a
gist or a `.pai` repo) so the same key works across submissions.

### 3.8 `verifier` (CI fills this in)

Authors must leave this empty. The CI bot adds it after a green run and
commits the updated manifest as part of the merge. The `verifier` block is
**not** covered by `signature` — it's pai's signed receipt, not the
author's.

`checks_passed` is the canonical list of checks the CI ran. The browser-side
verifier on `/verify/<id>` re-runs the same checks and shows a green/yellow/
red badge.

`timestamp_anchor` is optional. For Web3-zone articles, pai's bot will, by
default, anchor the manifest hash to either OpenTimestamps (free) or
Arweave (paid, ~$0.001/article) so the publication time can't be
back-dated.

## 4. Canonical form (for signing)

Use [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785). Steps:

1. Parse the manifest as JSON.
2. Remove the `signature` field (if present).
3. Remove the `verifier` field (if present).
4. Re-serialize with:
   - Keys sorted lexicographically at every level.
   - No insignificant whitespace.
   - Numbers in shortest round-trippable form.
   - UTF-8.

The `tools/sign_audit.py` helper does this for you.

## 5. Verifier checks

The CI / browser verifier runs these in order. **Any failure rejects the
article.**

| Check | What it does |
|---|---|
| `schema_valid` | Validates against `v1.json`. |
| `content_hash_match` | Re-hashes `content_path`, compares to `article.content_sha256`. |
| `assets_hash_match` | Re-hashes every entry in `article.assets[]`. |
| `skill_repo_public` | `GET <repo_url>` returns 200 unauthenticated. |
| `skill_commit_exists` | `git ls-remote <repo_url> <repo_commit>` finds the commit on a ref. |
| `skill_md_hash_match` | If `skill_md_sha256` provided, fetches the entry file at that commit (via raw URL) and hashes it. |
| `signature_valid` | If `signature` present, JCS-canonicalize and verify. |
| `github_oauth_match` | The PR opener equals `author.github`. (Skipped for CLI usage.) |
| `wallet_sig_valid` | If `wallet_sig` present, recover the EVM signer and compare. |
| `agreement_hash_pinned` | If an `agreement` block is present, `agreement.sha256` must equal the verifier's pinned hash for `agreement.version`. Unknown versions fail. No block = non-blocking warn (legacy manifest). |
| `license_valid` | If `article.license` is present, it must be one of the allowed enum values (`CC-BY-NC-4.0`, `CC-BY-4.0`, `CC0-1.0`, `ARR`). Absent = non-blocking warn (legacy manifest). |

## 6. Threat model — what this catches and what it doesn't

**Catches**
- Republishing someone else's article as your own (the GitHub identity won't match).
- Silently editing an article after publication (the on-chain anchor pins the original hash).
- Claiming to use a skill that doesn't exist or is private.
- Substituting a different skill commit later (skill_md hash defends).

**Does not catch**
- An author who runs an AI skill, then **heavily rewrites** the output by hand and still claims it as AI-written. The `reproducibility_note` is the only defense, and it relies on the author being honest. We don't try to detect "how much human edit"; that's an unsolved research problem.
- Two authors colluding to publish under one identity.
- A skill repo author force-pushing to delete a commit *after* publication. The `skill_md_sha256` field catches this — verifier re-checks the entry file at the named commit on every read; mismatch = red badge.

## 7. Versioning

- v1.x: additive only. New optional fields OK, no removals or type changes.
- v2: breaking changes. Will live at `/schemas/ai-audit/v2.json`. Articles state which version they use in the `schema` URL.

## 8. License

This schema is CC0. Re-use it. The whole point is that "AI-written" should
become a verifiable claim across the web, not a pai-only badge.
