// PostProxy -> Google Business Profile MCP server (Cloudflare Workers, authless)
// Drop-in replacement for src/index.ts in the
//   cloudflare/ai/demos/remote-mcp-authless  template.
// Keep the class name `MyMCP` so the template's wrangler Durable Object
// binding + migration keep working unchanged.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  POSTPROXY_API_KEY: string;        // secret: wrangler secret put POSTPROXY_API_KEY
  POSTPROXY_PROFILE_ID?: string;    // var: your google_business profile id (prof_...)
  GBP_LOCATION_ID?: string;         // var: accounts/123/locations/456
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

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "postproxy-gbp", version: "1.0.0" });

  async init() {
    const env = this.env;

    // ---------- READS ----------

    this.server.tool(
      "list_profiles",
      "List connected PostProxy profiles (find your google_business profile id).",
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
      "List Google Business reviews (and your replies) for a profile, via the Profile Comments API. Reviews sync twice daily (06:00 / 18:00 UTC).",
      { profile_id: z.string().optional().describe("PostProxy profile id; defaults to POSTPROXY_PROFILE_ID") },
      async ({ profile_id }) => {
        const pid = needProfile(env, profile_id);
        if (!pid) return text("No profile id. Set POSTPROXY_PROFILE_ID or pass profile_id.");
        const r = await pp(env, `/api/profiles/${pid}/comments`);
        return text(r.body);
      },
    );

    // ---------- WRITES (side-effecting; confirm before using) ----------

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
      "Upload a single photo to the location's Google Business gallery (no caption/CTA).",
      {
        media_url: z.string().url().describe("Public https image url (jpg/png, <=5MB)"),
        location_id: z.string().optional().describe("defaults to GBP_LOCATION_ID"),
        profile_id: z.string().optional(),
      },
      async ({ media_url, location_id, profile_id }) => {
        const pid = needProfile(env, profile_id);
        const loc = location_id || env.GBP_LOCATION_ID;
        if (!pid) return text("No profile id. Set POSTPROXY_PROFILE_ID or pass profile_id.");
        if (!loc) return text("No location id. Set GBP_LOCATION_ID or pass location_id.");
        const payload = {
          post: {},
          profiles: [pid],
          media: [media_url],
          platforms: { google_business: { format: "photo", location_id: loc } },
        };
        const r = await pp(env, `/api/posts`, { method: "POST", body: JSON.stringify(payload) });
        return text(r.body);
      },
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    return new Response("PostProxy GBP MCP server. Connect an MCP client to /mcp", { status: 200 });
  },
};
