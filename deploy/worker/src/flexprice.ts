// Flexprice sandbox usage ingestion for OHQS.
// Posts usage events after a successful local D1 api_usage insert.
// Enabled only when FLEXPRICE_API_KEY is set; failures never fail the API response.
// Never send phones, emails, JWTs, raw ohqs_* tokens, or Authorization headers.

export interface FlexpriceEnv {
  FLEXPRICE_API_KEY?: string;
  /** Default: https://us.api.flexprice.io/v1 (US sandbox). India: https://api.cloud.flexprice.io/v1 */
  FLEXPRICE_API_BASE?: string;
  /** Default: tokens-total — must match Flexprice metered feature (SUM on property tokens). */
  FLEXPRICE_EVENT_NAME?: string;
}

export interface FlexpriceUsageEvent {
  /** Keycloak user_sub / token owner id — external customer id in Flexprice. */
  externalCustomerId: string;
  /** Opaque token row id (NOT the raw ohqs_* secret). */
  tokenId: string;
  route: string;
  status: number;
  bytes: number;
  units?: number;
}

const DEFAULT_BASE = "https://us.api.flexprice.io/v1";
const DEFAULT_EVENT = "tokens-total";
const POST_TIMEOUT_MS = 2_500;

let loggedDisabled = false;

export function flexpriceEnabled(env: FlexpriceEnv): boolean {
  return !!(env.FLEXPRICE_API_KEY && env.FLEXPRICE_API_KEY.trim());
}

/** Log once per isolate that Flexprice is off (no key). Safe to call often. */
export function noteFlexpriceDisabled(env: FlexpriceEnv): void {
  if (flexpriceEnabled(env) || loggedDisabled) return;
  loggedDisabled = true;
  console.info("Flexprice metering disabled (FLEXPRICE_API_KEY not set)");
}

/**
 * Fire a usage event to Flexprice. Await with short timeout; catch all errors.
 * Call only for metered client tokens (skip ai_admin), after D1 logUsage succeeds.
 */
export async function ingestUsageEvent(
  env: FlexpriceEnv,
  evt: FlexpriceUsageEvent,
): Promise<void> {
  if (!flexpriceEnabled(env)) {
    noteFlexpriceDisabled(env);
    return;
  }

  const base = (env.FLEXPRICE_API_BASE || DEFAULT_BASE).replace(/\/$/, "");
  const eventName = (env.FLEXPRICE_EVENT_NAME || DEFAULT_EVENT).trim() || DEFAULT_EVENT;
  const url = `${base}/events`;

  const body = {
    event_name: eventName,
    external_customer_id: evt.externalCustomerId,
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source: "ohqs-worker",
    properties: {
      route: evt.route,
      token_id: evt.tokenId,
      bytes: evt.bytes,
      status: evt.status,
      units: evt.units ?? 1,
      // Flexprice US meter tokens-total aggregates SUM on property `tokens`
      tokens: evt.units ?? 1,
    },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.FLEXPRICE_API_KEY!.trim(),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `Flexprice ingest failed: HTTP ${res.status}`,
        text.slice(0, 200),
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("Flexprice ingest error:", msg);
  } finally {
    clearTimeout(timer);
  }
}
