// Opaque API tokens for OHQS. Raw values are returned once at mint time;
// only SHA-256 hex hashes are stored in D1.

export type TokenType = "client" | "ai_admin";

export interface ApiTokenRow {
  id: string;
  user_sub: string;
  email: string | null;
  type: TokenType;
  token_hash: string;
  prefix: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  created_by_sub: string | null;
}

export interface ResolvedApiToken {
  id: string;
  user_sub: string;
  email: string | null;
  type: TokenType;
  prefix: string;
}

function bytesToHex(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function hashToken(raw: string): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bytesToHex(dig);
}

function newId(): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Mint opaque token. Raw returned once; only hash persisted. */
export async function mintToken(
  db: D1Database,
  opts: {
    userSub: string;
    email?: string;
    type: TokenType;
    createdBySub?: string;
  },
): Promise<{ token: string; record: Omit<ApiTokenRow, "token_hash"> }> {
  const id = newId();
  const secret = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const tag = opts.type === "ai_admin" ? "a" : "c";
  const raw = `ohqs_${tag}_${secret}`;
  const tokenHash = await hashToken(raw);
  const prefix = raw.slice(0, 12);
  const createdAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO api_tokens (id, user_sub, email, type, token_hash, prefix, created_at, revoked_at, last_used_at, created_by_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .bind(
      id,
      opts.userSub,
      opts.email ?? null,
      opts.type,
      tokenHash,
      prefix,
      createdAt,
      opts.createdBySub ?? opts.userSub,
    )
    .run();
  return {
    token: raw,
    record: {
      id,
      user_sub: opts.userSub,
      email: opts.email ?? null,
      type: opts.type,
      prefix,
      created_at: createdAt,
      revoked_at: null,
      last_used_at: null,
      created_by_sub: opts.createdBySub ?? opts.userSub,
    },
  };
}

export async function lookupToken(db: D1Database, raw: string): Promise<ResolvedApiToken | null> {
  if (!raw.startsWith("ohqs_")) return null;
  const tokenHash = await hashToken(raw);
  const row = await db
    .prepare(
      `SELECT id, user_sub, email, type, prefix, revoked_at FROM api_tokens WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{
      id: string;
      user_sub: string;
      email: string | null;
      type: TokenType;
      prefix: string;
      revoked_at: number | null;
    }>();
  if (!row || row.revoked_at) return null;
  return {
    id: row.id,
    user_sub: row.user_sub,
    email: row.email,
    type: row.type,
    prefix: row.prefix,
  };
}

export async function touchToken(db: D1Database, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).bind(now, id).run();
}

export async function listTokens(db: D1Database, userSub: string): Promise<Array<{
  id: string;
  type: TokenType;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}>> {
  const { results } = await db
    .prepare(
      `SELECT id, type, prefix, created_at, last_used_at, revoked_at
       FROM api_tokens WHERE user_sub = ? ORDER BY created_at DESC`,
    )
    .bind(userSub)
    .all<{
      id: string;
      type: TokenType;
      prefix: string;
      created_at: number;
      last_used_at: number | null;
      revoked_at: number | null;
    }>();
  return results ?? [];
}

export async function revokeToken(
  db: D1Database,
  id: string,
  userSub: string,
  asAdmin: boolean,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id, user_sub, revoked_at FROM api_tokens WHERE id = ?`)
    .bind(id)
    .first<{ id: string; user_sub: string; revoked_at: number | null }>();
  if (!row) return false;
  if (!asAdmin && row.user_sub !== userSub) return false;
  if (row.revoked_at) return true;
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ?`).bind(now, id).run();
  return true;
}

export async function logUsage(
  db: D1Database,
  opts: {
    tokenId: string;
    userSub?: string | null;
    route: string;
    method: string;
    ip?: string | null;
    ua?: string | null;
    status: number;
    bytes: number;
  },
): Promise<boolean> {
  const id = newId();
  const ts = Math.floor(Date.now() / 1000);
  try {
    await db
      .prepare(
        `INSERT INTO api_usage (id, token_id, user_sub, route, method, ip, ua, status, bytes, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        opts.tokenId,
        opts.userSub ?? null,
        opts.route,
        opts.method,
        opts.ip ?? null,
        opts.ua ?? null,
        opts.status,
        opts.bytes,
        ts,
      )
      .run();
    return true;
  } catch (e) {
    console.warn("api_usage insert failed:", (e as Error).message);
    return false;
  }
}

export async function usageSummary(
  db: D1Database,
  userSub: string,
  limit = 50,
): Promise<{
  recent: Array<{
    token_id: string;
    route: string;
    method: string;
    status: number | null;
    bytes: number | null;
    ts: number;
    ip: string | null;
  }>;
  by_route: Array<{ route: string; n: number }>;
  /** Most recent non-null IP for this user only (never other users). */
  last_ip: string | null;
}> {
  const { results: recent } = await db
    .prepare(
      `SELECT token_id, route, method, status, bytes, ts, ip FROM api_usage
       WHERE user_sub = ? ORDER BY ts DESC LIMIT ?`,
    )
    .bind(userSub, limit)
    .all<{
      token_id: string;
      route: string;
      method: string;
      status: number | null;
      bytes: number | null;
      ts: number;
      ip: string | null;
    }>();
  const { results: byRoute } = await db
    .prepare(
      `SELECT route, COUNT(*) AS n FROM api_usage WHERE user_sub = ? GROUP BY route ORDER BY n DESC LIMIT 20`,
    )
    .bind(userSub)
    .all<{ route: string; n: number }>();
  const rows = recent ?? [];
  let lastIp: string | null = null;
  for (const row of rows) {
    if (row.ip) {
      lastIp = row.ip;
      break;
    }
  }
  return { recent: rows, by_route: byRoute ?? [], last_ip: lastIp };
}
