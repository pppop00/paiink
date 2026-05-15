# DEPLOY.md — getting pai.ink live on 4EVERLAND

This is the click-by-click playbook for **step C** (the only step where
you're doing manual things). After this is done, every future deploy is
automatic: merge a PR → 4EVERLAND rebuilds in ~60s.

Estimated time end-to-end: **~30–45 minutes**, including the wait for
Cloudflare nameservers to propagate.

## Pre-flight checklist

You will need:

- [ ] A GitHub account (you have one: `pppop00`).
- [ ] A Cloudflare account (free).
- [ ] A 4EVERLAND account (free; sign up with GitHub OAuth).
- [ ] ~$15 in a card for the `pai.ink` registration (`.ink` is ~$13/yr at Cloudflare cost-price as of 2026).
- [ ] An ed25519 keypair (we'll generate it).

---

## Step 1 — Register `pai.ink`

1. Go to https://dash.cloudflare.com/?to=/:account/registrar
2. Search `pai.ink`. If available, register it (1 year is fine for v0).
3. Cloudflare automatically creates a DNS zone for the domain. Leave all
   the default records alone for now — we override them in step 4.

> **If `pai.ink` is taken:** fall back to `paipress.xyz` ($1/yr) or
> `provenai.io` ($35/yr). Then do a global find/replace in this repo:
> `git grep -l 'pai\.ink' | xargs sed -i '' 's|pai\.ink|<new-domain>|g'`
> and commit before continuing.

## Step 2 — Push this repo to GitHub

```bash
cd /Users/pppop/Desktop/Projects/pai
# If you haven't already initialized git:
# git init -b main && git add -A && git commit -m "initial commit"
gh repo create pai.ink --public --source=. --remote=origin --push
```

You should now have `https://github.com/pppop00/pai.ink`. Confirm in the
browser.

## Step 3 — Connect 4EVERLAND

1. Sign in: https://dashboard.4everland.org
2. Click **Hosting** in the left sidebar → **New Project**.
3. **Import Git Repository** → authorize GitHub → pick `pppop00/pai.ink`.
4. Build settings (4EVERLAND should auto-detect most of these from
   `site/package.json`; verify):

   | Field | Value |
   |---|---|
   | Framework Preset | **Other** (don't pick Astro yet) |
   | Root Directory | `site` |
   | Install Command | *(leave blank — we have no npm deps yet)* |
   | Build Command | `python3 build.py` |
   | Output Directory | `dist` |
   | Node Version | 20 |

   The build script needs Python 3.10+; 4EVERLAND's build container has
   Python 3.11 by default, so `python3 build.py` works without setup.

5. **Storage Backend** → choose **IPFS** (default). This gives you a CID
   for every build, which we'll use for Web3-zone anchoring later.
6. Click **Deploy**.

Within ~90 seconds you should see:
- Build log green.
- A preview URL like `https://pai-xxxxxxxx.4everland.app`.
- An IPFS CID like `bafybei...`.

**Open the preview URL.** You should see the landing page with the Waste
Management article seeded under "金融区 / Finance". Click into it — the
full Chinese equity research HTML should render with charts. Click
"校验" — the verify page should show the manifest details.

**If anything is broken at this point, stop and fix before binding the
custom domain.** You don't want to debug DNS while also debugging the
build.

## Step 4 — Bind `pai.ink`

In the 4EVERLAND project → **Settings → Domains → Add Domain**:

1. Add `pai.ink`. 4EVERLAND gives you two pieces of information:
   - An **IPv4** (and optionally IPv6) for the apex record.
   - A **TXT** record for ownership verification.

2. Back in Cloudflare DNS for `pai.ink` (https://dash.cloudflare.com →
   pai.ink → DNS → Records), set:

   ```
   Type   Name   Content                            Proxy status
   A      @      <4EVERLAND IPv4>                   DNS only (grey cloud)
   AAAA   @      <4EVERLAND IPv6, if given>         DNS only
   CNAME  www    pai.ink                            DNS only
   TXT    @      <4EVERLAND-provided token>         DNS only
   ```

   > **CRITICAL:** keep the orange/proxy cloud **off** for the A/AAAA on
   > apex. Cloudflare's proxy is the part that's flaky in China — we want
   > the request to hit 4EVERLAND's POPs directly.

3. In 4EVERLAND, hit **Verify**. Within 1–5 minutes the TXT propagates
   and the domain flips to "Active". 4EVERLAND auto-issues a Let's
   Encrypt cert; HTTPS works within ~5 more minutes.

4. Visit `https://pai.ink` — should be the same site as the preview URL.

5. Once HTTPS is green, **remove the TXT verification record** in
   Cloudflare (4EVERLAND no longer needs it).

## Step 5 — Measure latency in China + US

Run `tools/probe_latency.py` from at least:
- One US vantage point (your Mac on US Wi-Fi is fine).
- One Mainland China vantage point (cheapest: a $5/month
  Aliyun/Tencent Lightsail in Beijing or Shanghai for an hour, or ask a
  friend in China to run it).

```bash
python3 tools/probe_latency.py https://pai.ink --runs 20
```

It writes `latency-<hostname>-<isotime>.csv` with TTFB and full-page
times. Acceptance criteria for v0:

- **US median TTFB < 200 ms**, **p95 < 500 ms**.
- **CN median TTFB < 800 ms**, **p95 < 2500 ms**.
- **CN success rate ≥ 95%** (any DNS / TLS / connect failures count).

If CN p95 > 2500 ms or success rate < 95%, jump to "Plan B" below before
proceeding to step A (Astro).

## Step 6 — Wire CI for PRs

This is already done; the workflow at `.github/workflows/verify.yml`
runs on every PR that touches `content/**/ai-audit.json`. Confirm by:

1. Make a trivial PR (e.g. add a `tags` entry to the WM manifest).
2. Watch Actions tab — the "verify ai-audit manifests" job should run
   green.
3. Merge. 4EVERLAND auto-rebuilds.

## Step 7 — Generate your author key (one-time)

```bash
cd /Users/pppop/Desktop/Projects/pai
python3 tools/sign_audit.py keygen --out ~/.pai/ed25519.key
```

Take the printed public key (base64), save it as a public gist titled
`pai-public-key.txt`. From now on every manifest you publish will be
signed by this key, and verifiers can compare against the gist.

---

## Plan B — if China latency is bad

Two options, cheapest first.

### B1. Switch on Cloudflare proxy for the static parts only
- Turn the orange cloud back on for `/`, `/finance/*`, `/web3/*`.
- Leave the IPFS gateway routes (`/ipfs/*`) DNS-only.
- Cloudflare's free China Network is gated, but Cloudflare-proxied
  domains do route to their global POPs which sometimes outperform
  4EVERLAND from CN. ~5 minutes of work; A/B test on the probe script.

### B2. Add bunny.net as a secondary CDN with HK POP
- bunny.net signup → Pull Zone → origin = `pai.ink` (or the 4EVERLAND
  origin IP).
- Cost: ~$0.005/GB outbound, ~$1/mo at our scale.
- Switch DNS to a Cloudflare Load Balancer that geo-routes Chinese IPs to
  bunny's HK POP and everyone else to 4EVERLAND. Cloudflare LB is
  $5/month.

Do B2 only if B1 doesn't get CN p95 under 2.5 s.

---

## Common gotchas

- **DNSSEC**: Cloudflare auto-enables DNSSEC. 4EVERLAND should be fine
  with it; if HTTPS issuance hangs > 15 min, temporarily disable DNSSEC,
  let the cert issue, re-enable.
- **The `_locked_cn_skeleton.html` file** in anamnesis output is a
  template, not an article. Don't drop it into `content/`.
- **Build failing on 4EVERLAND**: 99% of the time it's a Python version
  mismatch. Add a `runtime.txt` with `python-3.11` if needed.
- **404 on `/finance/`**: 4EVERLAND defaults to no-trailing-slash; the
  current build outputs `finance/index.html`, which should work, but if
  not, in 4EVERLAND project settings turn on "Append `.html` extension"
  or "Try index.html".

---

## Acceptance: when is step C "done"

- [ ] `https://pai.ink` resolves and loads the landing page.
- [ ] The WM article renders end-to-end with charts.
- [ ] The `/verify/<id>` page shows manifest details.
- [ ] CN p95 TTFB ≤ 2500 ms, success rate ≥ 95%.
- [ ] A test PR triggers CI and merges cleanly.
- [ ] Author ed25519 public key gisted.

Once these are all ticked, move on to step A (Astro replaces the
placeholder builder).
