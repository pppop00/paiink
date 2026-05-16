# Phase A deploy guide

Phase A migrates paiink content storage from GitHub to Cloudflare D1 + R2,
serving everything from a single Worker. Cloudflare Pages remains online as
fallback until you flip DNS at the end.

Total wall-clock: ~30 min including the safety wait. Everything below
operates on your CF account, so run it yourself with `wrangler` from this
repo's root.

## 0. Prereqs

```bash
cd worker
npx wrangler login          # authenticate once if not already
npx wrangler whoami         # confirm correct account
```

The Worker code, migrations, and tooling are already in place. Files of
interest:

- `worker/wrangler.toml` — has placeholder `database_id` / KV `id` to fill
- `worker/migrations/0001_initial.sql` — full Phase A–E schema
- `tools/migrate.sql` — INSERTs for the 4 existing articles + founder user
- `tools/migrate.sh` — `wrangler r2 object put` calls for the bytes

## 1. Create cloud resources

```bash
# D1 database. Copy the printed database_id into wrangler.toml.
npx wrangler d1 create paiink

# R2 bucket.
npx wrangler r2 bucket create paiink-content

# KV namespace (hot-cache, will be wired in Phase C — bind now to avoid
# a second deploy later). Copy the printed id into wrangler.toml.
npx wrangler kv namespace create paiink-cache
```

After the two `id` placeholders in `wrangler.toml` are filled, sanity-check
the config:

```bash
npx wrangler types                    # generates env types; should succeed
npx wrangler deploy --dry-run         # validates bindings without uploading
```

## 2. Apply the D1 schema

```bash
# From the worker/ directory:
npx wrangler d1 migrations apply paiink --remote
```

Should print `🚧 Applying migration … 0001_initial.sql`.

## 3. Seed founder user + 4 existing articles

```bash
# From the repo root:
npx wrangler d1 execute paiink --remote --file tools/migrate.sql
```

Expected: 1 user inserted + 4 articles inserted. Verify:

```bash
npx wrangler d1 execute paiink --remote --command "SELECT zone, slug, uuid FROM articles ORDER BY id"
```

Should list:
- finance/adm-2026-05-13
- finance/heico-2026-05-16
- finance/otis-worldwide-2026-05-15
- finance/waste-management-2026-05-14

## 4. Upload HTML + manifests + agreements + schema to R2

```bash
# From the repo root:
bash tools/migrate.sh
```

This pushes 11 R2 objects:
- 4 × `articles/<uuid>/index.html`
- 4 × `articles/<uuid>/ai-audit.json`
- `agreements/agreement-v1.md`
- `agreements/agreement-v2.md`
- `schemas/ai-audit/v1.json`

## 5. Set secrets

```bash
npx wrangler secret put GITHUB_TOKEN
# Paste the fine-grained PAT (same one used today: pppop00/paiink Contents
# Read+Write — actually only "Contents: Read" is now strictly needed since
# we no longer commit; you can rotate to a read-only PAT here).
```

`TURNSTILE_SECRET` is a Phase B concern — skip for now.

## 6. Deploy the Worker

```bash
npx wrangler deploy
```

The Worker now serves on `<your-worker>.workers.dev` and (once the Custom
Domain is bound — see step 7) on `api.paiink.com`.

## 7. Verify against the workers.dev URL first

Before touching DNS, hit the workers.dev URL directly to confirm everything
works:

```bash
W=https://paiink-api.<your-subdomain>.workers.dev

# Homepage renders, articles list newest-first
curl -sI $W/
curl -sI $W/finance/

# Migrated article serves byte-identically (compare with content/finance/heico-2026-05-16/index.html)
curl -s $W/finance/heico-2026-05-16/article | shasum -a 256
# Should print 26c2d06419de2622eca715c1af0c97537157f837bbd6a2caf220426cea14bc5c (the content_sha256 in manifest)

# Manifest hash check
curl -s $W/verify/9deec278-2fdc-48e4-b122-3cc5c5e2e9df/manifest.json | diff - content/finance/heico-2026-05-16/ai-audit.json
# Should print nothing (byte-identical, modulo trailing newline)

# Export bundle round-trip
mkdir /tmp/paiink-test && cd /tmp/paiink-test
curl -sL "$W/verify/9deec278-2fdc-48e4-b122-3cc5c5e2e9df/export" | tar xz
python3 ~/Desktop/Projects/paiink/tools/verify_audit.py --offline ai-audit.json
# Should print: ✓ verified (or equivalent — depending on signature presence)
```

## 8. Submit endpoint smoke test

Submit a tiny article via the JSON path to confirm the new D1 + R2 flow:

```bash
HTML_B64=$(printf '<!doctype html><h1>hello phase A</h1>' | base64)

curl -X POST $W/submit \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Phase A smoke\",
    \"zone\": \"finance\",
    \"language\": \"en\",
    \"license\": \"CC0-1.0\",
    \"display_name\": \"Zelong (smoke)\",
    \"email\": \"oliverun6@gmail.com\",
    \"skill_name\": \"manual\",
    \"skill_repo_url\": \"https://github.com/pppop00/paiink\",
    \"skill_repo_commit\": \"$(git rev-parse HEAD)\",
    \"model\": \"none\",
    \"harness\": \"curl\",
    \"agreement_accepted\": true,
    \"html\": \"$HTML_B64\"
  }"
```

Expected: 200 with `{ slug, url, uuid, live_in_seconds_estimate: 1 }`. The
new article should be immediately accessible at the printed URL (no
60-90s wait).

If it works, **delete the test article**:

```bash
npx wrangler d1 execute paiink --remote --command "DELETE FROM articles WHERE slug LIKE 'phase-a-smoke-%'"
# Then manually remove the R2 objects:
npx wrangler r2 object delete paiink-content/articles/<the-uuid>/index.html
npx wrangler r2 object delete paiink-content/articles/<the-uuid>/ai-audit.json
```

## 9. Bind api.paiink.com Custom Domain to the Worker (already done from before)

`api.paiink.com` is already a Custom Domain on this Worker — no action needed.

## 10. DNS cutover for www.paiink.com (after step 7 + 8 pass)

This is the irreversible step. Once DNS flips, Cloudflare Pages stops being
the source of truth for `www.paiink.com`.

Two options:

**A. Workers Custom Domain on `www.paiink.com`** (recommended)
- Cloudflare dashboard → Workers & Pages → `paiink-api` → Settings → Domains & Routes → Add Custom Domain → `www.paiink.com`
- Wait ~30s for the cert to provision
- Existing DNS-only A/AAAA record for `www` (currently pointing at BunnyCDN edge) will be replaced automatically by the Workers integration

**B. Manual DNS** — change the `www` CNAME to point at `paiink-api.workers.dev`. Less elegant; Workers won't manage the cert handoff cleanly.

Either way, the previous Cloudflare Pages project stays up but no longer
receives `www.paiink.com` traffic. Don't delete the Pages project for at
least 48 hours.

## 11. Observe + roll back if needed

For the first 48 hours:

```bash
# Live logs
npx wrangler tail

# Spot-check the 4 migrated URLs from outside (and from CN if possible)
for slug in adm-2026-05-13 heico-2026-05-16 otis-worldwide-2026-05-15 waste-management-2026-05-14; do
  echo "=== $slug ==="
  curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" "https://www.paiink.com/finance/$slug/"
done
```

**Rollback**: If anything is wrong, revert the Custom Domain binding in
the Cloudflare dashboard — `www.paiink.com` will fall back to the Pages
project automatically. The Worker keeps running on api.paiink.com.

## 12. After 48 stable hours — sunset Pages

```bash
# Cloudflare dashboard → Workers & Pages → paiink (Pages project) → Settings → Delete
```

This decommissions the Pages project. The Worker is now the only thing
serving paiink.com.

The static-site source (`site/build.py`, `site/templates/`) stays in the
repo for reference until Phase D, when the new submit UX replaces the
legacy form template entirely.

---

## What got built in Phase A (file inventory)

```
worker/
├── wrangler.toml                   [edited] +D1 +R2 +KV_CACHE +ASSETS bindings
├── package.json                    [edited] +ulid
├── migrations/0001_initial.sql     [new] full Phase A-E schema
├── static/
│   ├── style.css                   [new] byte-identical copy of site/style.css
│   └── favicon.svg                 [new] byte-identical copy of site/favicon.svg
└── src/
    ├── index.ts                    [rewritten] thin entrypoint → router
    ├── router.ts                   [new] URL dispatch + CSP + error handling
    ├── types.ts                    [new] Env, Manifest, ArticleRow, HttpError, agreement hashes
    ├── r2.ts                       [new] putArticleHTML/Manifest, getArticleHTML/Manifest etc.
    ├── db/queries.ts               [new] typed D1 helpers
    ├── api/
    │   ├── submit.ts               [new] D1+R2 publishing (no GitHub)
    │   └── export.ts               [new] /verify/<uuid>/export tar.gz
    ├── pages/
    │   ├── landing.ts              [new] /
    │   ├── zone.ts                 [new] /finance/ /web3/
    │   ├── article.ts              [new] /<zone>/<slug>/ iframe chrome
    │   ├── raw_article.ts          [new] /<zone>/<slug>/article R2 byte passthrough
    │   ├── verify.ts               [new] /verify/<uuid> + /verify/<uuid>/manifest.json
    │   ├── agreement.ts            [new] /agreement/v1, /agreement/v2
    │   ├── about.ts                [new] /about
    │   ├── submit_form.ts          [new] /submit
    │   ├── error.ts                [new] 404 / 410 / 5xx chrome
    │   └── _article_row.ts         [new] shared listing row markup
    ├── templates/shell.ts          [new] HTML chrome (ported from site/build.py _shell)
    └── util/
        ├── html.ts                 [new] escape, formatDate, etc.
        ├── md.ts                   [new] markdown → HTML (ported from build.py)
        ├── payload.ts              [new] parsePayload (multipart + JSON)
        ├── slug.ts                 [new] kebabSlug, pickAvailableSlug (D1-backed)
        ├── skill_check.ts          [new] verifySkillRepoPublic, verifySkillCommit (anonymous GH)
        ├── rate_limit.ts           [new] enforceIpRateLimit (KV, fail-soft)
        └── manifest.ts             [new] buildManifest

tools/
├── migrate_to_d1.py                [new] one-shot generator
├── migrate.sql                     [generated] D1 INSERTs for founder + 4 articles
└── migrate.sh                      [generated] wrangler r2 object put for the bytes
```

Total: 1 file edited, 27 files created. ~3,000 lines of TypeScript +
~250 lines of SQL + ~200 lines of Python.

The Worker typechecks clean (`npx tsc --noEmit -p worker/` succeeds with
zero errors).

## Not yet built (Phase B+)

`/signup`, `/login`, `/me`, `/u/<handle>`, `/api/articles/.../like`,
`/skills`, `/feed.xml`, `/sitemap.xml`, agreement-v3 — these intentionally
404 in Phase A. They ship in Phase B, C, D, E per the plan.
