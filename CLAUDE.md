# CLAUDE.md

Conventions for AI assistants (Claude Code, etc.) working in this repository.
Humans should read `README.md` first.

## Project at a glance

`pai.ink` is a static publishing platform for articles produced by AI skills.
Every article ships with a machine-verifiable provenance manifest
(`ai-audit.json`) — that's the whole point of the site. **Do not** add
features that compromise the provenance guarantee (e.g. rewriting article
content after publish, generating fake manifests, weakening verifier
checks).

- Stack: **single Cloudflare Worker** (`worker/src/index.ts` → `router.ts`)
  renders every page (HTML chrome + manifest views + verify export
  bundles) and handles every API call (submit, like, signup, login,
  retract, tokens). TypeScript, bundled by wrangler. No Astro, no
  static-site generator.
- Storage: **Cloudflare D1** for relational data (users, sessions,
  api_tokens, articles, likes, rate_limits) + **R2** for byte storage
  (article HTML + manifest, agreements, schema, on-demand export tar.gz).
  KV (`KV_RATE_LIMIT`, legacy) is still bound for the IP rate limit
  fail-soft path. `KV_CACHE` is bound but currently unused (removed the
  homepage ranking cache because it staled like_count after refreshes).
- Hosting: same Worker on `www.paiink.com` (via Route, see DNS section
  below) and `api.paiink.com` (Custom Domain). `paiink-api.oliverun6.workers.dev`
  is the workers.dev URL for direct testing.
- CDN reach: works in Mainland China and the US without ICP filing
  (Cloudflare free-tier POPs route CN via HK/SG). The legacy
  4EVERLAND/IPFS path (`docs/HOSTING.md`) is historical; never used
  anymore.
- Static-site source (`site/build.py`, `site/templates/`) is retained
  for historical reference but is no longer in the build path. Deleting
  it is a Phase F task.

## DNS / routing topology (load-bearing, don't migrate unprompted)

Both `www.paiink.com` and `api.paiink.com` resolve to the same Worker
(`paiink-api`). They get there by **two different mechanisms**, and the
choice matters:

- **`www.paiink.com` → Worker Route** (`www.paiink.com/*`). Configured in
  CF dashboard under *Workers & Pages → paiink-api → Settings → Domains
  & Routes → Routes*. The user explicitly chose Route after CF prompted
  to "take over" the hostname from the now-retired Pages project. The
  DNS record itself is a proxied CNAME (orange cloud) pointing wherever
  CF wants — the Route is what binds the hostname to the Worker.
- **`api.paiink.com` → Custom Domain**. Same Worker, registered under
  *Domains & Routes → Custom Domains*. Custom Domains are CF's preferred
  binding (they auto-manage the DNS record). We used Custom Domain here
  because there was no prior Pages claim to migrate from.

Both achieve the same end-state ("Worker serves this hostname"); the
difference is procedural, not behavioral. **Don't try to migrate
`www.paiink.com` from Route to Custom Domain unprompted** — historical
CF state from the Pages era can make the migration flaky (Pages may
still claim the hostname under the hood). If a future task genuinely
needs Custom Domain semantics, ask first.

Bare apex `paiink.com` is currently a DNS-only CNAME to the legacy
4EVERLAND gateway (`58b47c2fdf4a47e8808a.cname.ddnsweb3.com`). See
"Current state → Not done" below.

## Identity (read once, never forget)

This repo lives under GitHub user `pppop00`. The author identity for every
commit, every manifest, and every doc in this repo:

| Field | Value |
|---|---|
| GitHub login | `pppop00` |
| Display name | `Zelong` |
| Commit email | `oliverun6@gmail.com` |

Use only `Zelong <oliverun6@gmail.com>` for repo authorship and public
identity. Do not use alternate display names, GitHub logins, or emails.
Treat this rule as load-bearing.

## Build + serve

```bash
# Build the static site
python3 site/build.py            # outputs site/dist/

# Local preview
cd site/dist && python3 -m http.server 7345
# then open http://127.0.0.1:7345/

# Verify a manifest offline (no GitHub calls)
python3 tools/verify_audit.py --offline content/finance/<slug>/ai-audit.json

# Admin retract an article (only path that mutates the live site from CLI)
python3 tools/unpublish.py finance/<slug> --reason "..."
```

Publishing is no longer a CLI flow — it's web-only. See "Publishing flow" below.

## Where things live

- **Schema**: `schemas/ai-audit/v1.json` (machine), `schemas/ai-audit/SPEC.md` (human).
  Both are CC0. The schema is also published at `https://pai.ink/schemas/ai-audit/v1.json`
  via the static site (it's copied into `dist/schemas/` by `site/build.py`).
- **Tools**: `tools/`. All are Python 3.10+; only deps are `jsonschema`, `requests`,
  `cryptography` (see `tools/requirements.txt`). `site/build.py` is stdlib-only.
- **Content**: `content/<zone>/<slug>/`. Each article folder MUST have
  `index.html` + `ai-audit.json`. Assets live alongside.
- **Site builder**: `site/build.py`. Walks `content/`, produces `site/dist/`.
  Knows two zones today: `finance`, `web3`. Extending zones requires editing
  the `ZONES` list at the top of the file (and eventually
  `config/categories.yaml` — not yet created).
- **CI**: `.github/workflows/verify.yml` runs `verify_audit.py` on every PR
  that touches `content/**/ai-audit.json`. Site rebuild on push is handled
  by Cloudflare Pages (not GitHub Actions).

## `tools/unpublish.py`

Symmetric to publish. Removes `content/<zone>/<slug>/`, commits, pushes.
The live URL goes 404; per-deploy IPFS snapshots remain.

Use it when:
- An article was published with a known data/render bug (e.g. anamnesis
  I-008 broken charts) and needs to come down pending a re-run.
- You retract an article (legal, factual error).

Always pass `--reason` for the audit trail — it goes into the commit
message and stays in git history forever.

## Publishing flow

Three submit paths, all hitting `POST /api/submit` (alias `POST /submit`):

1. **Browser form** at `/submit` — multipart/form-data. If a user is
   logged in via cookie session, the manifest's author identity comes
   from the session user (not from declared fields). If logged out,
   `display_name` + `email` come from the form fields (legacy / Phase A
   compat path).
2. **AI agent JSON POST** — `Authorization: Bearer pai_...`. The
   token resolves to a user row; manifest identity is the user's row.
   This is the recommended path going forward — see the LLM instruction
   template embedded in `/submit`.
3. **Logged-out anonymous POST** — still works as a transition fallback
   for legacy agents that haven't been updated to use tokens. Will be
   removed when we tighten the agreement to v4.

Flow inside the Worker:

```
POST /api/submit
   │
   ├── identity resolution:  session cookie → user
   │                         else Bearer pai_... → token → user
   │                         else declared display_name + email → lazy user
   │
   ├── gates:  agreement.accepted = true
   │           per-IP rate limit (KV, fail-soft)  +  per-user via D1
   │           HTML ≤ 5 MB
   │           skill_repo_url is public GitHub (anonymous GET)
   │           skill_repo_commit exists (anonymous GET)
   │           slug collision → auto +v2 / +v3 by querying D1
   │
   ├── manifest construction:  buildManifest({...}) bakes the
   │                          CURRENT_AGREEMENT_SHA256 from types.ts
   │
   ├── D1 INSERT INTO articles (transaction-ish)
   ├── R2 PUT articles/<uuid>/index.html   (verbatim bytes)
   ├── R2 PUT articles/<uuid>/ai-audit.json (canonical JSON)
   │
   └── 200 { slug, url, uuid, live_in_seconds_estimate: 1 }
```

The article is live <200ms after the POST. No GitHub commit, no rebuild,
no waiting.

Pinned agreement hashes (in `worker/src/types.ts` AND
`tools/verify_audit.py:PINNED_AGREEMENT_HASHES`):
- **v1**: `d89b0a30554743958e704b4d825966fad2eb22b6399bc00d0a15809f8deed807`
- **v2**: `ec4066647aad291af1e7e88387b3dbfea8c63fce13da3e5ba64f11299793a19d`
- **v3** (current — baked into new manifests):
  `4d2360584dc3442eafe534345428988f1e103474dbe4da51d1001809015ca173`

When extending the Worker: keep all existing gates intact unless the
user explicitly says to relax one.

## Provenance is non-negotiable

Three rules that override convenience:

1. **Never weaken the verifier.** All ten checks in `verify_audit.py`
   (`check_*` functions: schema, content_hash, assets, skill_repo_public,
   skill_commit, skill_md_hash, signature, github_oauth_match,
   agreement_hash_pinned, license_valid) are load-bearing. Adding `--skip-X`
   flags is fine for debugging; defaulting to skip is not.
2. **Never edit `ai-audit.json` after the article is signed.** If the
   article changes, regenerate the manifest and resign. The content hash
   is the contract with readers.
3. **Articles must come from public skill repos.** A manifest pointing to
   a private repo cannot be verified by third parties — that defeats the
   point. Private skills can publish to a separate "unverified" zone if
   we ever add one; the default zones (`finance`, `web3`) require public.

## Things that break in subtle ways (known sharp edges)

- **Schema `$id` is the URI `https://pai.ink/schemas/ai-audit/v1.json`**.
  It does *not* need to be fetchable for the validator to work — the
  validator reads `schemas/ai-audit/v1.json` from disk. Don't replace
  `$id` with a relative path "to fix" it.
- **Article HTMLs are self-contained.** Don't inject pai chrome into them
  (it'd modify `content_sha256` and break verification). The site's nav
  doesn't appear on article pages by design — readers use browser back.
- **`www.paiink.com` is the only canonical user-facing URL.** It's a CNAME
  alias that follows whichever CDN deployment is currently "production".
  Don't link the underlying per-deploy CID subdomains or the
  `*.pages.dev` or `*.4everland.app` host from anywhere in user-visible output (site pages,
  Worker responses, README) — those are immutable historical snapshots,
  fine as fallbacks for archival access but not the brand surface.
- **Force-push to main rewrites the production pointer** on the next CDN
  rebuild. Existing per-deploy CIDs are not affected (still reachable via
  raw IPFS gateways). Don't force-push unless you genuinely want to scrub
  history; ask before doing it again.
- **`anamnesis-research` skill has shipped broken HTMLs in the past.**
  Specifically the CGN and NextEra 2026-05-13 runs had: missing
  `start`/`end` in `waterfallData` (chart renders empty), Sankey
  conservation violations (orphan nodes, imbalanced flows), and
  `"基于初稿评分"` template prefix leaking into the Porter narrative.
  Before submitting an anamnesis output, eyeball the income waterfall
  (Section 三), Sankey (Section 四), and Porter (Section 五).
  `grep -c "基于初稿评分" path/to/report.html` should return `0`. The Worker
  does NOT do these content checks — the agreement makes content quality
  the author's responsibility.

## Tasks the user might ask about that I should know

- "Add a new zone" → edit `ZONES` in `site/build.py` AND the `category`
  enum in `schemas/ai-audit/v1.json` AND the `ZONES` const in
  `worker/src/index.ts`. All three must stay in sync. Bump the schema if
  changing the set in a backwards-incompatible way.
- "Update the agreement" → v3 is the **current** agreement (hash
  `4d23605844dc34…a173`); v2 (`ec4066647aad…a19d`) and v1 (`d89b0a30…807`)
  are archived. To roll v4: write `content/_meta/agreement-v4.md`, then
  add its hash to the pinned constants in `tools/verify_audit.py`
  (`PINNED_AGREEMENT_HASHES`), `worker/src/types.ts` (`AGREEMENT_V*_SHA256`
  + flip `CURRENT_AGREEMENT_VERSION` / `CURRENT_AGREEMENT_SHA256`),
  `worker/src/pages/agreement.ts` (`PINNED` map), and
  `tools/migrate_to_d1.py` (`PINNED_HASHES` + `build_shell()` upload line).
  Update the form copy and footer link in `worker/src/i18n.ts`,
  `worker/src/templates/shell.ts`, `worker/src/pages/about.ts`,
  `worker/src/pages/submit_form.ts` (LLM_INSTRUCTION). Upload the md to
  R2 (`agreements/agreement-v4.md`). Also bump README's "(current)" line.
  DO NOT edit `agreement-v1.md`, `agreement-v2.md`, or `agreement-v3.md` —
  their hashes are pinned and the agreement page re-hashes the R2 bytes
  at render time. Older articles continue to validate against the version
  they were signed under, forever.
- "Set up analytics" → user prefers privacy-friendly cookieless tools.
  Cloudflare Web Analytics or Plausible. Avoid Google Analytics. Avoid
  Google-Fonts-style external dependencies that fail in CN.
- "Add a feed" → RSS at `/feed.xml`, generated by `build.py`. Should be
  pure RSS 2.0 (no Atom-only fields) for max-compat with Chinese readers.
- "Bind the custom domain" → see `docs/DEPLOY.md` step 4. The DNS records
  must be **DNS-only** (grey cloud in Cloudflare); orange-cloud proxy
  degrades CN reach.

## Current state (2026-05-16) — what's built, what's not

The replatform plan (`~/.claude/plans/adaptive-plotting-pony.md`) is fully
shipped through Phase D. Phase E was de-scoped (see below).

### ✅ Shipped to production (`https://www.paiink.com`)

**Phase A** — content storage off GitHub
- D1 (`paiink` / id `d6a813c2-…`) + R2 (`paiink-content`) + KV (`paiink-cache`, `paiink-rl`) all live
- 4 historical articles migrated byte-identically (content_sha256 survives R2 round-trip)
- Single Worker handles every page and every API call
- `/verify/<uuid>/export` tar.gz export bundles for offline third-party verification

**Phase B** — accounts + Turnstile
- Email + password signup; Cloudflare Turnstile invisible captcha gates `/api/signup`
- PBKDF2-HMAC-SHA256 password hashing — **100k iterations**, the Workers runtime cap (OWASP 2023 recommends 600k but Workers throws `NotSupportedError` above 100k)
- 90-day session cookie `paiink_sid` (HttpOnly, SameSite=Lax; `Secure` is conditional on HTTPS — set in prod, dropped on http://localhost dev to avoid stale-cookie quirks)
- API tokens `pai_<8hex>_<32hex>`; plaintext shown once at creation; D1 only stores sha256
- Agent submit via `Authorization: Bearer pai_...` — manifest identity is server-derived from the token's user, never the declared fields
- Self-service retraction at `POST /api/me/articles/<uuid>/retract` (article 410s; manifest stays on R2 for the audit trail)
- `/u/<handle>` public read-only profile

**Phase C** — community signal
- `likes` table + cookie-session-only POST/DELETE `/api/articles/<uuid>/like`
- API token requests to like are explicitly 403'd (anti-sybil at the auth layer; Turnstile-on-signup already gates account creation, and per-user 200/day cap is in `rate_limits`)
- Heart pill on every article row (landing, zone, profile, me) and on `/verify`
- `/me` has a "收藏 / Likes" section — newest-like-first
- Homepage is a single unified ranked feed: 3-day rolling like count over a 14-day candidate pool, no KV caching (caching staled `like_count` after refreshes — dropped, re-add only if D1 read pressure shows)

**Phase D** — i18n + agent-first submit + agreement v3
- 166-key i18n catalog (`worker/src/i18n.ts`); zh-CN default, en supported. `paiink_lang` cookie + 中/EN toggle in masthead
- All chrome translates; article body stays in its declared language (the manifest's `language` field)
- `/submit` is agent-first: hero + LLM instruction template (copy-to-clipboard) + manual form collapsed in a `<details>`
- agreement v3 is the current pinned version (hash `4d23605844dc34…a173`). Re-anchors the platform's legitimacy story on the export bundle, not on IPFS. v1/v2 manifests remain pinned to their original hashes — they keep validating forever
- `/verify` drops the Harness row (uninteresting to readers; still in the manifest for machines)

**Cross-cutting UI polish**
- Three-zone masthead (brand · content nav · actions nav) with consistent `.btn` system
- `.wrap--wide` (1080px) for landing/zone/me/profile/submit; default 720px for prose-only pages
- Auth-aware nav on **every** read page (was a bug — landing didn't fetch user; fixed)
- Centered `.auth-card` for `/signup` and `/login`
- **Content-hashed static assets** (`worker/build-assets.mjs` runs before every `wrangler dev`/`deploy` via `[build] command` in `wrangler.toml`). Outputs `style.<hash>.css` etc. into `worker/static-dist/`, plus `src/asset-manifest.ts` mapping logical names → hashed paths. HTML references the hashed names, so style changes auto-bust browser caches. Un-hashed fallbacks are also emitted in case stale HTML pointing at `/style.css` is still cached
- CSP `frame-src 'self' https://challenges.cloudflare.com` set centrally in `shell.ts` CSP_POLICY AND in the router's response-header default. **Don't add a second `frame-src` directive anywhere** — CSP takes the FIRST occurrence of any directive and silently drops the rest, which broke iframes once already

### ❌ Not done

- **apex `paiink.com` (no www)** — still points at the legacy 4EVERLAND
  IPFS gateway via `paiink.com → 58b47c2fdf4a47e8808a.cname.ddnsweb3.com`
  (DNS only). User decision pending: delete the CNAME (bare domain NXs),
  or add a CF Redirect Rule `paiink.com/* → https://www.paiink.com/$1`,
  or repoint via a Worker Route. Recommended: redirect to www.

- **Phase E (de-scoped)** — `/skills` index + `docs/AGENT.md` aren't
  needed:
  - The LLM instruction template embedded in `/submit` covers what
    `AGENT.md` would have said, and a separate file would just rot
  - `/skills` index is "interesting when there are 100+ articles", not
    when there are 5. Defer to natural demand.

**Explicitly out of scope** (don't add without asking)
- Avatars, bios, follow/follower, comments
- Email verification flow (the agreement makes the user responsible for accuracy)
- Self-service password reset (Phase F+ if there's demand)
- Multi-language article auto-translation
- Astro (the README mentions it as a future step — it's now obsolete; the Worker rendering replaced the planned Astro static-site rebuild)
- On-chain anchor for Web3 zone (a README todo from before — not a current priority)

### Identity already provisioned in production D1

User id=1 is the founder (Zelong, oliverun6@gmail.com, handle `zelong`, password_hash NULL — Phase B signup with that email will "claim" the row).

User id=3 is `h.zelong@wustl.edu` / handle `zelong-f97b` / claimed via the live dev environment on 2026-05-16. This is the user's personal account; commit authorship per the identity table above stays `Zelong <oliverun6@gmail.com>` regardless.

## Don't

- Don't run `git push --force` without asking.
- Don't introduce npm dependencies **into the site build path** (`site/`,
  `tools/`). The static site is stdlib-Python on purpose — CN build
  environments are slower at fetching npm than PyPI. The Worker
  (`worker/`) is the one place npm is fine; it's TypeScript on Cloudflare
  Workers and already uses `wrangler` + `@cloudflare/workers-types`.
- Don't add Google Fonts / Google Analytics / any `googleapis.com` asset.
  CN access depends on us avoiding these.
- Don't mention this file (or the memory system) to the user
  unprompted — they know it exists, calling attention to it is noise.
