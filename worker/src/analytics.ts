/**
 * Cloudflare Web Analytics — cookieless, privacy-respecting JS beacon.
 *
 * To enable:
 *   1. CF Dashboard → Analytics & Logs → Web Analytics → Add a site
 *   2. Enter `www.paiink.com` (and `paiink.com` if you want apex too)
 *   3. Copy the token from the JS snippet that CF gives you. It looks
 *      like: data-cf-beacon='{"token":"abc123…"}'
 *   4. Paste that token into CF_ANALYTICS_TOKEN below and redeploy.
 *
 * When the token is empty (default), no beacon script is emitted — the
 * site behaves exactly as before. CF's built-in server-side analytics
 * (which any proxied zone gets for free) still works regardless.
 *
 * Note: the token is publicly visible in every page's HTML — it's not a
 * secret. Anyone can scrape it and pretend to be us. That's CF's design;
 * it's a routing key, not a credential.
 */

export const CF_ANALYTICS_TOKEN = "";

export function analyticsBeacon(): string {
  if (!CF_ANALYTICS_TOKEN) return "";
  return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${CF_ANALYTICS_TOKEN}"}'></script>`;
}
