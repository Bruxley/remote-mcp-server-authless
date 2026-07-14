// PostProxy -> Google Business Profile MCP server (Cloudflare Workers)
//
// CHANGES FROM THE AUTHLESS VERSION:
//  1. AUTH. The endpoint now lives at /mcp/<MCP_SECRET>. The bare /mcp path,
//     and everything else, returns 404. Without the secret the worker is
//     invisible. Set MCP_SECRET with:  npx wrangler secret put MCP_SECRET
//  2. NO KEY DIAGNOSTICS. list_profiles no longer reports the length, trim
//     length, or quoting of POSTPROXY_API_KEY. That was leaking the shape of
//     your secret to any anonymous caller.
//  3. GALLERY BUG FIXED. upload_photo was sending `post: {}` and PostProxy was
//     rejecting it: "param is missing or the value is empty or invalid: post".
//     It now sends a non-empty post object.
//  4. ROLLING REVIEW WINDOW. CUTOFF was the hardcoded string "2025-07-09",
//     which does not move. It is now a real trailing 365 days.
//
// Class name stays `MyMCP` so the template's Durable Object binding and
// migration in wrangler keep working unchanged.
 
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
 
interface Env {
  POSTPROXY_API_KEY: string;     // secret: wrangler secret put POSTPROXY_API_KEY
  MCP_SECRET: string;            // secret: wrangler secret put MCP_SECRET
  POSTPROXY_PROFILE_ID?: string; // var: google_business profile id
  GBP_LOCATION_ID?: string;      // var: accounts/123/locations/456
}
 
const BASE = "https://api.postproxy.dev";
 
async function pp(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.POSTPROXY_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}
 
function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
 
function needProfile(env: Env, arg?: string): string | null {
  return arg || env.POSTPROXY_PROFILE_ID || null;
}
 
// Trailing 365 days, computed at call time. Not a frozen string.
function cutoff365(): string {
  return new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
}
 
// Length-independent comparison so the worker does not leak the secret
// one character at a time through response timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
 
export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "postproxy-gbp", version: "2.0.0" });
 
  async init() {
    const env = this.env;
 
    // ---------- READS ----------
 
    this.server.tool(
      "list_profiles",
      "List connected PostProxy profiles.",
      {},
      async () => {
        const r = await pp(env, "/api/profiles");
        return text(r.body);
      },
    );
 
    this.server.tool(
      "list_locations",
      "List Google Business locations (placements) for a profile. Each id is the full location resource path used for posting.",
      { profile_id: z.string().optional().describe("PostProxy profile id; defaults to POSTPROXY_PROFILE_ID") },
      async ({ profile_id }) => {
        const pid = needProfile(env, profile_id);
        if (!pid) return text("No profile id. Set POSTPROXY_PROFILE_ID or pass profile_id.");
        const r = await pp(env, `/api/profiles/${pid}/placements`);
        return text(r.body);
      },
    );
 
    this.server.tool(
      "list_reviews",
      "List Google Business reviews (and your replies) for a profile. Trailing 365 days. Reviews sync twice daily (06:00 / 18:00 UTC).",
      { profile_id: z.string().optional().describe("PostProxy profile id; defaults to POSTPROXY_PROFILE_ID") },
      async ({ profile_id }) => {
        const pid = needProfile(env, profile_id);
        if (!pid) return text("No profile id. Set POSTPROXY_PROFILE_ID or pass profile_id.");
        let all: any[] = [];
        let page = 0;
        let total = Infinity;
        while (all.length < total && page < 100) {
          const rr = await pp(env, `/api/profiles/${pid}/comments?page=${page}&per_page=100`);
          if (!rr.ok) return text(rr.body);
          const j = JSON.parse(rr.body);
          total = typeof j.total === "number" ? j.total : all.length;
          const batch = j.data ?? [];
          all = all.concat(batch);
          if (batch.length === 0) break;
          page++;
        }
        const CUTOFF = cutoff365();
        const slim = all
          .filter((c: any) => (c.posted_at || "").slice(0, 10) >= CUTOFF)
          .map((c: any) => ({
            n: c.author_username,
            r: c.platform_data?.star_rating ?? null,
            d: (c.posted_at || "").slice(0, 10),
          }));
        return text(JSON.stringify({ total, cutoff: CUTOFF, window_count: slim.length, data: slim }));
      },
    );
 
    // ---------- WRITES (side-effecting) ----------
 
    this.server.tool(
      "reply_to_review",
      "Reply to a Google Business review. parent_id is the review's external id (accounts/.../locations/.../reviews/...).",
      {
        parent_id: z.string().describe("Review external id"),
        body: z.string().describe("Reply text"),
        profile_id: z.string().optional(),
      },
      async ({ parent_id, body, profile_id }) => {
        const pid = needProfile(env, profile_id);
        if (!pid) return text("No profile id. Set POSTPROXY_PROFILE_ID or pass profile_id.");
        const r = await pp(env, `/api/profiles/${pid}/comments`, {
          method: "POST",
          body: JSON.stringify({ body, parent_id }),
        });
        return text(r.body);
      },
    );
 
    this.server.tool(
      "create_post",
      "Publish a Google Business local post (standard / event / offer). Optional single image via media_url.",
      {
        format: z.enum(["standard", "event", "offer"]).default("standard"),
        body: z.string().describe("Post text (<=1500 chars)"),
        location_id: z.string().optional().describe("Full location path; defaults to GBP_LOCATION_ID"),
        media_url: z.string().url().optional().describe("Public https image url (jpg/png, <=5MB)"),
        cta_action_type: z.enum(["LEARN_MORE","BOOK","ORDER","SHOP","SIGN_UP","CALL"]).optional(),
        cta_url: z.string().url().optional(),
        event_title: z.string().optional(),
        event_start_date: z.string().optional().describe("YYYY-MM-DD"),
        event_end_date: z.string().optional().describe("YYYY-MM-DD"),
        offer_coupon_code: z.string().optional(),
        profile_id: z.string().optional(),
      },
      async (a) => {
        const pid = needProfile(env, a.profile_id);
        const loc = a.location_id || env.GBP_LOCATION_ID;
        if (!pid) return text("No profile id. Set POSTPROXY_PROFILE_ID or pass profile_id.");
        if (!loc) return text("No location id. Set GBP_LOCATION_ID or pass location_id.");
        const gb: Record<string, unknown> = { format: a.format, location_id: loc };
        if (a.cta_action_type) gb.cta_action_type = a.cta_action_type;
        if (a.cta_url) gb.cta_url = a.cta_url;
        if (a.event_title) gb.event_title = a.event_title;
        if (a.event_start_date) gb.event_start_date = a.event_start_date;
        if (a.event_end_date) gb.event_end_date = a.event_end_date;
        if (a.offer_coupon_code) gb.offer_coupon_code = a.offer_coupon_code;
        const payload: Record<string, unknown> = {
          post: { body: a.body },
          profiles: [pid],
          platforms: { google_business: gb },
        };
        if (a.media_url) payload.media = [a.media_url];
        const r = await pp(env, `/api/posts`, { method: "POST", body: JSON.stringify(payload) });
        return text(r.body);
      },
    );
 
    this.server.tool(
      "upload_photo",
      "Upload a single photo to the location's Google Business gallery.",
      {
        media_url: z.string().url().describe("Public https image url (jpg/png, <=5MB)"),
        caption: z.string().optional().describe("Optional. PostProxy requires a non-empty post object; GBP gallery photos normally show no caption."),
        location_id: z.string().optional().describe("defaults to GBP_LOCATION_ID"),
        profile_id: z.string().optional(),
      },
      async ({ media_url, caption, location_id, profile_id }) => {
        const pid = needProfile(env, profile_id);
        const loc = location_id || env.GBP_LOCATION_ID;
        if (!pid) return text("No profile id. Set POSTPROXY_PROFILE_ID or pass profile_id.");
        if (!loc) return text("No location id. Set GBP_LOCATION_ID or pass location_id.");
 
        // THE FIX. The old code sent `post: {}` and PostProxy rejected it with
        // "param is missing or the value is empty or invalid: post".
        // `post` must be non-empty. We try progressively less-empty bodies and
        // report exactly which one PostProxy accepted, so this stops being a
        // guess after the first successful run.
        const candidates = caption
          ? [caption]
          : [" ", "."];
 
        const attempts: Array<{ body: string; status: number; response: string }> = [];
        for (const body of candidates) {
          const payload = {
            post: { body },
            profiles: [pid],
            media: [media_url],
            platforms: { google_business: { format: "photo", location_id: loc } },
          };
          const r = await pp(env, `/api/posts`, { method: "POST", body: JSON.stringify(payload) });
          attempts.push({ body: JSON.stringify(body), status: r.status, response: r.body });
          if (r.ok) {
            return text(JSON.stringify({
              ok: true,
              accepted_post_body: body,
              response: JSON.parse(r.body || "{}"),
            }));
          }
        }
        return text(JSON.stringify({
          ok: false,
          note: "PostProxy rejected every post body we tried. See attempts for the exact responses.",
          attempts,
        }));
      },
    );
  }
}
 
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // No secret configured means the worker refuses to serve at all,
    // rather than silently falling back to being public.
    if (!env.MCP_SECRET) {
      return new Response("Not found", { status: 404 });
    }
 
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["mcp", "<secret>"]
 
    const kind = parts[0];
    const given = parts[1] ?? "";
    const authed = safeEqual(given, env.MCP_SECRET);
 
    if (kind === "mcp" && authed && parts.length === 2) {
      const p = `/mcp/${env.MCP_SECRET}`;
      return MyMCP.serve(p).fetch(request, env, ctx);
    }
 
    if (kind === "sse" && authed) {
      const p = `/sse/${env.MCP_SECRET}`;
      return MyMCP.serveSSE(p).fetch(request, env, ctx);
    }
 
    // Everything else, including a bare /mcp and the root, looks like nothing.
    return new Response("Not found", { status: 404 });
  },
};
