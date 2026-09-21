// Port of index.Store.Search (significantTokens + stopwords, AND first with OR
// fallback) over the D1 records_fts table, plus semantic-first ranking: when
// the edge has persisted vectors and an AI binding, the query is embedded and
// the whole catalog is ranked by cosine similarity so intent is interpreted
// rather than keyword-matched. Lexical FTS is the fallback when vectors are
// missing or the embedder fails.

import { matchesClass, isPlatform, BountyClass } from "./bounties";

export interface SearchRecord {
  id: string;
  [key: string]: unknown;
}

type Predicate = (r: SearchRecord) => boolean;

const STOPWORDS = new Set(
  ["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
    "is", "it", "of", "on", "or", "the", "to", "what", "when", "where",
    "which", "who", "will", "with", "vs", "i", "you"],
);

// significantTokens strips FTS noise words and punctuation, then prefix-stems
// each run so "command control" still finds "commands" and "controlled". Runs
// are split on non-alphanumerics because FTS5 rejects raw "-"/"." inside a
// MATCH string (e.g. "vibe-coded" or "next.js").
function significantTokens(q: string): string[] {
  const out: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const p = raw.trim().toLowerCase().replace(/^["(,'"]+|["(,'"]+$/g, "");
    if (!p) continue;
    for (const run of p.split(/[^a-z0-9]+/).filter((x) => x !== "")) {
      if (STOPWORDS.has(run)) continue;
      out.push(run + "*");
    }
  }
  return out;
}

async function matchRecords(db: D1Database, ftsQ: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM records_fts WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`)
    .bind(ftsQ, limit)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id).filter((x): x is string => !!x);
}

// fetchRecords returns the full stored record JSON for the given ids, in the
// given order.
async function fetchRecords(db: D1Database, ids: string[]): Promise<SearchRecord[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT data FROM records WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ data: string }>();
  const byId = new Map<string, SearchRecord>();
  for (const r of results ?? []) {
    if (!r.data) continue;
    try {
      const rec = JSON.parse(r.data) as SearchRecord;
      byId.set(rec.id as string, rec);
    } catch {
      /* skip malformed row */
    }
  }
  return ids.map((id) => byId.get(id)).filter((x): x is SearchRecord => !!x);
}

// fetchFiltered walks ids in score order, fetching record JSON in chunks (D1
// caps bound parameters per statement) and keeping only those a predicate
// accepts, until `limit` matches or the ids run out. This lets a search read
// past a page full of platform/bounty rows without dropping the whole result.
async function fetchFiltered(
  db: D1Database,
  ids: string[],
  predicate: Predicate,
  limit: number,
): Promise<SearchRecord[]> {
  const out: SearchRecord[] = [];
  const CHUNK = 90;
  for (let i = 0; i < ids.length && out.length < limit; i += CHUNK) {
    const recs = await fetchRecords(db, ids.slice(i, i + CHUNK));
    for (const r of recs) {
      if (!predicate(r)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// EmbedderMeta reads the persisted embedder name + dim, if any.
export async function embedderMeta(db: D1Database): Promise<{ name: string; dim: number } | null> {
  const { results } = await db.prepare(`SELECT key, value FROM metadata WHERE key IN ('vector_embedder','vector_dim')`).all<{ key: string; value: string }>();
  let name = "";
  let dim = 0;
  for (const r of results ?? []) {
    if (r.key === "vector_embedder") name = r.value;
    if (r.key === "vector_dim") dim = parseInt(r.value, 10) || 0;
  }
  if (!name || dim <= 0) return null;
  return { name, dim };
}

// embedQuery returns the Workers AI embedding for a single text query.
async function embedQuery(ai: Ai, model: string, query: string): Promise<number[]> {
  const resp = (await ai.run(model, { text: [query] })) as { data?: unknown[] };
  const raw = resp.data ?? [];
  if (raw.length > 0 && Array.isArray(raw[0])) return raw[0] as number[];
  if (raw.length > 0 && typeof raw[0] === "object") {
    const e = (raw[0] as { embedding?: number[] }).embedding;
    if (e) return e;
  }
  throw new Error("embedding response shape not recognized");
}

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// semanticRank interprets intent: embed the query once, then score every
// vector in the catalog by cosine similarity. Falls back to null on any
// missing vectors, embedder, or AI binding so the caller can drop to lexical.
async function semanticRank(
  db: D1Database,
  ai: Ai | null,
  query: string,
  limit: number,
  predicate?: Predicate,
): Promise<{ records: SearchRecord[]; embedder: string } | null> {
  if (!ai) return null;
  const meta = await embedderMeta(db);
  if (!meta) return null;

  let qvec: number[];
  try {
    qvec = await embedQuery(ai, meta.name, query);
  } catch {
    return null;
  }

  const { results } = await db.prepare(`SELECT id, vec FROM vectors`).all<{ id: string; vec: string }>();
  const scored: [string, number][] = [];
  for (const r of results ?? []) {
    try {
      const v = JSON.parse(r.vec) as number[];
      if (v.length !== meta.dim) continue;
      scored.push([r.id, dot(qvec, v)]);
    } catch {
      /* skip malformed vector */
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b[1] - a[1]);
  const ids = scored.map((s) => s[0]);
  const records = await fetchFiltered(db, ids, predicate ?? (() => true), limit);
  return { records, embedder: meta.name };
}

// Search returns {records, source} mirroring the Go /v1/search body. Catalog
// search deliberately excludes kind "platform" rows so bounty/VDP listings
// only surface through listBounties/searchBounties (the Bounties tab).
export async function search(
  db: D1Database,
  ai: Ai | null,
  query: string,
  limit: number,
): Promise<{ q: string; source: string; records: SearchRecord[] }> {
  const q = (query || "").trim();
  if (!q) return { q, source: "none", records: [] };
  const effLimit = limit > 0 ? limit : 20;
  const notBounty: Predicate = (r) => !isPlatform(r);

  // Semantic-first: interpret the query against the whole catalog.
  const sem = await semanticRank(db, ai, q, effLimit, notBounty);
  if (sem) {
    return { q, source: `semantic (${sem.embedder})`, records: sem.records };
  }

  // No vectors or embedder — lexical FTS pool (AND first, OR fallback). Pull a
  // wider pool so filtering out bounty rows still fills the requested page.
  const need = significantTokens(q);
  if (need.length === 0) return { q, source: "lexical", records: [] };

  const pool = effLimit * 5;
  let ids = await matchRecords(db, need.join(" AND "), pool);
  if (ids.length === 0) ids = await matchRecords(db, need.join(" OR "), pool);
  const records = await fetchFiltered(db, ids, notBounty, effLimit);
  return { q, source: "lexical", records };
}

export interface BountiesResult {
  q: string;
  class: BountyClass;
  source: string;
  records: SearchRecord[];
}

// searchBounties is the Bounties tab query: only kind "platform" rows, split
// into marketplaces vs single-org programs. An empty query lists the whole
// class alphabetically so the tab is browsable without typing.
export async function searchBounties(
  db: D1Database,
  ai: Ai | null,
  query: string,
  limit: number,
  cls: BountyClass,
): Promise<BountiesResult> {
  const q = (query || "").trim();
  const effLimit = limit > 0 ? limit : 100;
  const match: Predicate = (r) => matchesClass(r, cls);

  if (!q) {
    const { results } = await db
      .prepare(`SELECT data FROM records WHERE kind = 'platform'`)
      .all<{ data: string }>();
    const recs: SearchRecord[] = [];
    for (const row of results ?? []) {
      if (!row.data) continue;
      try {
        const r = JSON.parse(row.data) as SearchRecord;
        if (match(r)) recs.push(r);
      } catch {
        /* skip malformed row */
      }
    }
    recs.sort((a, b) =>
      String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
    );
    return { q, class: cls, source: "list", records: recs.slice(0, effLimit) };
  }

  const sem = await semanticRank(db, ai, q, effLimit, match);
  if (sem) return { q, class: cls, source: `semantic (${sem.embedder})`, records: sem.records };

  const need = significantTokens(q);
  if (need.length === 0) return { q, class: cls, source: "lexical", records: [] };

  const pool = effLimit * 5;
  let ids = await matchRecords(db, need.join(" AND "), pool);
  if (ids.length === 0) ids = await matchRecords(db, need.join(" OR "), pool);
  const records = await fetchFiltered(db, ids, match, effLimit);
  return { q, class: cls, source: "lexical", records };
}