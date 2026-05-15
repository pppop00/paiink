# paiink-api

Cloudflare Worker (name: `paiink-api`) that accepts AI-generated article submissions for
[pai.ink](https://www.paiink.com), validates them, and commits the article
HTML plus a provenance manifest (`ai-audit.json`) to `pppop00/paiink` as a
single atomic commit. 4EVERLAND watches `main` and rebuilds in ~60–90s.

## What it does (agreement v2+)

`POST /submit` (at `api.paiink.com`) or `POST /api/submit` (at workers.dev)
accepts either `application/json` (for AI agents) or `multipart/form-data`
(for browser forms). Both yield the same internal payload.

**No GitHub login. No PAT.** Submitter identity = declared `display_name`
and `email`. The Worker:

1. Validates the payload shape (required fields, email syntax,
   `agreement_accepted == true`, HTML ≤ 5 MB).
2. Enforces a soft per-IP daily rate limit via KV (5/IP/day, fail-soft
   if the KV binding is missing).
3. Verifies the declared skill repo is public on GitHub and the declared
   commit hash exists in it.
4. Picks an available slug `<kebab-title>-<YYYY-MM-DD-UTC>`, auto-incrementing
   `-v2`, `-v3`, … if collisions occur.
5. Builds the `ai-audit.json` manifest with server-set fields:
   `content_sha256` of the HTML, `published_at` from server time, the
   pinned agreement v2 SHA256, a UUID v4 article id, and the declared
   `author.email` + `author.display_name`.
6. Commits both files to `main` via the Git Data API (blob → tree → commit
   → ref), so the user sees a single commit, not two.

The committer identity is `paiink-submit <submit@paiink.com>` (service
identity, distinct from any human contributor). The `GITHUB_TOKEN` secret
is the Worker's PAT for writing commits — it is **not** related to any
submitter; submitters do not supply a PAT.

## Deploy

```bash
cd worker
npm install
npx wrangler login                              # one-time

# Fine-grained PAT, scoped to pppop00/paiink, with Contents: Read and write.
npx wrangler secret put GITHUB_TOKEN

npx wrangler deploy
```

Then bind the Worker to a **Custom Domain** in the Cloudflare dashboard
(www.paiink.com is grey-cloud DNS-only for CN reach, so Routes don't work):

1. **Workers & Pages → `paiink-api` → Settings → Domains & Routes**
2. Add Custom Domain: `api.paiink.com`

CF auto-creates DNS + cert (~30s).

For IP rate limiting, also bind a KV namespace:

1. **Workers & Pages → KV → Create namespace** (name e.g. `paiink-rl`)
2. Copy the namespace id into `wrangler.toml`'s `kv_namespaces` block
3. `npx wrangler deploy`

If the KV binding is absent, the Worker still runs — rate limiting is
fail-soft. You can also stack Cloudflare WAF rate-limiting rules at the
edge for hard limits.

## Local dev

```bash
# worker/.dev.vars  (gitignored)
GITHUB_TOKEN=ghp_xxx
```

```bash
npx wrangler dev          # serves on http://localhost:8787
npm run tail              # tail production logs
```

Smoke test:

```bash
curl -X POST http://localhost:8787/submit \
  -H "Content-Type: application/json" \
  -d @sample-payload.json
```

## Response shape

```json
{
  "slug": "otis-worldwide-2026-05-15",
  "url": "https://www.paiink.com/finance/otis-worldwide-2026-05-15/",
  "live_in_seconds_estimate": 90,
  "commit_sha": "abc123…"
}
```

All errors return `{"error": "<short>", "detail": "<longer>"}` with the
appropriate status (`400` validation, `403` agreement not accepted,
`409` slug exhausted or branch moved, `413` HTML too big, `415`
unsupported Content-Type, `429` IP rate limit, `503` GitHub upstream
issue, `500` internal).

## Files

- `wrangler.toml` — Worker config; routes are bound in the CF dashboard.
- `src/index.ts` — all logic. Pure Web APIs (no Node deps).
- `package.json`, `tsconfig.json` — TypeScript strict, dev deps only.
