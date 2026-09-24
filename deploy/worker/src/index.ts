// ohqs edge API: search + models + index status served off Cloudflare D1.
// The search backend mirrors internal/index.Search; the models payload is a
// faithful port of internal/models so the public API shape matches the local
// Go server (see /v1/search, /v1/models, /v1/index, /v1/tools/{id}).
//
// Abuse posture: Cloudflare already provides network-layer DDoS filtering for
// all Workers traffic. On top of that this worker (a) rate-limits per IP via a
// Durable Object, (b) gates the credit-costing /v1/index/embed behind an admin
// token, and (c) sets strict response headers. Limits are tuned so a normal
// browser session never trips them but a scraper does.

import { search, searchBounties, embedderMeta } from "./search";
import { BountyClass } from "./bounties";
import { recommend, activeLabel } from "./models";
import { rateLimit, RateLimiter } from "./ratelimit";
import { buildPlan, markdown, RecommendRequest } from "./planner";
import { llmRecommend, llmEnabled, resolveLlmConfig } from "./llm";

export interface Env {
  D1: D1Database;
  AI?: Ai;
  RATE_LIMITER?: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  // Live playbook planner backend. Defaults to the Workers AI binding (free
  // tier) with DEFAULT_LLM_MODEL. Set LLM_BASE_URL to any OpenAI-compatible
  // /chat/completions endpoint (OpenAI, Groq, OpenRouter, llama.cpp...); set
  // LLM_API_KEY via `wrangler secret put` for Bearer auth. LLM_MODEL overrides
  // the model name (hosted-OpenAI default: gpt-4o-mini).
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";

// Per-IP limits (per window). Read endpoints are cheap; embed spends Workers AI
// credits so it is strict and additionally requires the admin token.
const LIMITS = {
  search: { limit: 60, window: 60_000 },
  bounties: { limit: 60, window: 60_000 },
  models: { limit: 60, window: 60_000 },
  tools: { limit: 120, window: 60_000 },
  index: { limit: 60, window: 60_000 },
  embed: { limit: 2, window: 60_000 },
  recommend: { limit: 10, window: 60_000 },
};

const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...baseHeaders },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function clientIP(request: Request): string {
  const cf = (request.headers.get("CF-Connecting-IP") || "")
    .split(",")[0]
    .trim();
  if (cf) return cf;
  return new URL(request.url).hostname || "unknown";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const corsMethod = method === "GET" || method === "POST" || method === "OPTIONS";
    const headersOnly = method === "OPTIONS";
    const ip = clientIP(request);

    // All non-CORS methods on the API are rejected outright.
    if (path.startsWith("/v1") && !corsMethod) return err("method not allowed", 405);

    // Rate limit — skip for CORS preflights (cheap, browser-initiated).
    let bucket: { limit: number; window: number } | null = null;
    if (!headersOnly) {
      if (path === "/v1/search") bucket = LIMITS.search;
      else if (path === "/v1/bounties") bucket = LIMITS.bounties;
      else if (path === "/v1/models") bucket = LIMITS.models;
      else if (toolPath(path)) bucket = LIMITS.tools;
      else if (path === "/v1/index") bucket = LIMITS.index;
      else if (path === "/v1/index/embed") bucket = LIMITS.embed;
      else if (path === "/v1/recommend") bucket = LIMITS.recommend;
    }
    if (bucket && !headersOnly) {
      const rl = await rateLimit(env, ip, path, bucket.limit, bucket.window);
      const retry = rl.retryAfterMs ? Math.ceil(rl.retryAfterMs / 1000) : 0;
      if (rl.limited) {
        return new Response(JSON.stringify({ error: "rate limited", retry_after_seconds: retry }), {
          status: 429,
          headers: { "Content-Type": "application/json; charset=utf-8", ...baseHeaders, "Retry-After": String(retry) },
        });
      }
    }

    // Preflight
    if (path.startsWith("/v1") && headersOnly) return new Response(null, { status: 204, headers: baseHeaders });

    // /v1/search
    if (path === "/v1/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 50);
      const result = await search(env.D1, env.AI ?? null, q, limit);
      return json(result);
    }

    // /v1/bounties — bounty/VDP listings only, split into marketplaces vs
    // single-org programs. Catalog /v1/search excludes these rows.
    if (path === "/v1/bounties" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const clsParam = (url.searchParams.get("class") ?? "marketplace").toLowerCase();
      const cls: BountyClass = clsParam === "program" ? "program" : clsParam === "contract" ? "contract" : "marketplace";
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 200);
      const result = await searchBounties(env.D1, env.AI ?? null, q, limit, cls);
      return json(result);
    }

    // /v1/index
    if (path === "/v1/index") {
      const exists = true;
      const { results } = await env.D1.prepare(`SELECT COUNT(*) AS n FROM records`).all<{ n: number }>();
      const records = (results?.[0]?.n as number) ?? 0;
      const vec = await env.D1.prepare(`SELECT COUNT(*) AS n FROM vectors`).all<{ n: number }>();
      const nVectors = (vec.results?.[0]?.n as number) ?? 0;
      const meta = await embedderMeta(env.D1);
      return json({
        exists,
        path: "d1",
        records,
        has_vectors: nVectors > 0,
        embedder: meta?.name || undefined,
        vector_dim: meta?.dim || undefined,
      });
    }

    // /v1/index/embed — costs Workers AI credits, so an admin token is required
    // and the per-IP rate limit is strict. Set ADMIN_TOKEN via
    //   wrangler secret put ADMIN_TOKEN
    // and pass it as:  Authorization: Bearer <token>
    // Chunked: ?offset=&count= (kept small, ~40, because a single Worker
    // invocation is limited to ~50 D1 subrequests). Run repeatedly to cover the
    // whole table; embed-edge.sh loops it. ?kind=contract filters by kind.
    if (path === "/v1/index/embed" && method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      const expected = env.ADMIN_TOKEN;
      if (!expected || auth !== `Bearer ${expected}`) {
        return err("admin token required", 401);
      }
      const model = url.searchParams.get("model") || EMBED_MODEL;
      const embedder = env.AI;
      if (!embedder) return err("AI binding not configured", 503);
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      const count = Math.min(Math.max(1, parseInt(url.searchParams.get("count") ?? "32", 10) || 32), 40);
      const kind = url.searchParams.get("kind") || "";
      let q = `SELECT id, name, kind, summary, tags, body FROM records`;
      const where: string[] = [];
      if (kind) where.push(`kind = '${kind.replace(/[^a-z0-9_-]/gi, "")}'`);
      if (where.length) q += " WHERE " + where.join(" AND ");
      q += " ORDER BY id LIMIT ? OFFSET ?";
      const { results } = await env.D1.prepare(q).bind(count, offset).all<{ id: string; name: string; kind: string; summary: string; tags: string; body: string }>();
      const recs = (results ?? []).map((r) => ({
        id: r.id,
        text: [r.name, r.kind, r.summary, r.tags, r.body].filter((x) => x).join(" "),
      }));
      let dim = 0;
      const BATCH = 16;
      for (let i = 0; i < recs.length; i += BATCH) {
        const batch = recs.slice(i, i + BATCH);
        let resp: unknown;
        try {
          resp = await embedder.run(model, { text: batch.map((b) => b.text) });
        } catch (e) {
          return err("workerd ai run failed: " + (e as Error).message, 500);
        }
        const raw = (resp as { data?: unknown[] })?.data ?? [];
        let vectors: number[][] = [];
        if (raw.length > 0 && Array.isArray(raw[0])) {
          vectors = raw as number[][];
        } else if (raw.length > 0 && typeof raw[0] === "object") {
          vectors = (raw as { embedding?: number[] }[]).map((e) => e.embedding ?? []);
        }
        if (vectors.length === 0) {
          return err("workers ai returned no embeddings: " + JSON.stringify(resp).slice(0, 800), 502);
        }
        for (let j = 0; j < batch.length; j++) {
          const v = vectors[j];
          if (!v || v.length === 0) continue;
          dim = Math.max(dim, v.length);
          await env.D1.prepare(`INSERT OR REPLACE INTO vectors(id, dim, vec) VALUES (?, ?, ?)`)
            .bind(batch[j].id, v.length, JSON.stringify(v))
            .run();
        }
      }
      if (dim > 0) {
        await env.D1.prepare(`INSERT OR REPLACE INTO metadata(key, value) VALUES ('vector_embedder', ?)`).bind(model).run();
        await env.D1.prepare(`INSERT OR REPLACE INTO metadata(key, value) VALUES ('vector_dim', ?)`).bind(dim.toString()).run();
      }
      return json({ embedded: recs.length, model, dim });
    }

    // /v1/models
    if (path === "/v1/models") {
      const ramgb = Math.min(parseFloat(url.searchParams.get("ramgb") ?? "16") || 16, 512);
      const vramgb = Math.min(parseFloat(url.searchParams.get("vramgb") ?? "0") || 0, 256);
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "6", 10) || 6, 20);
      const host = {
        ramgb,
        vramgb,
        label: vramgb > 0 ? "NVIDIA VRAM (reported by caller)" : "unified memory / system RAM (reported by caller)",
      };
      const fits = recommend(host, limit).map((r) => ({
        ...r,
        model: { ...r.model, activeb_label: activeLabel(r.model) },
      }));
      return json({ host, fits });
    }

    // /v1/recommend — deterministic template planner (no LLM). Mirrors the
    // local `ohqs recommend` gate: authorized=true + written scope required.
    // Returns the same Plan shape as the Go server. ?fmt=markdown for the
    // renderable playbook.
    if (path === "/v1/recommend" && method === "POST") {
      let body: RecommendRequest;
      try {
        body = (await request.json()) as RecommendRequest;
      } catch {
        return err("invalid JSON body", 400);
      }
      let plan: Awaited<ReturnType<typeof buildPlan>>;
      // Live LLM planner when a backend is configured (Workers AI binding by
      // default, or an OpenAI-compatible endpoint via LLM_BASE_URL); any failure
      // falls back to the deterministic template — mirrors internal/llm.Build.
      // Gate failures (situation required) surface as 400 because both paths
      // raise them before making a model call.
      const llmCfg = resolveLlmConfig(env);
      if (llmEnabled(llmCfg)) {
        try {
          plan = await llmRecommend(env.D1, llmCfg, body);
        } catch (e) {
          console.warn("LLM plan failed, using template:", (e as Error).message);
          try {
            plan = await buildPlan(env.D1, body);
          } catch (e2) {
            return err((e2 as Error).message, 400);
          }
          (plan as typeof plan & { planner_note?: string }).planner_note =
            "LLM plan failed (" + (e as Error).message + "); using template";
        }
      } else {
        try {
          plan = await buildPlan(env.D1, body);
        } catch (e) {
          return err((e as Error).message, 400);
        }
      }
      const fmt = url.searchParams.get("fmt") ?? "json";
      if (fmt === "markdown") {
        return new Response(markdown(plan), {
          headers: { "Content-Type": "text/markdown; charset=utf-8", ...baseHeaders },
        });
      }
      return json(plan);
    }

    // /v1/tools/{id}
    const toolMatch = path.match(/^\/v1\/tools\/(.+)$/);
    if (toolMatch) {
      const id = decodeURIComponent(toolMatch[1]);
      const found = await env.D1.prepare(`SELECT data FROM records WHERE id = ?`).bind(id).first<{ data: string }>();
      if (!found?.data) return err("not found", 404);
      try {
        return json(JSON.parse(found.data) as unknown);
      } catch {
        return err("invalid record json", 500);
      }
    }

    // /healthz
    if (path === "/healthz") {
      return new Response("ok\n", { headers: baseHeaders });
    }

    return err("not found", 404);
  },
} satisfies ExportedHandler<Env>;

function toolPath(path: string): boolean {
  return /^\/v1\/tools\/.+$/.test(path);
}

export { RateLimiter };