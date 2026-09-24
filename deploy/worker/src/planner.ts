// Deterministic planner: a faithful port of internal/planner.Build +
// internal/retrieve.{Situation,Playbook} that runs against the D1 catalog so
// the edge can generate the same template playbook as the local Go CLI, with
// zero LLM spend. Gate is identical: authorized + scope required.

import { PLAYBOOKS, Playbook } from "./playbooks";

export interface RecommendRequest {
  situation: string;
  scope?: string;
  authorized?: boolean;
  target?: string;
  path?: string;
  wordlist?: string;
}

export interface PlanRecord {
  id: string;
  name: string;
  kind: string;
  summary: string;
  homepage?: string;
  build?: string;
  install?: string;
  store_firefox?: string;
  store_chromium?: string;
  how?: string;
  look_for?: string;
  commands?: string[];
  [key: string]: unknown;
}

export interface PlanLink {
  label: string;
  url: string;
  note?: string;
}

export interface PlanStep {
  n: number;
  title: string;
  purpose: string;
  tools: PlanRecord[];
  how: string;
  look_for: string;
  next: string;
  commands: string[];
  links?: PlanLink[];
}

export interface Plan {
  goal: string;
  scope: string;
  playbook: string;
  playbook_title: string;
  tools: PlanRecord[];
  steps: PlanStep[];
  checklist: string[];
}

function or(a: string | undefined, b: string): string {
  return a && a.trim() !== "" ? a : b;
}

// Playbook returns the best matched playbook, mirroring retrieve.Playbook:
// exact "clerk" hit first, then keyword-match by count, defaulting to bounty-web.
export function matchPlaybook(situation: string): Playbook {
  const q = situation.toLowerCase();
  if (q.includes("clerk")) {
    const pb = PLAYBOOKS.find((p) => p.id === "nextjs-clerk");
    if (pb) return pb;
  }
  let best = PLAYBOOKS[0];
  let bestScore = -1;
  for (const pb of PLAYBOOKS) {
    let score = 0;
    for (const m of pb.match) {
      if (q.includes(m.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = pb;
    }
  }
  if (bestScore <= 0) {
    const fb = PLAYBOOKS.find((p) => p.id === "bounty-web");
    if (fb) return fb;
  }
  return best;
}

// situationRanked mirrors retrieve.Situation: FTS order contributes a
// positional weighting (limit*2 - i), followed by keyword/tag scoring over the
// full catalog. Returns the top N records, id-ordered by score, then rank.
export async function situationRanked(
  db: D1Database,
  records: PlanRecord[],
  situation: string,
  limit: number,
): Promise<PlanRecord[]> {
  const n = limit > 0 ? limit : 16;
  if (situation.length < 2) return records.slice(0, n);

  const seen = new Map<string, number>();
  const lex = await lexicalIds(db, situation, n * 2);
  for (let i = 0; i < lex.length; i++) {
    seen.set(lex[i], (seen.get(lex[i]) ?? 0) + (n * 2 - i));
  }

  const q = situation.toLowerCase();
  for (const r of records) {
    // Bounty/VDP listings (marketplace platforms, single-org programs, and the
    // individual contract programs inside marketplaces) belong on the Bounties
    // tab, not in recommendation or LLM tool context.
    if (r.kind === "contract" || r.kind === "platform") continue;
    let score = 0;
    const blob = (r.id + " " + r.name + " " + r.kind + " " + r.summary + " ")
      .toLowerCase();
    const tags: string[] = Array.isArray(r.tags) ? (r.tags as string[]) : [];
    for (const w of q.split(/\s+/)) {
      if (w.length < 3) continue;
      if (blob.includes(w)) score += 3;
      for (const t of tags) {
        if (t.toLowerCase() === w || t.toLowerCase().includes(w)) score += 5;
      }
    }
    if (q.includes("ai") || q.includes("vibe") || q.includes("slop") || q.includes("llm")) {
      for (const t of tags) {
        if (t === "ai-slop" || t === "llm" || t === "sast" || t === "secrets") score += 8;
      }
    }
    if (q.includes("clerk") || q.includes("nextjs") || q.includes("next.js")) {
      for (const t of tags) {
        if (t === "clerk" || t === "nextjs" || t === "auth" || t === "authz") score += 10;
      }
    }
    if (score > 0) seen.set(r.id, (seen.get(r.id) ?? 0) + score);
  }

  const ids = [...seen.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const byId = new Map(records.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is PlanRecord => !!r).slice(0, n);
}

// lexicalIds runs the same FTS AND-first / OR-fallback as internal/index.Search
// (significantTokens + stopwords) so the FTS weighting matches the Go planner.
async function lexicalIds(db: D1Database, q: string, limit: number): Promise<string[]> {
  const need = significantTokens(q);
  if (need.length === 0) return [];
  let ids = await ftsIds(db, need.join(" AND "), limit);
  if (ids.length === 0) ids = await ftsIds(db, need.join(" OR "), limit);
  return ids;
}

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

async function ftsIds(db: D1Database, ftsQ: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM records_fts WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`)
    .bind(ftsQ, limit)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id).filter((x): x is string => !!x);
}

export async function allRecords(db: D1Database): Promise<PlanRecord[]> {
  const { results } = await db.prepare(`SELECT data FROM records`).all<{ data: string }>();
  const out: PlanRecord[] = [];
  for (const r of results ?? []) {
    if (!r.data) continue;
    try {
      out.push(JSON.parse(r.data) as PlanRecord);
    } catch {
      /* skip malformed row */
    }
  }
  return out;
}

function expand(cmd: string, subs: Record<string, string>): string {
  let out = cmd;
  for (const [k, v] of Object.entries(subs)) {
    out = out.split(k).join(v);
  }
  return out;
}

function prereqStep(records: PlanRecord[], pb: Playbook, n: number): PlanStep | null {
  const byId = new Map(records.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const recs: PlanRecord[] = [];
  const links: PlanLink[] = [];
  const cmds: string[] = [];
  for (const st of pb.steps) {
    for (const id of st.tool_ids) {
      if (seen.has(id)) continue;
      const rec = byId.get(id);
      if (!rec) continue;
      const manual = rec.kind === "extension" || rec.build === "manual";
      if (!manual) continue;
      seen.add(id);
      recs.push(rec);
      let note = rec.install ?? "";
      if (rec.kind === "extension") note = "Pre-installed in the OHQS test browser (ohqs browser).";
      if (rec.store_firefox) links.push({ label: rec.name + " (Firefox)", url: rec.store_firefox, note });
      if (rec.store_chromium) links.push({ label: rec.name + " (Chrome/Brave/Edge)", url: rec.store_chromium, note });
      if (!rec.store_firefox && !rec.store_chromium && rec.homepage) {
        links.push({ label: rec.name, url: rec.homepage, note });
      }
      if (rec.kind !== "extension" && rec.install) {
        cmds.push("# " + rec.name + ": " + rec.install);
      }
    }
  }
  if (recs.length === 0) return null;
  cmds.unshift("ohqs browser");
  return {
    n,
    title: "Workstation prereqs (browser + manual tools)",
    purpose: "Open the isolated OHQS test browser with extensions already installed.",
    tools: recs,
    how: "Run ohqs browser. It downloads a private Firefox (OHQS Browser) once, force-installs AMO extensions, and opens a sandbox profile. pipx/npm/ZAP stay copy-paste. Daily Firefox/Chrome is not touched.",
    look_for: "FoxyProxy, PwnFox, and Cookie-Editor are already in the sandbox. Daily browsing stays clean.",
    next: "Use that window for proxy/auth steps.",
    commands: cmds,
    links: links.length > 0 ? links : undefined,
  };
}

export async function buildPlan(db: D1Database, req: RecommendRequest): Promise<Plan> {
  if (!req.situation || req.situation.trim() === "") {
    throw new Error("situation is required");
  }
  if (req.situation.length > 500) {
    throw new Error("situation is too long (max 500 chars)");
  }

  const recs = await allRecords(db);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const pb = matchPlaybook(req.situation);
  const tools = await situationRanked(db, recs, req.situation, 18);

  const subs: Record<string, string> = {
    "{{url}}": or(req.target, "{{url}}"),
    "{{target}}": or(req.target, "{{target}}"),
    "{{domain}}": or(req.target, "{{domain}}"),
    "{{path}}": or(req.path, "."),
    "{{wordlist}}": or(req.wordlist, "third-party-resources/guides/SecLists/Discovery/Web-Content/common.txt"),
    "{{live_hosts}}": "live.txt",
    "{{hosts}}": "subs.txt",
  };

  const plan: Plan = {
    goal: req.situation,
    scope: req.scope ?? "",
    playbook: pb.id,
    playbook_title: pb.title,
    tools,
    checklist: [
      "Stay inside the stated scope and program rules",
      "OWASP access control / IDOR on generated CRUD if source or two roles exist",
      "Secrets in repo, JS, and env-style files",
      "Injection only on parameters you have a reason to test",
      "If an LLM feature exists: injection, leakage, unsafe output handling",
      "Write findings with evidence and a fix",
    ],
    steps: [],
  };

  let n = 1;
  plan.steps.push({
    n: n++,
    title: "Authorization and scope lock",
    purpose: "Do not proceed unless this matches written permission.",
    how: "Re-read the program policy or RoE. List in-scope hosts. List out-of-scope. Note rate limits.",
    look_for: "Wildcard vs explicit hosts; excluded third-party SaaS; forbidden tests (DoS, social engineering).",
    next: "If anything is unclear, stop and ask the customer or program.",
    tools: [],
    commands: [],
  });

  const pre = prereqStep(recs, pb, n);
  if (pre) {
    plan.steps.push(pre);
    n++;
  }

  for (const st of pb.steps) {
    const stepRecs: PlanRecord[] = [];
    const cmds: string[] = [];
    const hows: string[] = [];
    const looks: string[] = [];
    for (const id of st.tool_ids) {
      const rec = byId.get(id) ?? tools.find((t) => t.id === id);
      if (!rec) continue;
      stepRecs.push(rec);
      for (const c of rec.commands ?? []) cmds.push(expand(c, subs));
      if (rec.how) hows.push(rec.name + ": " + rec.how);
      if (rec.look_for) looks.push(rec.name + ": " + rec.look_for);
    }
    const how = hows.length > 0 ? hows.join("\n") : st.purpose;
    const look = looks.length > 0 ? looks.join("\n") : "Notes in the playbook step and each tool's look_for.";
    plan.steps.push({
      n: n++,
      title: st.title,
      purpose: st.purpose,
      tools: stepRecs,
      how,
      look_for: look,
      next: "If you have a finding: save request/response or scanner JSON and note it. If not: continue.",
      commands: cmds,
    });
  }

  return plan;
}

export function markdown(p: Plan): string {
  const lines: string[] = [];
  lines.push("# Engagement plan", "");
  lines.push(`**Playbook:** ${p.playbook_title} (${p.playbook})`, "");
  lines.push(`**Goal:** ${p.goal}`, "");
  lines.push(`**Scope:** ${p.scope}`, "");
  lines.push("## Toolkit", "");
  for (const t of p.tools) lines.push(`- **${t.name}** (\`${t.id}\`, ${t.kind}) — ${t.summary}`);
  lines.push("", "## Steps", "");
  for (const s of p.steps) {
    lines.push(`### ${s.n}. ${s.title}`, "");
    lines.push(`**Purpose:** ${s.purpose}`, "");
    if (s.tools.length > 0) {
      lines.push(`**Tools:** ${s.tools.map((t) => t.name).join(", ")}`, "");
    }
    if (s.how) lines.push(`**How:**`, "", s.how, "");
    if (s.links && s.links.length > 0) {
      lines.push("**Install / store links:**", "");
      for (const l of s.links) lines.push(`- [${l.label}](${l.url})${l.note ? " — " + l.note : ""}`);
      lines.push("");
    }
    if (s.commands.length > 0) {
      lines.push("**Commands:**", "");
      for (const c of s.commands) lines.push("```bash", c, "```", "");
    }
    lines.push(`**What to look for:**`, "", s.look_for, "");
    lines.push(`**Next:** ${s.next}`, "");
  }
  lines.push("## Coverage checklist", "");
  for (const c of p.checklist) lines.push(`- [ ] ${c}`);
  lines.push("", "---", "ohqs does not generate exploits or payloads. Detection, triage, and reporting only.");
  return lines.join("\n");
}