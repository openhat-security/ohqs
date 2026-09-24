// LLM playbook planner at the edge. Runs a small Workers AI chat model through
// the existing AI binding — no external endpoint, no extra secret — and mirrors
// internal/llm (plan.go): same system prompt, same "schooled" user prompt built
// from the matched playbook + ranked catalog tools, same JSON contract, same
// hydration, and it throws on any failure so the caller falls back to the
// deterministic template (Build in plan.go).

import {
  allRecords,
  matchPlaybook,
  situationRanked,
  type Plan,
  type PlanRecord,
  type RecommendRequest,
} from "./planner";

// Small, fast, free-tier Workers AI model (beta). Override with the LLM_MODEL
// bind/var if you want a different one later.
export const DEFAULT_LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const DEFAULT_WORDLIST = "third-party-resources/guides/SecLists/Discovery/Web-Content/common.txt";

const LLM_SYSTEM_PROMPT = `You write authorized security-engagement playbooks for OpenHat Quick Start (ohqs).

Rules:
- The operator already asserted written authorization and a scope. Stay inside that scope.
- Plan detection, triage, and reporting only. Do not invent exploit payloads, shellcode, phishing kits, or bypass recipes.
- Prefer tools from the catalog context. Use their ids exactly when listing tools.
- Commands may use placeholders {{url}}, {{path}}, {{wordlist}}. Do not add destructive flags (DoS, wipe, mass exploit).
- If something is out of scope or unclear, say so in a step instead of guessing.

Reply with a single JSON object (no markdown fences) matching:
{
  "goal": "string",
  "scope": "string",
  "playbook": "string",
  "playbook_title": "string",
  "checklist": ["string"],
  "steps": [
    {
      "n": 1,
      "title": "string",
      "purpose": "string",
      "tool_ids": ["catalog-id"],
      "how": "string",
      "look_for": "string",
      "next": "string",
      "commands": ["string"]
    }
  ]
}`;

interface DraftStep {
  n?: number;
  title?: string;
  purpose?: string;
  tool_ids?: string[];
  how?: string;
  look_for?: string;
  next?: string;
  commands?: string[];
}

interface DraftPlan {
  goal?: string;
  scope?: string;
  playbook?: string;
  playbook_title?: string;
  checklist?: string[];
  steps?: DraftStep[];
}

function or(a: string | undefined, b: string | undefined): string {
  return a && a.trim() !== "" ? a : b ?? "";
}

// extractJSON pulls the first {...} block out of the model reply, tolerating
// lens wrapping in markdown fences or stray prose (mirrors llm/extractJSON).
function extractJSON(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json|JSON)?[ \t]*\r?\n?/i, "");
    const i = t.lastIndexOf("```");
    if (i >= 0) t = t.slice(0, i);
    t = t.trim();
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return t.slice(start, end + 1);
}

async function chat(ai: Ai, model: string, system: string, user: string): Promise<string> {
  const raw = await (ai.run(model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // 8B-instruct-fast truncates long JSON at its default budget; give it
    // enough room to close the object.
    max_tokens: 4096,
    temperature: 0.2,
  }) as unknown as Promise<Record<string, unknown>>);
  const content = extractContent(raw);
  if (!content) {
    throw new Error("Workers AI returned no content (shape: " + JSON.stringify(Object.keys(raw)).slice(0, 120) + ")");
  }
  return content;
}

// Workers AI returns the generated text under different keys across model
// families (OpenAI-style choices[], or a direct response/output/text/content
// field); handle the common ones so a model swap doesn't silently break the
// planner.
function extractContent(resp: Record<string, unknown>, depth = 0): string {
  if (depth > 3) return "";
  if (typeof resp === "string") return resp;
  const direct = resp.response;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    const inner = extractContent(direct as Record<string, unknown>, depth + 1);
    if (inner) return inner;
  }
  for (const k of ["output", "text", "content", "message"]) {
    const v = resp[k];
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const inner = extractContent(v as Record<string, unknown>, depth + 1);
      if (inner) return inner;
    }
  }
  const choices = resp.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      if (c && typeof c === "object") {
        const inner = extractContent(c as Record<string, unknown>, depth + 1);
        if (inner) return inner;
      } else if (typeof c === "string") {
        return c;
      }
    }
  }
  return "";
}

async function userPrompt(db: D1Database, req: RecommendRequest): Promise<string> {
  const pb = matchPlaybook(req.situation);
  const records = await allRecords(db);
  const tools = await situationRanked(db, records, req.situation, 18);
  const lines: string[] = [
    "Situation: " + req.situation,
    "Scope: " + (req.scope && req.scope.trim() !== "" ? req.scope : "not provided"),
  ];
  if (req.target) lines.push("Target: " + req.target);
  if (req.path) lines.push("Local path: " + req.path);
  if (req.wordlist) lines.push("Wordlist: " + req.wordlist);
  lines.push("", "Matched playbook: " + pb.title + " (" + pb.id + ")");
  for (const st of pb.steps) {
    lines.push("- " + st.title + ": " + st.purpose +
      " (tools: " + (st.tool_ids.length > 0 ? st.tool_ids.join(", ") : "-") + ")");
  }
  lines.push("", "Catalog tools to prefer:");
  for (const t of tools) {
    lines.push("- " + t.id + " (" + t.name + ", " + t.kind + "): " + t.summary);
  }
  lines.push("", "Write the JSON plan now.");
  return lines.join("\n");
}

function parseDraft(content: string): DraftPlan & { steps: DraftStep[] } {
  const raw = extractJSON(content);
  if (!raw) throw new Error("LLM reply had no JSON object");
  let d: DraftPlan;
  try {
    d = JSON.parse(raw) as DraftPlan;
  } catch (e) {
    throw new Error("LLM JSON: " + (e as Error).message);
  }
  if (!d || !Array.isArray(d.steps) || d.steps.length === 0) {
    throw new Error("LLM plan had no steps");
  }
  return d as DraftPlan & { steps: DraftStep[] };
}

// hydrate resolves the LLM's tool_ids against the catalog and builds the same
// Plan shape the frontend and markdown() consume (mirrors llm/hydrate).
async function hydrate(db: D1Database, req: RecommendRequest, d: DraftPlan & { steps: DraftStep[] }): Promise<Plan> {
  const records = await allRecords(db);
  const byId = new Map(records.map((r) => [r.id, r]));
  const pb = matchPlaybook(req.situation);
  const plan: Plan = {
    goal: or(d.goal, req.situation),
    scope: or(d.scope, req.scope) || "",
    playbook: or(d.playbook, pb.id),
    playbook_title: or(d.playbook_title, pb.title + " (LLM)"),
    checklist: d.checklist && d.checklist.length > 0
      ? d.checklist
      : [
          "Stay inside the stated scope and program rules",
          "Write findings with evidence and a fix",
        ],
    tools: [],
    steps: [],
  };
  const seen = new Set<string>();
  const subs: Record<string, string> = {
    "{{url}}": or(req.target, "{{url}}"),
    "{{target}}": or(req.target, "{{target}}"),
    "{{domain}}": or(req.target, "{{domain}}"),
    "{{path}}": or(req.path, "."),
    "{{wordlist}}": or(req.wordlist, DEFAULT_WORDLIST),
  };
  d.steps.forEach((st, i) => {
    const n = st.n && st.n > 0 ? st.n : i + 1;
    const stepRecs: PlanRecord[] = [];
    for (const id of st.tool_ids ?? []) {
      const rec = byId.get(id);
      if (!rec) continue;
      stepRecs.push(rec);
      if (!seen.has(rec.id)) {
        seen.add(rec.id);
        plan.tools.push(rec);
      }
    }
    plan.steps.push({
      n,
      title: or(st.title, "Step " + n),
      purpose: or(st.purpose, ""),
      tools: stepRecs,
      how: or(st.how, ""),
      look_for: or(st.look_for, "Notes in each step's how and the tool look_for."),
      next: or(st.next, "If you have a finding: save request/response or scanner JSON and note it. If not: continue."),
      commands: (st.commands ?? []).map((c) => {
        let cmd = c;
        for (const [k, v] of Object.entries(subs)) cmd = cmd.split(k).join(v);
        return cmd;
      }),
    });
  });
  return plan;
}

// llmRecommend validates the gate, schools a Workers AI chat model on the
// situation + matched template, and returns a hydrated Plan. Any failure throws,
// letting the caller fall back to the deterministic template.
export async function llmRecommend(
  db: D1Database,
  ai: Ai,
  model: string,
  req: RecommendRequest,
): Promise<Plan> {
  if (!req.situation || req.situation.trim() === "") {
    throw new Error("situation is required");
  }
  if (req.situation.length > 500) {
    throw new Error("situation is too long (max 500 chars)");
  }
  const system = LLM_SYSTEM_PROMPT;
  const user = await userPrompt(db, req);
  // Race the model call so a slow/hung inference still lets the caller fall
  // back to the deterministic template before the Workers wall-clock limit.
  const content = await raceTimeout(
    chat(ai, model, system, user),
    25_000,
    "Workers AI plan timed out after 25s",
  );
  const draft = parseDraft(content);
  return hydrate(db, req, draft);
}

function raceTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}