// ohqs edge API: search + models + index status served off Cloudflare D1.
// The search backend mirrors internal/index.Search; the models payload is a
// faithful port of internal/models so the public API shape matches the local
// Go server (see /v1/search, /v1/models, /v1/index, /v1/tools/{id}).
//
// Abuse posture: Cloudflare already provides network-layer DDoS filtering for
// all Workers traffic. On top of that this worker (a) rate-limits per IP and
// per client API token_id via a Durable Object, (b) gates credit-costing
// /v1/index/embed behind ai_admin (or admin Keycloak / emergency ADMIN_TOKEN),
// (c) audits every authenticated API-token call to D1, and (d) sets strict
// response headers. Auth is Keycloak OIDC (realm openhat, client ohqs-api) plus
// opaque hashed API tokens. ai_admin tokens skip rate limits but are still audited.

import { search, searchBounties, embedderMeta } from "./search";
import { BountyClass } from "./bounties";
import { recommend, activeLabel } from "./models";
import { rateLimit, RateLimiter } from "./ratelimit";
import { buildPlan, markdown, RecommendRequest } from "./planner";
import { llmRecommend, llmEnabled, resolveLlmConfig, listLlmModels } from "./llm";
import {
  verifyAccessToken,
  buildLoginUrl,
  handleCallback,
  signupClientUser,
  keycloakConfigured,
  isAdmin,
  type KeycloakUser,
} from "./auth/keycloak";
import {
  mintToken,
  lookupToken,
  touchToken,
  listTokens,
  revokeToken,
  logUsage,
  usageSummary,
  type ResolvedApiToken,
  type TokenType,
} from "./auth/tokens";

export interface Env {
  D1: D1Database;
  AI?: Ai;
  RATE_LIMITER?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  /** Emergency local-only embed gate. Prefer ai_admin API token. */
  ADMIN_TOKEN?: string;
  KEYCLOAK_ISSUER?: string;
  KEYCLOAK_CLIENT_ID?: string;
  KEYCLOAK_CLIENT_SECRET?: string;
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

// Strict per-identity limits across multiple windows. Both IP and user (when authenticated)
// are tracked; the stricter limit applies. Read endpoints are cheap; embed
// spends Workers AI credits so it is strict and additionally requires the admin
// token. recommend (playbook creation) is very strict to prevent abuse.
// Each endpoint has: minute, hour, and day limits.
const LIMITS = {
  search: {
    minute: { limit: 5, window: 60_000 },
    hour: { limit: 25, window: 3_600_000 },
    day: { limit: 100, window: 86_400_000 },
  },
  bounties: {
    minute: { limit: 30, window: 60_000 },
    hour: { limit: 100, window: 3_600_000 },
    day: { limit: 300, window: 86_400_000 },
  },
  models: {
    minute: { limit: 30, window: 60_000 },
    hour: { limit: 100, window: 3_600_000 },
    day: { limit: 300, window: 86_400_000 },
  },
  tools: {
    minute: { limit: 10, window: 60_000 },
    hour: { limit: 50, window: 3_600_000 },
    day: { limit: 200, window: 86_400_000 },
  },
  index: {
    minute: { limit: 30, window: 60_000 },
    hour: { limit: 100, window: 3_600_000 },
    day: { limit: 300, window: 86_400_000 },
  },
  embed: {
    minute: { limit: 2, window: 60_000 },
    hour: { limit: 10, window: 3_600_000 },
    day: { limit: 20, window: 86_400_000 },
  },
  recommend: {
    minute: { limit: 2, window: 60_000 },
    hour: { limit: 10, window: 3_600_000 },
    day: { limit: 25, window: 86_400_000 },
  },
  llmModels: {
    minute: { limit: 20, window: 60_000 },
    hour: { limit: 50, window: 3_600_000 },
    day: { limit: 150, window: 86_400_000 },
  },
};

const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...baseHeaders, ...extraHeaders },
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


type AuthContext = {
  /** Opaque OHQS API token (client or ai_admin). */
  apiToken: ResolvedApiToken | null;
  /** Validated Keycloak access-token session (console / OIDC). */
  kcUser: KeycloakUser | null;
  /** Emergency ADMIN_TOKEN match (local only). */
  emergencyAdmin: boolean;
};

function bearer(request: Request): string | null {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const t = auth.slice(7).trim();
  return t || null;
}

async function resolveAuth(request: Request, env: Env): Promise<AuthContext> {
  const token = bearer(request);
  const out: AuthContext = { apiToken: null, kcUser: null, emergencyAdmin: false };
  if (!token) return out;
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
    out.emergencyAdmin = true;
    return out;
  }
  if (token.startsWith("ohqs_")) {
    out.apiToken = await lookupToken(env.D1, token);
    return out;
  }
  if (keycloakConfigured(env)) {
    out.kcUser = await verifyAccessToken(token, env);
  }
  return out;
}

function requireKc(auth: AuthContext): KeycloakUser | Response {
  if (auth.kcUser) return auth.kcUser;
  return err("Keycloak access token required", 401);
}

function workerOrigin(request: Request): string {
  const url = new URL(request.url);
  return url.origin;
}

function safeReturnTo(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return fallback;
    // Local console / worker only
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

async function applyMeterAndAudit(
  env: Env,
  request: Request,
  path: string,
  method: string,
  auth: AuthContext,
  limits: { minute: { limit: number; window: number }; hour: { limit: number; window: number }; day: { limit: number; window: number } } | null,
  response: Response,
): Promise<Response> {
  const ip = clientIP(request);
  const ua = request.headers.get("User-Agent") || "";
  const bytes = parseInt(response.headers.get("Content-Length") || "0", 10) || 0;
  if (auth.apiToken) {
    await touchToken(env.D1, auth.apiToken.id);
    await logUsage(env.D1, {
      tokenId: auth.apiToken.id,
      userSub: auth.apiToken.user_sub,
      route: path,
      method,
      ip,
      ua,
      status: response.status,
      bytes,
    });
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const corsMethod = method === "GET" || method === "POST" || method === "OPTIONS" || method === "DELETE";
    const headersOnly = method === "OPTIONS";
    const ip = clientIP(request);

    const auth = await resolveAuth(request, env);

    // ---- Auth / OIDC / API tokens (no client metering on these) ----

    // Self-serve OHQS signup (creates Keycloak user + realm role `client`).
    // Separate from invite-only engagement portal.
    if (path === "/v1/auth/signup" && method === "POST") {
      if (!keycloakConfigured(env)) return err("Keycloak not configured", 503);
      let body: { email?: string; password?: string; name?: string } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return err("invalid JSON body", 400);
      }
      try {
        const result = await signupClientUser(env, {
          email: body.email || "",
          password: body.password || "",
          name: body.name,
        });
        return json({
          ok: true,
          created: result.created,
          email: result.email,
          sub: result.sub,
          next: "Login via GET /v1/auth/login (browser OIDC) then POST /v1/tokens",
        });
      } catch (e) {
        return err((e as Error).message, 400);
      }
    }

    // Start Keycloak authorization-code + PKCE login (confidential ohqs-api).
    if (path === "/v1/auth/login" && method === "GET") {
      if (!keycloakConfigured(env)) return err("Keycloak not configured", 503);
      const origin = workerOrigin(request);
      const returnTo = safeReturnTo(
        url.searchParams.get("return_to"),
        origin + "/",
      );
      try {
        const loc = await buildLoginUrl(env, origin, returnTo);
        return Response.redirect(loc, 302);
      } catch (e) {
        return err((e as Error).message, 500);
      }
    }

    // OIDC callback — exchanges code, redirects to return_to with access_token in hash.
    if (path === "/v1/auth/callback" && method === "GET") {
      if (!keycloakConfigured(env)) return err("Keycloak not configured", 503);
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const oauthErr = url.searchParams.get("error");
      if (oauthErr) return err("oidc error: " + oauthErr, 400);
      if (!code || !state) return err("missing code/state", 400);
      try {
        const { accessToken, user, returnTo } = await handleCallback(
          env,
          workerOrigin(request),
          code,
          state,
        );
        const dest = new URL(returnTo);
        dest.hash =
          "ohqs_access_token=" +
          encodeURIComponent(accessToken) +
          "&ohqs_sub=" +
          encodeURIComponent(user.sub) +
          "&ohqs_roles=" +
          encodeURIComponent(user.roles.join(","));
        return Response.redirect(dest.toString(), 302);
      } catch (e) {
        return err((e as Error).message, 400);
      }
    }

    // Verify Keycloak access token or opaque API token.
    if (path === "/v1/auth/verify" && method === "GET") {
      if (auth.apiToken) {
        return json({
          valid: true,
          kind: "api_token",
          token: {
            id: auth.apiToken.id,
            type: auth.apiToken.type,
            prefix: auth.apiToken.prefix,
            user_sub: auth.apiToken.user_sub,
          },
        });
      }
      if (auth.kcUser) {
        return json({
          valid: true,
          kind: "keycloak",
          user: {
            sub: auth.kcUser.sub,
            email: auth.kcUser.email,
            roles: auth.kcUser.roles,
          },
        });
      }
      if (auth.emergencyAdmin) {
        return json({ valid: true, kind: "emergency_admin" });
      }
      return err("invalid or missing token", 401);
    }

    // Mint API token (requires Keycloak session).
    // Default type=client. type=ai_admin only if realm role admin (also POST /v1/tokens/ai).
    if ((path === "/v1/tokens" || path === "/v1/tokens/ai") && method === "POST") {
      const kc = requireKc(auth);
      if (kc instanceof Response) return kc;
      let want: TokenType = path === "/v1/tokens/ai" ? "ai_admin" : "client";
      if (path === "/v1/tokens") {
        try {
          const body = (await request.json()) as { type?: string };
          if (body?.type === "ai_admin") want = "ai_admin";
          else if (body?.type === "client" || body?.type == null) want = "client";
          else return err("type must be client or ai_admin", 400);
        } catch {
          // empty body OK → client
          want = "client";
        }
      }
      if (want === "ai_admin" && !isAdmin(kc.roles)) {
        return err("admin role required to mint ai_admin tokens", 403);
      }
      const minted = await mintToken(env.D1, {
        userSub: kc.sub,
        email: kc.email,
        type: want,
        createdBySub: kc.sub,
      });
      return json({
        token: minted.token,
        id: minted.record.id,
        type: minted.record.type,
        prefix: minted.record.prefix,
        created_at: minted.record.created_at,
        warning:
          want === "ai_admin"
            ? "Admin AI token — never embed in CLI defaults, README examples, or www. Store securely; shown once."
            : "Store this token now — it will not be shown again. Only a hash is kept at rest.",
      });
    }

    if (path === "/v1/tokens" && method === "GET") {
      const kc = requireKc(auth);
      if (kc instanceof Response) return kc;
      const tokens = await listTokens(env.D1, kc.sub);
      return json({ tokens });
    }

    const revokeMatch = path.match(/^\/v1\/tokens\/([^/]+)\/revoke$/);
    if (revokeMatch && method === "POST") {
      const kc = requireKc(auth);
      if (kc instanceof Response) return kc;
      const id = decodeURIComponent(revokeMatch[1]);
      const ok = await revokeToken(env.D1, id, kc.sub, isAdmin(kc.roles));
      if (!ok) return err("token not found", 404);
      return json({ revoked: true, id });
    }

    if (path === "/v1/usage" && method === "GET") {
      const kc = requireKc(auth);
      if (kc instanceof Response) return kc;
      const summary = await usageSummary(env.D1, kc.sub);
      return json(summary);
    }

    // Legacy mock endpoint retired.
    if (path === "/v1/auth/token" && method === "POST") {
      return err(
        "Mock JWT auth removed. Use Keycloak: POST /v1/auth/signup, GET /v1/auth/login, then POST /v1/tokens",
        410,
      );
    }

    // All non-CORS methods on the API are rejected outright.
    if (path.startsWith("/v1") && !corsMethod) return err("method not allowed", 405);

    // Rate limit — skip for CORS preflights. ai_admin skips metering but still audits later.
    let limits: { minute: { limit: number; window: number }; hour: { limit: number; window: number }; day: { limit: number; window: number } } | null = null;
    if (!headersOnly) {
      if (path === "/v1/search") limits = LIMITS.search;
      else if (path === "/v1/bounties") limits = LIMITS.bounties;
      else if (path === "/v1/models") limits = LIMITS.models;
      else if (toolPath(path)) limits = LIMITS.tools;
      else if (path === "/v1/index") limits = LIMITS.index;
      else if (path === "/v1/index/embed") limits = LIMITS.embed;
      else if (path === "/v1/recommend") limits = LIMITS.recommend;
      else if (path === "/v1/llm/models") limits = LIMITS.llmModels;
    }
    const skipMeter = !!(auth.apiToken && auth.apiToken.type === "ai_admin");
    if (limits && !headersOnly && !skipMeter) {
      const windows = ["minute", "hour", "day"] as const;
      let combinedRL: { limited: boolean; retryAfterMs: number | null; reset: number; remaining: number } = { limited: false, retryAfterMs: null, reset: 0, remaining: Infinity };
      let limitedWindow: string | null = null;
      const tokenKey = auth.apiToken ? `token:${auth.apiToken.id}` : null;

      for (const window of windows) {
        const { limit, window: windowMs } = limits[window];
        const ipRL = await rateLimit(env, ip, `ip:${path}:${window}`, limit, windowMs);
        let windowRL = ipRL;
        if (tokenKey) {
          const tokRL = await rateLimit(env, tokenKey, `token:${path}:${window}`, limit, windowMs);
          windowRL = {
            limited: ipRL.limited || tokRL.limited,
            retryAfterMs: ipRL.limited && tokRL.limited
              ? Math.max(ipRL.retryAfterMs ?? 0, tokRL.retryAfterMs ?? 0)
              : ipRL.limited ? ipRL.retryAfterMs : tokRL.retryAfterMs,
            reset: Math.max(ipRL.reset, tokRL.reset),
            remaining: Math.min(ipRL.remaining, tokRL.remaining),
          };
        }
        if (windowRL.limited && (!combinedRL.limited || (windowRL.retryAfterMs ?? 0) > (combinedRL.retryAfterMs ?? 0))) {
          combinedRL = windowRL;
          limitedWindow = window;
        }
        if (!windowRL.limited && windowRL.remaining < combinedRL.remaining) {
          combinedRL = { ...combinedRL, remaining: windowRL.remaining, reset: Math.max(combinedRL.reset, windowRL.reset) };
        }
      }

      const retry = combinedRL.retryAfterMs ? Math.ceil(combinedRL.retryAfterMs / 1000) : 0;
      if (combinedRL.limited) {
        const limitedResp = new Response(JSON.stringify({ error: "rate limited", retry_after_seconds: retry, window: limitedWindow }), {
          status: 429,
          headers: { "Content-Type": "application/json; charset=utf-8", ...baseHeaders, "Retry-After": String(retry) },
        });
        if (auth.apiToken) {
          await logUsage(env.D1, {
            tokenId: auth.apiToken.id,
            userSub: auth.apiToken.user_sub,
            route: path,
            method,
            ip,
            ua: request.headers.get("User-Agent") || "",
            status: 429,
            bytes: 0,
          });
        }
        return limitedResp;
      }
      const minuteLimit = limits.minute.limit;
      (request as any).rateLimitHeaders = {
        "X-RateLimit-Limit": String(minuteLimit),
        "X-RateLimit-Remaining": String(Math.max(0, Math.min(combinedRL.remaining, minuteLimit))),
        "X-RateLimit-Reset": String(combinedRL.reset),
        "X-RateLimit-Limit-Hour": String(limits.hour.limit),
        "X-RateLimit-Limit-Day": String(limits.day.limit),
      };
    } else if (skipMeter) {
      (request as any).rateLimitHeaders = { "X-RateLimit-Bypass": "ai_admin" };
    }

    // Stash auth for route handlers / audit wrapper
    (request as any).__ohqsAuth = auth;

    // Preflight
    if (path.startsWith("/v1") && headersOnly) return new Response(null, { status: 204, headers: baseHeaders });

    // /v1/search
    if (path === "/v1/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 50);
      const result = await search(env.D1, env.AI ?? null, q, limit);
      const searchResp = json(result, 200, (request as any).rateLimitHeaders ?? {});
      return applyMeterAndAudit(env, request, path, method, (request as any).__ohqsAuth || auth, limits, searchResp);
    }

    // /v1/bounties — bounty/VDP listings only, split into marketplaces vs
    // single-org programs. Catalog /v1/search excludes these rows.
    if (path === "/v1/bounties" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const clsParam = (url.searchParams.get("class") ?? "marketplace").toLowerCase();
      const cls: BountyClass = clsParam === "program" ? "program" : clsParam === "contract" ? "contract" : "marketplace";
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 200);
      const result = await searchBounties(env.D1, env.AI ?? null, q, limit, cls);
      return json(result, 200, (request as any).rateLimitHeaders ?? {});
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
      }, 200, (request as any).rateLimitHeaders ?? {});
    }

    // /v1/index/embed — costs Workers AI credits, so an admin token is required
    // and the per-IP rate limit is strict. Set ADMIN_TOKEN via
    //   wrangler secret put ADMIN_TOKEN
    // and pass it as:  Authorization: Bearer <token>
    // Chunked: ?offset=&count= (kept small, ~40, because a single Worker
    // invocation is limited to ~50 D1 subrequests). Run repeatedly to cover the
    // whole table; embed-edge.sh loops it. ?kind=contract filters by kind.
    if (path === "/v1/index/embed" && method === "POST") {
      // Prefer ai_admin API token or Keycloak admin session. ADMIN_TOKEN remains
      // as emergency local-only fallback (do not ship to prod).
      const a = ((request as any).__ohqsAuth || auth) as AuthContext;
      const allowed =
        a.emergencyAdmin ||
        (a.apiToken && a.apiToken.type === "ai_admin") ||
        (a.kcUser && isAdmin(a.kcUser.roles));
      if (!allowed) {
        return err("ai_admin token or admin Keycloak session required", 401);
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
      const embedResp = json({ embedded: recs.length, model, dim }, 200, (request as any).rateLimitHeaders ?? {});
      return applyMeterAndAudit(env, request, path, method, (request as any).__ohqsAuth || auth, limits, embedResp);
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
      return json({ host, fits }, 200, (request as any).rateLimitHeaders ?? {});
    }

    // /v1/llm/models — what the playbook model dropdown should offer: OpenRouter
    // routers + free models (when LLM_BASE_URL points there), any other
    // endpoint's readable /models list, else preset Workers AI models.
    if (path === "/v1/llm/models" && method === "GET") {
      return json(await listLlmModels(resolveLlmConfig(env)), 200, (request as any).rateLimitHeaders ?? {});
    }

    // /v1/recommend — the live playbook planner. Mirrors the local `ohqs
    // recommend` gate: situation required. ?fmt=markdown for the renderable
    // playbook.
    if (path === "/v1/recommend" && method === "POST") {
      const a = ((request as any).__ohqsAuth || auth) as AuthContext;
      const allowed =
        a.emergencyAdmin ||
        !!a.apiToken ||
        !!a.kcUser;
      if (!allowed) {
        return err("API token or Keycloak session required for /v1/recommend", 401);
      }
      let body: RecommendRequest;
      try {
        body = (await request.json()) as RecommendRequest;
      } catch {
        return err("invalid JSON body", 400);
      }
      // Optional client-selectable model / router override (e.g.
      // openrouter/auto). The backend + its credentials always come from worker
      // env; we only map a validated name onto it.
      const modelSel = (body.model || "").trim();
      if (modelSel && (modelSel.length > 80 || !/^[A-Za-z0-9._:@/-]+$/.test(modelSel))) {
        return err("invalid model", 400);
      }
      let plan: Awaited<ReturnType<typeof buildPlan>>;
      // Live LLM planner when a backend is configured (Workers AI binding by
      // default, or an OpenAI-compatible endpoint via LLM_BASE_URL); any failure
      // falls back to the deterministic template — mirrors internal/llm.Build.
      // Gate failures (situation required) surface as 400 because both paths
      // raise them before making a model call.
      const llmCfg = resolveLlmConfig(env);
      if (llmEnabled(llmCfg)) {
        const active = modelSel ? Object.assign({}, llmCfg, { model: modelSel }) : llmCfg;
        try {
          plan = await llmRecommend(env.D1, active, body);
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
        const mdResp = new Response(markdown(plan), {
          headers: { "Content-Type": "text/markdown; charset=utf-8", ...baseHeaders, ...(request as any).rateLimitHeaders },
        });
        return applyMeterAndAudit(env, request, path, method, (request as any).__ohqsAuth || auth, limits, mdResp);
      }
      const planResp = json(plan, 200, (request as any).rateLimitHeaders ?? {});
      return applyMeterAndAudit(env, request, path, method, (request as any).__ohqsAuth || auth, limits, planResp);
    }

    // /v1/tools/{id}
    const toolMatch = path.match(/^\/v1\/tools\/(.+)$/);
    if (toolMatch) {
      const id = decodeURIComponent(toolMatch[1]);
      const found = await env.D1.prepare(`SELECT data FROM records WHERE id = ?`).bind(id).first<{ data: string }>();
      if (!found?.data) return err("not found", 404);
      try {
        return json(JSON.parse(found.data) as unknown, 200, (request as any).rateLimitHeaders ?? {});
      } catch {
        return err("invalid record json", 500);
      }
    }

    // /healthz
    if (path === "/healthz") {
      return new Response("ok\n", { headers: baseHeaders });
    }

    // Static console (deploy/web) when assets binding is present.
    if (env.ASSETS && !path.startsWith("/v1")) {
      return env.ASSETS.fetch(request);
    }

    return err("not found", 404);
  },
} satisfies ExportedHandler<Env>;

function toolPath(path: string): boolean {
  return /^\/v1\/tools\/.+$/.test(path);
}

export { RateLimiter };