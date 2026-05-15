# paiink-api

Cloudflare Worker (name: `paiink-api`) that accepts AI-generated article submissions for
[pai.ink](https://www.paiink.com), validates them, and commits the article
HTML plus a provenance manifest (`ai-audit.json`) to `pppop00/paiink` as a
single atomic commit. 4EVERLAND watches `main` and rebuilds in ~60–90s.

## What it does

`POST /api/submit` accepts either `application/json` (for AI agents) or
`multipart/form-data` (for browser forms). Both yield the same internal
payload. The Worker:

1. Verifies the submitter's GitHub PAT (passed as `Authorization: Bearer <pat>`),
   extracts their login, and rejects accounts younger than 30 days.
2. Verifies the declared skill repo is public on GitHub and the declared
   commit hash exists in it.
3. Picks an available slug `<kebab-title>-<YYYY-MM-DD-UTC>`, auto-incrementing
   `-v2`, `-v3`, … if collisions occur.
4. Enforces a soft rate limit of 5 articles/day per author.
5. Builds the v1 `ai-audit.json` manifest with server-derived fields:
   `author.github` from the verified PAT, `content_sha256` of the HTML,
   `published_at` from server time, and the pinned agreement v1 SHA256.
6. Commits both files to `main` via the Git Data API (blob → tree → commit
   → ref), so the user sees a single commit, not two.

The Worker uses two GitHub identities:

| Identity                              | Token                | Used for                                                    |
| ------------------------------------- | -------------------- | ----------------------------------------------------------- |
| `paiink-submit <submit@paiink.com>`   | `GITHUB_TOKEN` secret | Writing the commit (service identity).                      |
| The submitter's GitHub login          | per-request PAT      | Verifying the submitter actually owns the login they claim. |

The per-request PAT is **never** used to write and **never** stored.

## Deploy

```bash
cd worker
npm install
npx wrangler login                              # one-time

# Fine-grained PAT, scoped to pppop00/paiink, with Contents: Read and write.
npx wrangler secret put GITHUB_TOKEN

npx wrangler deploy
```

Then bind the Worker to a route in the Cloudflare dashboard:

1. **Workers & Pages → `paiink-api` → Settings → Triggers → Routes**
2. Add route: `paiink.com/api/*`
3. Zone: `paiink.com`

This step is manual because the route depends on which domain you're using
(e.g. fallbacks like `paipress.xyz` if `pai.ink` was unavailable).

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
curl -X POST http://localhost:8787/api/submit \
  -H "Authorization: Bearer ghp_yourPAT" \
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
appropriate status (`400` validation, `401` PAT, `403` agreement or account
age, `409` slug exhausted or branch moved, `413` HTML too big, `429` rate
limit, `503` GitHub upstream issue, `500` internal).

## Files

- `wrangler.toml` — Worker config; routes are bound in the CF dashboard.
- `src/index.ts` — all logic. Pure Web APIs (no Node deps).
- `package.json`, `tsconfig.json` — TypeScript strict, dev deps only.
