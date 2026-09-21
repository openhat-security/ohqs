// Fixed-window per-IP rate limiter backed by a Durable Object. Each unique key
// (ip bucket = combination of caller IP + scope) owns a small counter stored in
// DO storage, so counts are global across edge locations, not per-colocation.
//
// Limits are intentionally generous for read endpoints and strict for anything
// that spends compute/credits (cloudflare AI calls). If no RATE_LIMITER binding
// is configured, the worker allows the request through (local dev fallback).

export interface RateLimitResult {
  limited: boolean;
  retryAfterMs: number | null;
  reset: number;
  remaining: number;
}

export async function rateLimit(
  env: { RATE_LIMITER?: DurableObjectNamespace },
  ip: string,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const ns = env.RATE_LIMITER;
  if (!ns) {
    return { limited: false, retryAfterMs: null, reset: 0, remaining: limit };
  }
  const id = ns.idFromName(`${scope}:${ip}`);
  const stub = ns.get(id);
  try {
    const res = await stub.fetch(
      new Request(`https://ratelimit/?limit=${limit}&window=${windowMs}`),
    );
    const limited = res.status === 429;
    const reset = parseInt(res.headers.get("X-RateLimit-Reset") ?? "0", 10);
    const remaining = parseInt(res.headers.get("X-RateLimit-Remaining") ?? String(limit), 10);
    const retryAfterMs = limited ? Math.max(0, reset - Date.now()) : null;
    return { limited, retryAfterMs, reset, remaining };
  } catch {
    return { limited: false, retryAfterMs: null, reset: 0, remaining: limit };
  }
}

export class RateLimiter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = Math.max(1, parseInt(url.searchParams.get("limit") ?? "60", 10) || 60);
    const windowMs = Math.max(1000, parseInt(url.searchParams.get("window") ?? "60000", 10) || 60000);

    const now = Date.now();
    let reset = (await this.state.storage.get<number>("reset")) ?? 0;
    if (now >= reset) {
      reset = now + windowMs;
      await this.state.storage.put("reset", reset);
      await this.state.storage.put("count", 1);
      return this.respond(200, limit, limit - 1, reset);
    }

    const count = (await this.state.storage.get<number>("count")) ?? 0;
    const next = count + 1;
    await this.state.storage.put("count", next);
    if (next > limit) {
      return this.respond(429, limit, 0, reset);
    }
    return this.respond(200, limit, limit - next, reset);
  }

  private respond(status: number, limit: number, remaining: number, reset: number): Response {
    return new Response(status === 200 ? "ok" : "rate limited", {
      status,
      headers: {
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": String(Math.max(0, remaining)),
        "X-RateLimit-Reset": String(reset),
        "Retry-After": status === 200 ? "0" : String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))),
      },
    });
  }
}