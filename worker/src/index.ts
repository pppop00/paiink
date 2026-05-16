/**
 * paiink Worker entrypoint.
 *
 * Thin shim — all routing logic lives in `router.ts`. This file's only job
 * is to satisfy the Workers module-fetch contract and provide a last-ditch
 * catch for anything the router didn't handle.
 *
 * The single-Worker architecture took over from Cloudflare Pages in Phase A
 * (see /Users/pppop/.claude/plans/adaptive-plotting-pony.md). The Worker:
 *   • Serves HTML pages (landing, zones, articles, verify, agreement, about,
 *     submit form, 404)
 *   • Streams raw article bytes from R2 byte-identically (content_sha256
 *     contract preserved)
 *   • Builds verification export bundles (.tar.gz) on demand
 *   • Accepts submissions via /api/submit (handled by api/submit.ts)
 *
 * Phase B+ work (auth, likes, profile pages) plugs into router.ts without
 * touching this file.
 */

import { route } from "./router";
import type { Env } from "./types";

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (err) {
      // Router does its own HttpError handling — this is the very-last
      // safety net for programmer errors (uncaught throws, etc.).
      console.error("unhandled error in router:", err);
      return new Response("internal error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
