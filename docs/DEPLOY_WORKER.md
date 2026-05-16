# DEPLOY_WORKER.md — getting the submit endpoint live

This is the **admin-only** deploy guide for the Cloudflare Worker at
`worker/` that powers https://api.paiink.com/submit. Authors don't need
to read this; they just visit https://www.paiink.com/submit/.

Total time: **~30 minutes** the first time.

---

## What this Worker does (agreement v2+)

```
Browser form OR agent POST
   │  POST /submit  (via api.paiink.com Custom Domain)
   ▼
Cloudflare Worker (worker/src/index.ts)
   │  ① validate payload (email syntax, agreement checkbox, etc.)
   │  ② IP rate limit via KV (3/IP/day, fail-soft)
   │  ③ check skill repo public + commit exists
   │  ④ auto-version slug (+v2/+v3)
   │  ⑤ build manifest with pinned agreement v2 hash + author.email
   │  ⑥ atomic commit via GitHub Git Data API
   │     (committer: paiink-submit <submit@paiink.com>)
   ▼
GitHub main on pppop00/paiink  →  4EVERLAND rebuild  →  live URL
```

Worker resources needed:
- **Secret** `GITHUB_TOKEN`: Fine-grained PAT (Contents R+W on `pppop00/paiink` only) — Worker uses this to commit. **Not** related to submitters; submitters supply no credential.
- **KV namespace** bound as `KV_RATE_LIMIT`: backs per-IP daily rate limit. Optional but recommended.

---

## Prereqs

- [ ] Cloudflare account (free; sign up with GitHub OAuth at https://dash.cloudflare.com).
- [ ] `paiink.com` (and `www.paiink.com`) DNS already in Cloudflare. Confirm at https://dash.cloudflare.com → your account → DNS.
- [ ] Node 18+ locally (for `wrangler`).

---

## Step 1 — Generate the Worker's GitHub PAT

The Worker needs write access to commit articles on behalf of submitters.
**Submitters supply no credential at all** (agreement v2+); the Worker
authenticates as itself.

1. Go to https://github.com/settings/personal-access-tokens/new
2. Fill in:
   - **Token name**: `paiink-worker`
   - **Expiration**: 1 year (set a reminder to rotate)
   - **Resource owner**: `pppop00`
   - **Repository access** → Only select repositories → `pppop00/paiink`
   - **Repository permissions** → **Contents: Read and write**
   - All other permissions: **No access**
3. Generate token. **Copy it** — only shown once.

Save the token somewhere temporary; you'll paste it as a Worker secret in Step 3.

---

## Step 2 — Install wrangler + deploy the Worker

```bash
cd /Users/pppop/Desktop/Projects/paiink/worker

npm install                         # installs wrangler + types
npx wrangler login                  # opens browser; sign in with Cloudflare
                                    # (one-time per machine)

npx wrangler deploy                 # uploads the Worker
```

First deploy creates the Worker named `paiink-api` under your Cloudflare
account. You'll see a `*.workers.dev` URL in the output — **don't use it for
production**; we'll bind a clean route in Step 4.

---

## Step 3 — Set the GITHUB_TOKEN secret

```bash
cd /Users/pppop/Desktop/Projects/paiink/worker
npx wrangler secret put GITHUB_TOKEN
# paste the PAT from Step 1 when prompted; ENTER
```

Verify:

```bash
npx wrangler secret list
# should show: GITHUB_TOKEN
```

The secret is encrypted at rest in Cloudflare and never visible after this.
If you ever need to rotate: re-run `wrangler secret put GITHUB_TOKEN` with a
new value; the Worker picks up the new value on the next request.

---

## Step 4a — Create KV namespace for rate limiting (optional but recommended)

1. https://dash.cloudflare.com → **Workers & Pages** → **KV** (left sidebar)
2. **Create namespace**. Name: `paiink-rl` (any name; only the id matters).
3. Copy the namespace **ID** (a 32-hex string).
4. In `worker/wrangler.toml`, uncomment and fill in:
   ```toml
   [[kv_namespaces]]
   binding = "KV_RATE_LIMIT"
   id = "<paste-id-here>"
   ```
5. `cd worker && npx wrangler deploy`.

If you skip this, the Worker still runs — rate limiting becomes a no-op
(fail-soft). You can also stack edge-level limits via Cloudflare WAF
rate-limiting rules on `api.paiink.com/*`.

---

## Step 4b — Add Custom Domain `api.paiink.com`

`www.paiink.com` is grey-cloud DNS-only → BunnyCDN (kept that way for CN
reach via 4EVERLAND). Cloudflare Workers Routes only intercept traffic that
flows through Cloudflare, so we **cannot** bind the Worker to
`www.paiink.com/api/*`. Use a separate subdomain instead:

1. https://dash.cloudflare.com → **Workers & Pages** → `paiink-api` → **Settings** → **Triggers**
2. Under **Custom Domains**, click **Add Custom Domain**.
3. Domain: `api.paiink.com`
4. Add.

Cloudflare auto-creates the DNS record for `api.paiink.com` and provisions a
Let's Encrypt certificate. Takes ~30 seconds to go live.

After this:
- `https://api.paiink.com/submit` → Worker
- `https://www.paiink.com/` → BunnyCDN (unchanged, still fast in CN)
- CORS already allows `https://www.paiink.com` as origin, so the submit
  form at `www.paiink.com/submit/` can POST cross-origin to `api.paiink.com`.

---

## Step 5 — Local dev (optional but recommended before going live)

```bash
cd /Users/pppop/Desktop/Projects/paiink/worker

# Create .dev.vars (gitignored) with a TEST PAT (preferably to a fork
# you don't mind committing to during dev — NOT the production token)
echo "GITHUB_TOKEN=<dev-pat>" > .dev.vars

npx wrangler dev
# → http://localhost:8787
```

Smoke test:

```bash
# This will REJECT with 400 — missing required fields
curl -X POST http://localhost:8787/submit \
  -H "Content-Type: application/json" \
  -d '{}'
```

You should see something like `{"error":"validation","detail":"title must be a string"}`. That's the Worker live. ✓

To actually submit an article in dev: use a test PAT you generated yourself
(not your production token) and point the Worker at a fork or test repo by
editing `REPO_OWNER`/`REPO_NAME` constants temporarily in `src/index.ts`.

---

## Step 6 — End-to-end test on production

After Steps 1–4 are done:

1. Visit https://www.paiink.com/submit/
2. Pick a small test HTML, fill the form (display name + email + skill metadata + agreement checkbox), submit
3. Expect: 200 response with slug + URL
4. Wait ~90s, visit the URL — article should be live
5. Retract immediately if it was a test: `python3 tools/unpublish.py finance/<slug> --reason "test submission"`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 GitHub temporarily unavailable` | Real GitHub outage or token rate limit | Wait, retry. Check https://www.githubstatus.com |
| `500 internal` on every submit + logs mention GitHub 401 | Worker's `GITHUB_TOKEN` not set / expired | Re-run `wrangler secret put GITHUB_TOKEN` |
| Submits succeed but article never appears | Custom Domain not bound | Check Step 4b. Worker logs: `npx wrangler tail` |
| Worker logs say "ref update conflict" | Two submitters raced | Resubmit; Worker uses `force:false` deliberately |
| Browser CORS error | CORS origin mismatch | Check Worker `Access-Control-Allow-Origin` is `https://www.paiink.com` (it is in source) |
| Rate limit triggering on first submit | KV namespace populated from a prior test, or wrong key format | `wrangler kv:key list --binding KV_RATE_LIMIT` to inspect; delete stale keys |

---

## Identity in commit log

Worker-created commits have committer identity:
- Name: `paiink-submit`
- Email: `submit@paiink.com`

This **deliberately** differs from your personal commit identity
(`Zelong <oliverun6@gmail.com>`), so `git log` cleanly separates
admin commits from Worker-generated submissions:

```bash
git log --pretty='%h %an <%ae> — %s' | head
6a47c31 Zelong <oliverun6@gmail.com> — Add Apache License 2.0
e567cf4 Zelong <oliverun6@gmail.com> — publish.py: add --no-cards flag
a55ae8a paiink-submit <submit@paiink.com> — publish: Otis Worldwide  ← example
```

You don't need to configure DNS or actually receive mail at `submit@paiink.com` — it's a label, not a working mailbox. If you want it to actually route, add it to your Cloudflare Email Routing alongside `report@` and `legal@`.

---

## Rotating the Worker PAT

When the PAT approaches expiry:

```bash
# 1. Generate a fresh PAT (Step 1)
# 2. Update the Worker secret:
cd /Users/pppop/Desktop/Projects/paiink/worker
npx wrangler secret put GITHUB_TOKEN
# 3. Revoke the old PAT at https://github.com/settings/tokens
```

Worker picks up the new secret on the next request — no redeploy needed.

---

## Costs

| Component | Free tier | Likely usage |
|---|---|---|
| Cloudflare Worker | 100k requests/day | ≪ 100/day for this site |
| Cloudflare DNS + CDN | unlimited | already in use |
| GitHub API | 5000 reqs/hour with PAT | ≪ 50/article |
| 4EVERLAND Hosting | per HOSTING.md | unaffected (Worker is on CF, not 4EVERLAND) |

Effective monthly cost for the Worker: **$0** until you're shockingly viral.
