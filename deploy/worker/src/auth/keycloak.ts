// Keycloak OIDC helpers for OHQS: JWKS access-token validation, authorization-code
// login/callback (confidential client ohqs-api), and self-serve user signup via
// the client's service account. Direct Access Grants stay OFF.

export interface KeycloakEnv {
  KEYCLOAK_ISSUER?: string;
  KEYCLOAK_CLIENT_ID?: string;
  KEYCLOAK_CLIENT_SECRET?: string;
}

export interface KeycloakUser {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  roles: string[];
  raw: Record<string, unknown>;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
type Jwks = { keys: Jwk[] };

let jwksCache: { keys: Jwk[]; fetchedAt: number; issuer: string } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function issuer(env: KeycloakEnv): string {
  const v = (env.KEYCLOAK_ISSUER || "").replace(/\/$/, "");
  if (!v) throw new Error("KEYCLOAK_ISSUER is not set");
  return v;
}

function clientId(env: KeycloakEnv): string {
  return env.KEYCLOAK_CLIENT_ID || "ohqs-api";
}

function clientSecret(env: KeycloakEnv): string {
  const s = env.KEYCLOAK_CLIENT_SECRET || "";
  if (!s) throw new Error("KEYCLOAK_CLIENT_SECRET is not set");
  return s;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function textToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = new TextDecoder().decode(b64urlToBytes(parts[1]));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractRoles(claims: Record<string, unknown> | null | undefined): string[] {
  if (!claims) return [];
  if (Array.isArray(claims.roles)) return claims.roles.map(String);
  const ra = claims.realm_access as { roles?: unknown } | undefined;
  if (ra && Array.isArray(ra.roles)) return ra.roles.map(String);
  return [];
}

export function isAdmin(roles: string[]): boolean {
  return roles.includes("admin");
}

async function fetchJwks(env: KeycloakEnv): Promise<Jwk[]> {
  const iss = issuer(env);
  const now = Date.now();
  if (jwksCache && jwksCache.issuer === iss && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`${iss}/protocol/openid-connect/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const body = (await res.json()) as Jwks;
  jwksCache = { keys: body.keys || [], fetchedAt: now, issuer: iss };
  return jwksCache.keys;
}

async function importVerifyKey(jwk: Jwk): Promise<CryptoKey> {
  const alg = (jwk.alg || "RS256").toUpperCase();
  // Workers lib omits some SubtleCrypto param types — keep this untyped.
  let algo: Parameters<SubtleCrypto["importKey"]>[2];
  if (alg.startsWith("ES")) {
    const namedCurve = alg === "ES384" ? "P-384" : alg === "ES512" ? "P-521" : "P-256";
    algo = { name: "ECDSA", namedCurve };
  } else {
    const hash = alg.includes("512") ? "SHA-512" : alg.includes("384") ? "SHA-384" : "SHA-256";
    algo = { name: "RSASSA-PKCS1-v1_5", hash };
  }
  return crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
}

async function verifySig(alg: string, key: CryptoKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (alg.startsWith("ES")) {
    const hash = alg === "ES384" ? "SHA-384" : alg === "ES512" ? "SHA-512" : "SHA-256";
    return crypto.subtle.verify({ name: "ECDSA", hash }, key, sig, data);
  }
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, data);
}

/** Validate a Keycloak access token via JWKS. Returns null if invalid. */
export async function verifyAccessToken(token: string, env: KeycloakEnv): Promise<KeycloakUser | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [hB64, pB64, sB64] = parts;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(hB64))) as { alg?: string; kid?: string };
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(pB64))) as Record<string, unknown>;
    const iss = issuer(env);
    if (payload.iss !== iss) return null;
    if (payload.exp && typeof payload.exp === "number" && payload.exp < Date.now() / 1000) return null;
    const keys = await fetchJwks(env);
    const jwk = keys.find((k) => !header.kid || k.kid === header.kid) || keys[0];
    if (!jwk) return null;
    const key = await importVerifyKey(jwk);
    const data = new TextEncoder().encode(`${hB64}.${pB64}`);
    const sig = b64urlToBytes(sB64);
    const alg = (header.alg || jwk.alg || "RS256").toUpperCase();
    const ok = await verifySig(alg, key, data, sig);
    if (!ok) return null;
    const sub = String(payload.sub || "");
    if (!sub) return null;
    return {
      sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      preferred_username: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      roles: extractRoles(payload),
      raw: payload,
    };
  } catch {
    return null;
  }
}

async function hmacSign(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return bytesToB64url(sig);
}

type OAuthState = {
  return_to: string;
  code_verifier: string;
  nonce: string;
  exp: number;
};

export async function buildLoginUrl(
  env: KeycloakEnv,
  workerOrigin: string,
  returnTo: string,
): Promise<string> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = bytesToB64url(verifierBytes);
  const challenge = bytesToB64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const nonce = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
  const statePayload: OAuthState = {
    return_to: returnTo,
    code_verifier: codeVerifier,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const body = textToB64url(JSON.stringify(statePayload));
  const sig = await hmacSign(clientSecret(env), body);
  const state = `${body}.${sig}`;
  const redirectUri = `${workerOrigin}/v1/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId(env),
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
  });
  return `${issuer(env)}/protocol/openid-connect/auth?${params}`;
}

export async function handleCallback(
  env: KeycloakEnv,
  workerOrigin: string,
  code: string,
  state: string,
): Promise<{ accessToken: string; user: KeycloakUser; returnTo: string }> {
  const [body, sig] = state.split(".");
  if (!body || !sig) throw new Error("invalid state");
  const expect = await hmacSign(clientSecret(env), body);
  if (expect !== sig) throw new Error("invalid state signature");
  const parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as OAuthState;
  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) throw new Error("state expired");
  const redirectUri = `${workerOrigin}/v1/auth/callback`;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId(env),
    client_secret: clientSecret(env),
    code_verifier: parsed.code_verifier,
  });
  const res = await fetch(`${issuer(env)}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`token exchange failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string };
  const user = await verifyAccessToken(json.access_token, env);
  if (!user) throw new Error("access token failed validation");
  return { accessToken: json.access_token, user, returnTo: parsed.return_to };
}

async function serviceAccountToken(env: KeycloakEnv): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId(env),
    client_secret: clientSecret(env),
  });
  const res = await fetch(`${issuer(env)}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`service account token failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

function adminBase(env: KeycloakEnv): string {
  const iss = issuer(env);
  const m = iss.match(/^(https?:\/\/[^/]+)\/realms\/([^/]+)$/);
  if (!m) throw new Error(`Unexpected KEYCLOAK_ISSUER shape: ${iss}`);
  return `${m[1]}/admin/realms/${m[2]}`;
}

/**
 * Self-serve OHQS signup: create Keycloak user + assign realm role `client`.
 * Separate from invite-only portal. Requires service-account manage-users.
 */
export async function signupClientUser(
  env: KeycloakEnv,
  input: { email: string; password: string; name?: string },
): Promise<{ sub: string; email: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  if (!email || !email.includes("@")) throw new Error("valid email required");
  if (!password || password.length < 10) throw new Error("password must be at least 10 characters");
  const token = await serviceAccountToken(env);
  const base = adminBase(env);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const find = await fetch(`${base}/users?email=${encodeURIComponent(email)}&exact=true`, { headers });
  if (!find.ok) throw new Error(`list users failed (${find.status})`);
  const existing = (await find.json()) as Array<{ id: string }>;
  let userId: string;
  let created = false;
  if (existing[0]?.id) {
    userId = existing[0].id;
  } else {
    const name = (input.name || email.split("@")[0]).trim();
    const create = await fetch(`${base}/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: email,
        email,
        enabled: true,
        emailVerified: true,
        firstName: name,
        credentials: [{ type: "password", value: password, temporary: false }],
      }),
    });
    if (!create.ok) {
      const t = await create.text();
      throw new Error(`create user failed (${create.status}): ${t.slice(0, 300)}`);
    }
    const loc = create.headers.get("Location") || "";
    userId = loc.split("/").pop() || "";
    if (!userId) {
      const again = await fetch(`${base}/users?email=${encodeURIComponent(email)}&exact=true`, { headers });
      const users = (await again.json()) as Array<{ id: string }>;
      userId = users[0]?.id || "";
    }
    if (!userId) throw new Error("user created but id not found");
    created = true;
  }

  const roleRes = await fetch(`${base}/roles/client`, { headers });
  if (!roleRes.ok) throw new Error(`realm role 'client' missing (${roleRes.status})`);
  const role = (await roleRes.json()) as { id: string; name: string };
  const map = await fetch(`${base}/users/${userId}/role-mappings/realm`, {
    method: "POST",
    headers,
    body: JSON.stringify([{ id: role.id, name: role.name }]),
  });
  if (!map.ok && map.status !== 204) {
    const t = await map.text();
    throw new Error(`assign role failed (${map.status}): ${t.slice(0, 300)}`);
  }
  return { sub: userId, email, created };
}

export function keycloakConfigured(env: KeycloakEnv): boolean {
  return !!(env.KEYCLOAK_ISSUER && env.KEYCLOAK_CLIENT_ID && env.KEYCLOAK_CLIENT_SECRET);
}
