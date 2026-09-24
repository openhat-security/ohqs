// LLM playbook planner at the edge. Mirrors internal/llm (plan.go): same system
// prompt, user prompt built from the matched playbook + ranked catalog tools,
// same JSON contract, same hydration, throws on any failure so the caller falls
// back to the deterministic template (Build in plan.go).
//
// Backends (pick one at deploy time):
//   - Workers AI through the existing AI binding (free tier) when LLM_BASE_URL
//     is unset. Defaults to DEFAULT_LLM_MODEL, override via the LLM_MODEL var.
//   - Any OpenAI-compatible /chat/completions endpoint when LLM_BASE_URL is
//     set. LLM_API_KEY (secret, Bearer) and LLM_MODEL are optional; the hosted
//     OpenAI default model applies when the base is api.openai.com.

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

export const DEFAULT_HOSTED_MODEL = "gpt-4o-mini";

export interface LlmConfig {
  model: string;
  ai?: Ai;
  baseURL?: string;
  apiKey?: string;
}

// resolveLlmConfig turns worker env into a backend config with mirror-GO CLI
// semantics: an api key implies the OpenAI base, a missing model on hosted
// OpenAI gets a default, otherwise the free Workers AI model is used.
export function resolveLlmConfig(env: {
  AI?: Ai;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}): LlmConfig {
  let baseURL = (env.LLM_BASE_URL || "").trim();
  const apiKey = (env.LLM_API_KEY || "").trim();
  let model = (env.LLM_MODEL || "").trim();
  if (!baseURL && apiKey) baseURL = "https://api.openai.com/v1";
  if (!model && baseURL.includes("api.openai.com")) model = DEFAULT_HOSTED_MODEL;
  if (!model) model = DEFAULT_LLM_MODEL;
  return {
    model,
    ai: env.AI,
    baseURL: baseURL || undefined,
    apiKey: apiKey || undefined,
  };
}

export function llmEnabled(cfg: LlmConfig): boolean {
  return !!cfg.ai || !!cfg.baseURL;
}

// Curated Workers AI chat presets, shown in the model dropdown when no external
// endpoint is configured. First entry is the free-tier default.
export const WORKERS_AI_PRESETS: Array<{ id: string; name: string }> = [
  { id: "@cf/meta/llama-3.1-8b-instruct-fast", name: "Llama 3.1 8B (fast)" },
  { id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen 3 30B MoE (cheap)" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B (fast)" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen2.5 Coder 32B" },
];

export interface LlmModelInfo {
  id: string;
  name?: string;
  free?: boolean;
  router?: boolean;
  context?: number;
}

// listLlmModels returns what the model dropdown should offer for the currently
// configured backend: OpenRouter routers + free models when LLM_BASE_URL points
// at OpenRouter, all models of another OpenAI-compatible endpoint when its
// listing is readable, else the Workers AI presets. `active` is the model the
// server uses when the client sends no override.
export async function listLlmModels(cfg: LlmConfig): Promise<{
  backend: string;
  active: string;
  models: LlmModelInfo[];
}> {
  if (cfg.baseURL) {
    const isOpenRouter = cfg.baseURL.includes("openrouter.ai");
    const listed = await listExternalModels(cfg);
    if (listed && listed.length > 0) {
      if (isOpenRouter) {
        const routers: LlmModelInfo[] = [
          { id: "openrouter/auto", name: "Auto — best available", router: true, free: true },
          { id: "openrouter/free", name: "Free — best free model", router: true, free: true },
        ];
        // Skip our own router entries that OpenRouter also lists, plus any
        // paid models; the routers themselves stay first.
        const free = listed
          .filter((m) => m.free && m.id !== "openrouter/auto" && m.id !== "openrouter/free")
          .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        return { backend: "openrouter", active: cfg.model, models: routers.concat(free) };
      }
      return { backend: "openai", active: cfg.model, models: listed };
    }
    // Listing failed (e.g. OpenRouter needs the key on /models too): still offer
    // the routers + whatever model the server is configured with.
    if (isOpenRouter) {
      return {
        backend: "openrouter",
        active: cfg.model,
        models: [
          { id: "openrouter/auto", name: "Auto — best available", router: true, free: true },
          { id: "openrouter/free", name: "Free — best free model", router: true, free: true },
          { id: cfg.model, name: cfg.model },
        ],
      };
    }
    return { backend: "openai", active: cfg.model, models: [{ id: cfg.model, name: cfg.model }] };
  }
  const models = WORKERS_AI_PRESETS.map((m) => ({ ...m, free: true }));
  return { backend: "workers-ai", active: cfg.model, models };
}

let extModelsCache: { key: string; at: number; list: LlmModelInfo[] | null } | null = null;

// listExternalModels reads an OpenAI-compatible GET {base}/models (OpenRouter
// including `pricing` fields). Null on any failure; the result is cached ~5min
// per (baseURL, model) since the dropdown loads once per page view.
async function listExternalModels(cfg: LlmConfig): Promise<LlmModelInfo[] | null> {
  const base = (cfg.baseURL as string).replace(/\/+$/, "");
  const url = /\/models$/.test(base) ? base : base + "/models";
  const key = url + "|" + (cfg.apiKey || "");
  const now = Date.now();
  if (extModelsCache && extModelsCache.key === key && now - extModelsCache.at < 300_000) {
    return extModelsCache.list;
  }
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;
  let list: LlmModelInfo[] | null = null;
  try {
    const resp = await fetch(url, { headers });
    if (resp.ok) {
      const j = (await resp.json()) as { data?: unknown; models?: unknown };
      const data = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? (j.models as unknown[]) : [];
      list = [];
      const seen = new Set<string>();
      for (const m of data) {
        const rec = (typeof m === "object" && m !== null ? m : {}) as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        list.push({
          id,
          name: typeof rec.name === "string" ? rec.name : id,
          free: pricingIsFree(rec.pricing),
          context: typeof rec.context_length === "number" ? rec.context_length : undefined,
        });
      }
      if (list.length === 0) list = null;
    }
  } catch {
    list = null;
  }
  extModelsCache = { key, at: now, list };
  return list;
}

function pricingIsFree(p: unknown): boolean {
  if (!p || typeof p !== "object") return false;
  const r = p as Record<string, unknown>;
  return priceToNumber(r.prompt) === 0 && priceToNumber(r.completion) === 0;
}

function priceToNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isFinite(n) ? n : -1;
  }
  return -1;
}

const DEFAULT_WORDLIST = "third-party-resources/guides/SecLists/Discovery/Web-Content/common.txt";

const LLM_SYSTEM_PROMPT = `You write authorized security-engagement playbooks for OpenHat Quick Start (ohqs).

Rules:
- The operator already asserted written authorization and a scope. Stay inside that scope.
- Plan detection, triage, and reporting only. Do not invent exploit payloads, shellcode, phishing kits, or bypass recipes.
- Use ONLY tool ids listed under "Available catalog tools". Never invent tool ids or flags.
- Each step's commands must be taken from that tool's example commands (verbatim, keeping {{url}}/{{path}}/{{wordlist}} placeholders or substituting the target). Never write a command for a tool that has none.
- Do not add destructive flags (DoS, wipe, mass exploit).
- If something is out of scope or unclear, say so in a step instead of guessing.
- A reference playbook is included for TONE ONLY. Do not copy its steps or titles. Write a NEW playbook specific to the situation: different angles, order, and emphasis where the situation calls for it.

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

// chat dispatches to the configured backend: an OpenAI-compatible endpoint when
// baseURL is set, otherwise the Workers AI binding. Both return the assistant's
// text content or throw, leaving fallback decisions to the caller.
async function chat(cfg: LlmConfig, system: string, user: string): Promise<string> {
  if (cfg.baseURL) {
    return chatExternal(cfg.baseURL, cfg.apiKey, cfg.model, system, user);
  }
  if (!cfg.ai) throw new Error("no LLM backend configured");
  const raw = await (cfg.ai.run(cfg.model, {
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

// chatExternal talks to any OpenAI-compatible /chat/completions endpoint, which
// covers hosted providers (OpenAI, Groq, OpenRouter, Together, Fireworks...) and
// self-hosted ones (llama.cpp/llamafile, vLLM, LocalAI, Ollama). Mirrors
// internal/llm/client.go: Bearer auth when apiKey is set, max_tokens overall,
// lenient message extraction, and a hard 25s deadline so the /v1/recommend
// handler can fall back to the template instead of hanging.
async function chatExternal(
  baseURL: string,
  apiKey: string | undefined,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const base = baseURL.replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base)
    ? base
    : base + "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const opts: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  };
  return await raceTimeout(chatExternalOnce(url, opts), 25000, "LLM endpoint timed out");
}

async function chatExternalOnce(url: string, opts: RequestInit): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    throw new Error("LLM endpoint unreachable: " + (e as Error).message);
  }
  if (!resp.ok) {
    throw new Error("LLM endpoint HTTP " + resp.status + ": " +
      (await resp.text()).slice(0, 200));
  }
  const body = (await resp.json()) as Record<string, unknown>;
  const content = extractContent(body);
  if (!content) {
    throw new Error("LLM endpoint returned no content");
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
  const tools = await situationRanked(db, records, req.situation, 12);
  const lines: string[] = [
    "Situation: " + req.situation,
    "Scope: " + (req.scope && req.scope.trim() !== "" ? req.scope : "not provided"),
  ];
  if (req.target) lines.push("Target: " + req.target);
  if (req.path) lines.push("Local path: " + req.path);
  if (req.wordlist) lines.push("Wordlist: " + req.wordlist);
  // Tone-only reference: do not laminate step titles so the model writes fresh
  // steps instead of echoing the template.
  lines.push("", "Reference template (TONE ONLY — do not copy its steps): " +
    pb.title + " (" + pb.id + ")");
  lines.push("", "Available catalog tools (use these ids; borrow example commands verbatim when sensible):");
  for (const t of tools) {
    lines.push("- " + t.id + " (" + t.name + ", " + t.kind + "): " + t.summary);
    const cmds = Array.isArray(t.commands) && (t.commands as string[]).length > 0
      ? (t.commands as string[]).join("  ;  ")
      : "";
    if (cmds) lines.push("    example: " + cmds);
  }
  lines.push("", "Write a NEW playbook for this situation and the JSON plan now.");
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
    const cmds: string[] = [];
    for (const id of st.tool_ids ?? []) {
      const rec = byId.get(id);
      if (!rec) continue;
      stepRecs.push(rec);
      for (const c of rec.commands ?? []) cmds.push(expand(c, subs));
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
      // The model picks the tools and structure; commands are synthesized from
      // the catalog records so they are always real flags, never model-made-up.
      commands: cmds,
    });
  });
  return plan;
}

// expand replaces {{placeholders}} with the request values (mirrors planner
// buildPlan so synthesized commands read like the template output).
function expand(cmd: string, subs: Record<string, string>): string {
  let out = cmd;
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
  return out;
}

// llmRecommend validates the gate, schools the configured LLM on the
// situation + matched template, and returns a hydrated Plan. Any failure throws,
// letting the caller fall back to the deterministic template.
export async function llmRecommend(
  db: D1Database,
  cfg: LlmConfig,
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
    chat(cfg, system, user),
    25_000,
    "LLM plan timed out after 25s",
  );
  const draft = parseDraft(content);
  return hydrate(db, req, draft);
}

// raceTimeout rejects (after ms) with msg if the inner promise has not settled,
// leaking the underlying request — fine for stateless /v1/recommend calls.
function raceTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}