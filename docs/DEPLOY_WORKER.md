# DEPLOY_WORKER.md — getting the /api/submit endpoint live

This is the **admin-only** deploy guide for the Cloudflare Worker at
`worker/` that powers https://www.paiink.com/api/submit. Authors don't need
to read this; they just visit `/submit/`.

Total time: **~30 minutes** the first time.

---

## What this Worker does

```
Browser form OR agent POST
   │  POST /api/submit
   ▼
Cloudflare Worker (worker/src/index.ts)
   │  ① verify submitter PAT via GET /user
   │  ② check account age ≥ 30 days
   │  ③ check skill repo public + commit exists
   │  ④ rate-limit: ≤ 5 articles/day/author (global)
   │  ⑤ auto-version slug (+v2/+v3)
   │  ⑥ build manifest (with pinned agreement v1 hash)
   │  ⑦ atomic commit via GitHub Git Data API
   │     (committer: paiink-submit <submit@paiink.com>)
   ▼
GitHub main on pppop00/paiink  →  4EVERLAND rebuild  →  live URL
```

Worker secret needed: `GITHUB_TOKEN` (Fine-grained PAT, Contents R+W on `pppop00/paiink` only).

---

## Prereqs

- [ ] Cloudflare account (free; sign up with GitHub OAuth at https://dash.cloudflare.com).
- [ ] `paiink.com` (and `www.paiink.com`) DNS already in Cloudflare. Confirm at https://dash.cloudflare.com → your account → DNS.
- [ ] Node 18+ locally (for `wrangler`).

---

## Step 1 — Generate the Worker's GitHub PAT

This is **distinct** from the PAT that submitters use. The Worker needs write
access to commit articles; submitters only need read on `/user`.

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

First deploy creates the Worker named `paiink-submit` under your Cloudflare
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

## Step 4 — Bind the route `paiink.com/api/*`

This makes the Worker handle requests at `https://www.paiink.com/api/submit`
instead of the throwaway `*.workers.dev` URL.

1. https://dash.cloudflare.com → your account → **Workers & Pages** → `paiink-submit` → **Settings** → **Triggers**
2. Under **Routes**, click **Add route**.
3. Route: `www.paiink.com/api/*`
4. Zone: `paiink.com`
5. Save.

(If you also want bare-domain support: add a second route `paiink.com/api/*`.)

The static site (4EVERLAND IPFS) keeps serving everything **else**;
Cloudflare's edge intercepts `/api/*` and runs the Worker.

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
# This will REJECT with 401 — no Authorization header
curl -X POST http://localhost:8787/api/submit \
  -H "Content-Type: application/json" \
  -d '{}'
```

You should see `{"error":"auth","detail":"missing Authorization: Bearer header"}`. That's the Worker live. ✓

To actually submit an article in dev: use a test PAT you generated yourself
(not your production token) and point the Worker at a fork or test repo by
editing `REPO_OWNER`/`REPO_NAME` constants temporarily in `src/index.ts`.

---

## Step 6 — End-to-end test on production

After Steps 1–4 are done:

1. Visit https://www.paiink.com/submit/
2. Generate a personal PAT with **no scopes** (see Submit page warning box)
3. Pick a small test HTML, fill the form, accept the agreement, submit
4. Expect: 200 response with slug + URL
5. Wait ~90s, visit the URL — article should be live
6. Retract immediately if it was a test: `python3 tools/unpublish.py finance/<slug> --reason "test submission"`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 GitHub temporarily unavailable` | Real GitHub outage or rate limit hit | Wait, retry. Check https://www.githubstatus.com |
| `401 invalid PAT` on every submit | Worker's `GITHUB_TOKEN` not set | Re-run `wrangler secret put GITHUB_TOKEN` |
| Submits succeed but article never appears | Route binding wrong | Check Step 4. Worker logs: `npx wrangler tail` |
| Worker logs say "ref update conflict" | Two submitters raced | Resubmit; Worker uses `force:false` deliberately |
| Browser CORS error | CORS origin mismatch | Check Worker `Access-Control-Allow-Origin` is `https://www.paiink.com` (it is in source) |

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
