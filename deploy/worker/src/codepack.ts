// Plan+code: runnable lab zip for /v1/recommend when mode=code (full E2E runners).
// Credits: written = 1; code full = 1 + max(0, complexity - 1)

import { markdown, type Plan, type RecommendRequest } from "./planner";
import {
  goE2eFiles,
  jsE2eFiles,
  pythonE2eFiles,
  rustE2eFiles,
} from "./codepack-e2e";
import type { LabFile, LabKind } from "./codepack-types";

export type { LabFile, LabKind } from "./codepack-types";

export const CODE_LANGUAGES = ["python", "go", "rust", "javascript"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export type RecommendMode = "written" | "code";

export function parseRecommendMode(raw: unknown): RecommendMode {
  const s = String(raw ?? "written").trim().toLowerCase();
  if (s === "code" || s === "plan+code" || s === "plan_code") return "code";
  return "written";
}

export function parseLanguage(raw: unknown): CodeLanguage | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if ((CODE_LANGUAGES as readonly string[]).includes(s)) return s as CodeLanguage;
  return null;
}

export function parseComplexity(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 10) return null;
  return n;
}

/**
 * Server-side credit math. UI preview shows the *max* for code mode;
 * actual charge uses recommendCreditsCharged after plan+scaffold outcomes.
 * Written = 1. Code full = 1 + max(0, complexity - 1) only when both live.
 */

export function recommendCredits(mode: RecommendMode, complexity: number): number {
  if (mode !== "code") return 1;
  return 1 + Math.max(0, complexity - 1);
}

/**
 * Actual charge for plan+code:
 * - Complexity premium ONLY when BOTH plan and scaffold are live LLM
 * - Template plan → max 1 even if scaffold later succeeds
 */
export function recommendCreditsCharged(
  mode: RecommendMode,
  complexity: number,
  planLive: boolean,
  scaffoldLive: boolean,
): number {
  if (mode !== "code") return 1;
  if (!planLive || !scaffoldLive) return 1;
  return 1 + Math.max(0, complexity - 1);
}

export function validateCodeRequest(req: RecommendRequest): {
  mode: RecommendMode;
  language?: CodeLanguage;
  complexity?: number;
  credits: number;
  error?: string;
} {
  const mode = parseRecommendMode(req.mode);
  if (mode === "written") {
    return { mode, credits: 1 };
  }
  const language = parseLanguage(req.language);
  if (!language) {
    return {
      mode,
      credits: 0,
      error: "language required for mode=code (python|go|rust|javascript)",
    };
  }
  const complexity = parseComplexity(req.complexity ?? 3);
  if (complexity === null) {
    return {
      mode,
      language,
      credits: 0,
      error: "complexity must be an integer 1–10",
    };
  }
  return {
    mode,
    language,
    complexity,
    credits: recommendCredits("code", complexity),
  };
}

/**
 * Infer lab module kind from plan goal / playbook.
 */
export function inferLabKind(plan: Plan): LabKind {
  const blob = [
    plan.goal || "",
    plan.playbook || "",
    plan.playbook_title || "",
  ]
    .join(" ")
    .toLowerCase();
  if (
    /\bbeef\b|browser.?exploit|hook.?panel|xss.?hook|browser.?agent|browser.?c2|hooked.?browser/.test(
      blob,
    )
  ) {
    return "browser_beef";
  }
  if (/secret|gitleaks|credential.?leak|api.?key|env.?leak|trufflehog/.test(blob)) {
    return "secrets";
  }
  if (
    /web.?app|next\.?js|owasp|idor|access.?control|bounty|bug.?bounty|xss|sqli|injection/.test(
      blob,
    )
  ) {
    // Headers / setup / report stubs only — not check_sqli/check_xss toys.
    return "web_generic";
  }
  return "general";
}

const SECRET_PATTERNS: RegExp[] = [
  /\bohqs_[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g,
  /\bOPENROUTER_API_KEY\s*=\s*.+/gi,
  /\bLLM_API_KEY\s*=\s*.+/gi,
  /\bFLEXPRICE_API_KEY\s*=\s*.+/gi,
  /\bADMIN_TOKEN\s*=\s*.+/gi,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
];

/** Strip secrets / token-looking values from scaffold text before zip. */
export function stripSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      if (/^ohqs_/i.test(m)) return "ohqs_REDACTED";
      if (/^sk-/i.test(m)) return "sk-REDACTED";
      if (/Bearer\s+/i.test(m)) return "Bearer REDACTED";
      if (/=/.test(m)) return m.replace(/=.*/, "=REDACTED");
      return "REDACTED";
    });
  }
  return out;
}

function slug(s: string): string {
  return (
    (s || "lab")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "lab"
  );
}

function lines(...rows: string[]): string {
  return rows.join("\n") + "\n";
}

const ENV_EXAMPLE = lines(
  "# Placeholders only — never commit real keys or ohqs_* tokens.",
  "TARGET_URL=https://lab.example.invalid",
  "SCOPE_NOTE=optional RoE / program note",
  "OHQS_API_TOKEN=",
);

function labReadme(complexity: number, kind: LabKind, language: CodeLanguage): string {
  const kindLine =
    kind === "browser_beef"
      ? "Lab kind: **browser / BeEF** — live HTTP recon plus browser-hint triage."
      : kind === "secrets"
        ? "Lab kind: **secrets** — repo secret scan + web probes."
        : kind === "web_generic"
          ? "Lab kind: **web assessment** — recon, SQLi/XSS/CMDi probes, evidence JSON."
          : "Lab kind: **general offsec** — full probe chain.";
  const runHint =
    language === "python"
      ? "`./run.sh full` or `python -m src.main full` after `pip install -r requirements.txt`"
      : language === "go"
        ? "`go run . full`"
        : language === "rust"
          ? "`cargo run -- full`"
          : "`npm run full`";
  return lines(
    "# OpenHat lab pack (OHQS)",
    "",
    "Runnable end-to-end research code generated from your playbook.",
    "",
    kindLine,
    "",
    "## Quick start",
    "",
    "1. Copy `.env.example` → `.env` and set `TARGET_URL`.",
    "2. Run: " + runHint,
    "3. Inspect `evidence/*.json` and append to `FINDINGS.md`.",
    "",
    "Do not commit real API keys or `ohqs_*` tokens.",
    "",
    "## Complexity",
    "",
    `Pack complexity **${complexity}** (metadata for billing; runner is always full-chain).`,
  );
}

function findingsStub(goal: string, language: string, complexity: number): string {
  return lines(
    "# Findings report",
    "",
    `**Goal:** ${goal}`,
    `**Language:** ${language}`,
    `**Complexity:** ${complexity}`,
    "",
    "## Executive summary",
    "",
    "<!-- Fill after authorized testing -->",
    "",
    "## Findings",
    "",
    "<!-- Copy one block per confirmed issue. Attach evidence from evidence/ -->",
    "",
    "### Finding title",
    "",
    "- **Severity:**",
    "- **Affected:**",
    "- **Steps to reproduce:** (authorized scope only)",
    "- **Evidence:** `evidence/_file_`",
    "- **Impact:**",
    "- **Exploit PoC:** (attach evidence/*.json, request/response)",
    "- **Fix:**",
    "",
    "## Coverage checklist",
    "",
    "- [ ] Stayed inside written authorization / RoE",
    "- [ ] Access control / IDOR where applicable",
    "- [ ] Secrets in repo, JS, and env-style files",
    "- [ ] Injection only on parameters you have a reason to test",
    "- [ ] Findings include evidence + fix + PoC",
    "",
    "---",
  );
}

function languagePack(
  language: CodeLanguage,
  complexity: number,
  plan: Plan,
  kind: LabKind,
): LabFile[] {
  const goal = plan.goal || "engagement";
  switch (language) {
    case "python":
      return pythonE2eFiles(complexity, kind);
    case "go":
      return goE2eFiles(complexity, goal, kind);
    case "rust":
      return rustE2eFiles(complexity, kind);
    case "javascript":
      return jsE2eFiles(complexity, kind);
  }
}


/** Deterministic E2E lab pack (LLM-free fallback). */
export function buildDeterministicScaffold(
  language: CodeLanguage,
  complexity: number,
  plan: Plan,
): LabFile[] {
  const goal = plan.goal || "offsec engagement";
  const kind = inferLabKind(plan);
  const common: LabFile[] = [
    { path: "PLAYBOOK.md", content: stripSecrets(markdown(plan)) },
    {
      path: "README.md",
      content: stripSecrets(labReadme(complexity, kind, language)),
    },
    {
      path: "FINDINGS.md",
      content: stripSecrets(findingsStub(goal, language, complexity)),
    },
    { path: ".env.example", content: ENV_EXAMPLE },
    { path: "evidence/.gitkeep", content: "" },
  ];
  const langFiles = languagePack(language, complexity, plan, kind);
  return common.concat(langFiles).map((f) => ({
    path: f.path,
    content: stripSecrets(f.content),
  }));
}

// ---- minimal ZIP (STORE only, no deps) ----

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Build an uncompressed zip from text files. Paths use forward slashes. */
export function zipFiles(files: LabFile[]): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = f.path.replace(/^\/+/, "").replace(/\\/g, "/");
    const nameBytes = enc.encode(name);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  const localBlob = concat(localParts);
  const centralBlob = concat(centralParts);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBlob.length),
    u32(localBlob.length),
    u16(0),
  ]);
  return concat([localBlob, centralBlob, end]);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/**
 * Drop LLM scaffold files that look like weaponized / attack-procedure content.
 * Deterministic stubs already avoid this; filter model output before zip.
 */
/** Reject only path traversal or secret-looking env dumps from LLM output. */
function rejectUnsafeLabFile(path: string, content: string): boolean {
  if (/(?:^|\/)\.\./.test(path) || path.startsWith("/")) return true;
  if (/node_modules|\.git\//.test(path)) return true;
  if (/\bohqs_[A-Za-z0-9_-]{20,}\b/.test(content)) return true;
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(content)) return true;
  return false;
}

const LAB_LLM_SYSTEM = lines(
  "You write runnable end-to-end offensive-security lab code for OpenHat Quick Start (ohqs).",
  "Emit working source files: HTTP client, recon, SQLi/XSS/CMDi probes, CLI entrypoint, optional report helper.",
  "Use TARGET_URL from the environment. Prefer the requested language idioms.",
  "Do not emit PLAYBOOK.md (server supplies it). No real API keys or ohqs_* tokens.",
  'Reply JSON only (no fences): {"files":[{"path":"rel","content":"..."}]}',
  "Relative paths only; max 8 files.",
).trim();


/**
 * Try LLM scaffold; on any failure return deterministic pack.
 * Caller may pass chatFn when OpenRouter / Workers AI is configured.
 */
export async function buildLabZip(
  language: CodeLanguage,
  complexity: number,
  plan: Plan,
  opts?: {
    chatFn?: (system: string, user: string) => Promise<string>;
  },
): Promise<{
  bytes: Uint8Array;
  files: LabFile[];
  note?: string;
  /** True only when at least one LLM-authored file was accepted. */
  llm_scaffold: boolean;
}> {
  let files = buildDeterministicScaffold(language, complexity, plan);
  let note: string | undefined;
  let llmScaffold = false;
  if (opts?.chatFn) {
    try {
      const kind = inferLabKind(plan);
      const user = [
        "Lang: " + language,
        "Complexity: " + complexity,
        "LabKind: " + kind,
        "Situation: " + (plan.goal || "").slice(0, 220),
        "Title: " + (plan.playbook_title || "").slice(0, 80),
        kind === "browser_beef"
          ? "Modules: browser/BeEF lab — HTTP fetch, hint scan, full probe chain."
          : "Modules: full web assessment runner (recon + sqli + xss + cmdi + evidence JSON).",
        "Emit ≤8 runnable source files as JSON. No PLAYBOOK.md.",
      ].join("\n");
      let raw = await opts.chatFn(LAB_LLM_SYSTEM, user);
      let parsed = raw && raw.trim() ? parseLabFilesJson(raw) : [];
      if ((!raw || !raw.trim() || parsed.length === 0) && opts.chatFn) {
        console.warn(
          "LLM scaffold first pass unusable; salvage retry",
          raw ? raw.replace(/\s+/g, " ").slice(0, 120) : "(empty)",
        );
        const salvageUser =
          user +
          "\n\nIMPORTANT: previous reply was invalid or truncated JSON. Reply with ONLY a compact JSON object {\"files\":[{\"path\":\"...\",\"content\":\"...\"}]} — max 4 short files, escape newlines as \\n.";
        try {
          raw = await opts.chatFn(LAB_LLM_SYSTEM, salvageUser);
          parsed = raw && raw.trim() ? parseLabFilesJson(raw) : [];
        } catch (e2) {
          console.warn("LLM scaffold salvage failed:", (e2 as Error).message);
        }
      }
      if (!raw || !raw.trim()) {
        note = "LLM scaffold returned empty content; using deterministic E2E pack";
        console.warn("LLM scaffold empty content");
      } else {
        if (parsed.length === 0) {
          console.warn(
            "LLM scaffold non-JSON / no files (first 180 chars):",
            raw.replace(/\s+/g, " ").slice(0, 180),
          );
        }
        if (parsed.length > 0) {
          const byPath = new Map(files.map((f) => [f.path, f]));
          let dropped = 0;
          let accepted = 0;
          for (const f of parsed) {
            if (!f.path || /(?:^|\/)\.\./.test(f.path) || f.path.startsWith("/")) continue;
            if (/node_modules|\.git\//.test(f.path)) continue;
            if (rejectUnsafeLabFile(f.path, f.content || "")) {
              dropped++;
              continue;
            }
            byPath.set(f.path, { path: f.path, content: stripSecrets(f.content || "") });
            accepted++;
          }
          if (dropped > 0) {
            note =
              (note ? note + "; " : "") +
              "dropped " +
              dropped +
              " unsafe LLM scaffold file(s)";
          }
          byPath.set("PLAYBOOK.md", {
            path: "PLAYBOOK.md",
            content: stripSecrets(markdown(plan)),
          });
          byPath.set(".env.example", { path: ".env.example", content: ENV_EXAMPLE });
          if (!byPath.has("evidence/.gitkeep")) {
            byPath.set("evidence/.gitkeep", { path: "evidence/.gitkeep", content: "" });
          }
          files = Array.from(byPath.values());
          if (accepted > 0) {
            llmScaffold = true;
          } else {
            note =
              (note ? note + "; " : "") +
              "LLM scaffold had no usable files; using deterministic E2E pack";
          }
        } else {
          note = "LLM scaffold returned no files; using deterministic E2E pack";
        }
      }
    } catch (e) {
      note =
        "LLM scaffold failed (" + (e as Error).message + "); using deterministic E2E pack";
    }
  }
  files = files.map((f) => ({ path: f.path, content: stripSecrets(f.content) }));
  return { bytes: zipFiles(files), files, note, llm_scaffold: llmScaffold };
}


/** Free models often emit raw newlines inside JSON strings — repair before parse. */
function repairJsonStringNewlines(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
        continue;
      }
      if (c === "\\") {
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = false;
        out += c;
        continue;
      }
      if (c === "\n") {
        out += "\\n";
        continue;
      }
      if (c === "\r") {
        out += "\\r";
        continue;
      }
      if (c === "\t") {
        out += "\\t";
        continue;
      }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
}

function parseLabFilesJson(s: string): LabFile[] {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json|JSON)?[ \t]*\r?\n?/i, "");
    const i = t.lastIndexOf("```");
    if (i >= 0) t = t.slice(0, i);
    t = t.trim();
  }
  const tryParseFiles = (raw: string): LabFile[] => {
    try {
      const v = JSON.parse(repairJsonStringNewlines(raw)) as unknown;
      let arr: unknown[] | null = null;
      if (Array.isArray(v)) arr = v;
      else if (v && typeof v === "object" && Array.isArray((v as { files?: unknown }).files)) {
        arr = (v as { files: unknown[] }).files;
      }
      if (!arr) return [];
      const out: LabFile[] = [];
      for (const item of arr.slice(0, 12)) {
        const rec = item as { path?: unknown; content?: unknown };
        if (typeof rec.path !== "string" || typeof rec.content !== "string") continue;
        out.push({ path: rec.path, content: rec.content });
      }
      return out;
    } catch {
      return [];
    }
  };
  const startObj = t.indexOf("{");
  const endObj = t.lastIndexOf("}");
  if (startObj >= 0 && endObj > startObj) {
    const got = tryParseFiles(t.slice(startObj, endObj + 1));
    if (got.length) return got;
  }
  const startArr = t.indexOf("[");
  const endArr = t.lastIndexOf("]");
  if (startArr >= 0 && endArr > startArr) {
    return tryParseFiles(t.slice(startArr, endArr + 1));
  }
  return [];
}
