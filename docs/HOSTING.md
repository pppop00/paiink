# Hosting: 4EVERLAND (IPFS + global CDN)

This doc walks through getting pai live on a setup that's free at our scale
and reachable from both Mainland China and the US **without ICP filing**.

## Why 4EVERLAND

- Free tier: 6 GB storage + 100 GB/month bandwidth. We're a static site of
  HTML + a few images per article. Headroom for ~10k articles before we
  even think about paid plans.
- IPFS-native: every deploy gets a content-addressed CID. The same CID is
  served from CDN edge POPs in Asia (HK, Singapore, Tokyo) and the US
  (Virginia, California), so latency is fine on both sides of the Pacific.
- Works in Mainland China: the standard 4EVERLAND domains
  (`*.4everland.app`) and their gateway IPs are not blocked. For a custom
  domain (`pai.ink`), we proxy via 4EVERLAND CDN and the request egress is
  from non-blocked endpoints.
- No ICP filing required: the origin and CDN POPs are outside Mainland
  China, so this is "境外站点" by definition — China users access via the
  open Internet.
- Web3-native bonus: every article's CID is a permanent IPFS reference.
  Anchors directly into the `ai-audit.json` `transcript_storage` and
  `timestamp_anchor.kind = "ipfs"` fields.

## What you set up once

### 1. Domain
Pick a domain (working name: `pai.ink`; back-ups in `README.md`). Register
through Cloudflare Registrar — it's at-cost pricing, no markup, includes
free WHOIS privacy and DNSSEC. We're going to use Cloudflare *only* as a
registrar + DNS host; the CDN in front of the site is 4EVERLAND's.

### 2. 4EVERLAND project
1. Sign up at https://www.4everland.org with GitHub OAuth.
2. Create a **Hosting** project, source = "GitHub repo", point at this repo
   (`pai`).
3. Build settings:
   - Framework: `Astro` (auto-detected once we add the site scaffold).
   - Build command: `cd site && npm ci && npm run build`.
   - Output directory: `site/dist`.
4. Storage backend: choose **IPFS** (default). 4EVERLAND will pin every
   build to its IPFS gateway and assign a CID.
5. After first build you'll get:
   - A `*.4everland.app` URL (immediate)
   - An IPFS CID per build
   - A "Custom Domain" tab where you bind `pai.ink`

### 3. DNS at Cloudflare
In Cloudflare DNS for the `pai.ink` zone:

```
Type  Name   Content                        Proxy
A     @      <4EVERLAND-provided IPv4>      DNS only (grey cloud)
AAAA  @      <4EVERLAND-provided IPv6>      DNS only
CNAME www    pai.ink                         DNS only
TXT   @      pai-site-verification=<token>  DNS only (during binding only)
```

**Important:** keep the proxy *off* (grey cloud) on these records.
Cloudflare's orange-cloud proxy is the part that's flaky in China — we
want the request to land directly on 4EVERLAND's POPs, which have better
China reach.

We still use Cloudflare for: registrar, DNS hosting, DNSSEC, MX records,
and analytics on subdomains we *do* want proxied.

### 4. HTTPS
4EVERLAND auto-issues a Let's Encrypt cert once DNS resolves. Nothing for
us to do.

### 5. Bot identity for verifier commits
Create a GitHub PAT (fine-grained) scoped to this repo with `contents:
write` + `pull-requests: write`. Store as `PAI_BOT_TOKEN` secret. The
verifier workflow can post the `verifier{}` block back into the PR.
(Implemented in a follow-up step — for now CI just gates merges.)

## What you do per deploy

Nothing. 4EVERLAND watches `main` on this repo. Every merge:

1. Triggers a build on 4EVERLAND.
2. Produces a new IPFS CID.
3. Updates the DNSLink record (optional, if you want `pai.eth` / IPNS
   resolution).
4. Invalidates CDN caches at all POPs.

Typical end-to-end latency from merge → user-visible: ~60 seconds.

## What you do per article

1. Author opens a PR adding `content/<finance|web3>/<slug>/`.
2. `verify.yml` Action runs `tools/verify_audit.py`.
3. If green, you merge. Site rebuilds automatically.
4. The article is reachable at `https://pai.ink/<finance|web3>/<slug>/` and
   permanently at `ipfs://<article-cid>/`.

## Costs at our scale

| Item | Monthly |
|---|---|
| 4EVERLAND Hosting (free tier) | $0 |
| Cloudflare DNS + Registrar | ~$0.83 (domain amortized; everything else free) |
| GitHub Actions on public repo | $0 |
| **Total** | **<$1** |

We start paying when we cross 100 GB/month of bandwidth — at that point
4EVERLAND's "Pro" tier is $20/month for 1 TB. We'll be famous by then.

## When to add a second CDN

If Mainland China latency degrades (we'll instrument with Sentry + a small
client-side beacon to a `pai.ink/_beacon` route), add **bunny.net** with a
HK POP as a parallel CDN. Switch DNS to load-balance via Cloudflare Load
Balancer (~$5/mo). The IPFS layer doesn't change.

## When to add ICP filing

Only if/when we want a `.cn` mirror or want to run an origin server inside
Mainland China for sub-50ms latency. Until then, the境外 setup above is
fine.

## Open questions to decide before launch

1. Domain pick (see README — `pai.ink` likely unavailable).
2. Whether to anchor article hashes on-chain. Default: yes for Web3 zone,
   no for Finance zone. We can flip per-zone later.
3. Who has merge rights on the articles-repo. Suggest: pppop00 + 1 trusted
   reviewer at first.
