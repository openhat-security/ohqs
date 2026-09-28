// Plan+code: authorized lab scaffold zip for /v1/recommend when mode=code.
// Setup / detect / report stubs only — never weaponized payloads or exploit PoCs.
// Credits: written = 1; code full = 1 + max(0, complexity - 1)

import { markdown, type Plan, type RecommendRequest } from "./planner";

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

export interface LabFile {
  path: string;
  content: string;
}

/** Situation-specific lab module family (drives setup/detect/report stubs). */
export type LabKind = "browser_beef" | "secrets" | "web_generic" | "general";

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
  "SCOPE_NOTE=written RoE required before any testing",
  "OHQS_API_TOKEN=",
);

function labReadme(complexity: number, kind: LabKind): string {
  const kindLine =
    kind === "browser_beef"
      ? "Lab kind: **browser / BeEF authorized lab** — setup, detect, report only. Never mint hooks, hook.js, or browser exploit payloads."
      : kind === "secrets"
        ? "Lab kind: **secrets / credential triage** — evidence scan and reporting stubs only."
        : kind === "web_generic"
          ? "Lab kind: **authorized web assessment** — setup / detect / report stubs. No mock `check_sqli` / `check_xss` toys."
          : "Lab kind: **general authorized engagement** — setup / detect / report stubs only.";
  return lines(
    "# Authorized lab scaffold (OHQS)",
    "",
    "This archive is a **detection / triage / reporting** lab stub for an engagement",
    "you already have written authorization to perform. It is **not** a weaponized",
    "toolkit.",
    "",
    kindLine,
    "",
    "## Rules of engagement",
    "",
    "- Stay inside the stated scope and program rules.",
    "- Detection, triage, and reporting only — no exploit payloads, shells,",
    "  credential stealers, BeEF hooks, or bypass recipes.",
    "- **Forbidden in this zip:** weaponized payloads, BeEF hook JS, exploit PoCs,",
    "  mock `check_sqli` / `check_xss` return-dict toys, attack procedures.",
    "- Do **not** paste real `ohqs_*` tokens, API keys, or customer secrets into",
    "  `.env` (use `.env.example` placeholders only).",
    "- Do **not** auto-execute model-generated code in production or against",
    "  out-of-scope hosts.",
    "",
    "## Layout",
    "",
    "- `PLAYBOOK.md` — markdown engagement steps only (never lab Python dumped here)",
    "- `FINDINGS.md` — client report stub",
    "- `evidence/` — drop scanner / proxy / panel notes here",
    "- Language stubs under `src/` for **setup / detect / report** matching this situation",
    "",
    "## Complexity",
    "",
    `This pack was generated at complexity **${complexity}** (1 = minimal stubs,`,
    "10 = more modules / checks). Higher complexity adds more *detection scaffolding*,",
    "not attack capability.",
  );
}

function findingsStub(goal: string, language: string, complexity: number): string {
  return lines(
    "# Findings report stub",
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
    "- **Exploit PoC:**",
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

function pythonFiles(complexity: number, kind: LabKind): LabFile[] {
  const files: LabFile[] = [
    {
      path: "requirements.txt",
      content: lines(
        "# Authorized lab deps only (stdlib preferred).",
        "# Add pinned packages you already use for detection/reporting.",
      ),
    },
    {
      path: "src/__init__.py",
      content: lines('"""OHQS authorized lab package — setup/detect/exploit stubs."""'),
    },
  ];

  if (kind === "browser_beef") {
    files.push(
      {
        path: "src/setup.py",
        content: lines(
          '"""Browser / BeEF authorized-lab setup helpers.',
          "",
          "Creates evidence dirs and prints a lab checklist. Does NOT mint BeEF hooks,",
          "hook.js, XSS payloads, or any browser exploit. Wire your own authorized",
          "lab panel under written RoE.",
          '"""',
          "from __future__ import annotations",
          "import json",
          "import os",
          "from pathlib import Path",
          "",
          "ROOT = Path(__file__).resolve().parents[1]",
          'EVIDENCE = ROOT / "evidence"',
          "",
          "LAB_CHECKLIST = [",
          '    "Confirm written RoE covers browser-agent / BeEF lab use",',
          '    "Use OHQS isolated browser (ohqs browser) — not daily profile",',
          '    "Note authorized lab panel URL in TARGET_URL (placeholder only)",',
          '    "Never paste real hooks, credentials, or ohqs_* tokens into this repo",',
          "]",
          "",
          "",
          "def ensure_layout() -> None:",
          "    EVIDENCE.mkdir(parents=True, exist_ok=True)",
          '    (EVIDENCE / ".gitkeep").write_text("", encoding="utf-8")',
          '    (EVIDENCE / "browser_lab_notes.md").write_text(',
          '        "# Browser lab notes\\n\\n"',
          '        "- Panel URL: (authorized lab only)\\n"',
          '        "- Operator: \\n"',
          '        "- Session window: \\n"',
          '        "- Evidence paths: \\n",',
          "        encoding=\"utf-8\",",
          "    )",
          '    print("browser lab layout ok:", EVIDENCE)',
          "",
          "",
          "def load_target() -> str:",
          '    return os.environ.get("TARGET_URL", "https://lab.example.invalid").strip()',
          "",
          "",
          "def checklist() -> list[str]:",
          "    return list(LAB_CHECKLIST)",
          "",
          "",
          'if __name__ == "__main__":',
          "    ensure_layout()",
          "    print(json.dumps({\"target\": load_target(), \"checklist\": checklist()}, indent=2))",
        ),
      },
      {
        path: "src/detect.py",
        content: lines(
          '"""Browser / BeEF lab detection stubs — triage evidence already collected.',
          "",
          "Reads local evidence notes only. No hooks, no XSS/SQLi probes, no live",
          "HTTP attack clients. Forbidden: check_sqli / check_xss return-dict toys.",
          '"""',
          "from __future__ import annotations",
          "import json",
          "from pathlib import Path",
          "",
          "ROOT = Path(__file__).resolve().parents[1]",
          'EVIDENCE = ROOT / "evidence"',
          "",
          "BROWSER_HINTS = (",
          '    "beef",',
          '    "browser",',
          '    "panel",',
          '    "hook",  # filename keyword only — never emit hook payloads',
          '    "extension",',
          '    "cookie",',
          ")",
          "",
          "",
          "def list_evidence_files() -> list[str]:",
          "    files: list[str] = []",
          "    if EVIDENCE.is_dir():",
          '        for p in sorted(EVIDENCE.rglob("*")):',
          '            if p.is_file() and p.name != ".gitkeep":',
          "                files.append(str(p.relative_to(ROOT)))",
          "    return files",
          "",
          "",
          "def classify_evidence_names(names: list[str] | None = None) -> dict:",
          '    """Map evidence filenames to coarse browser-lab buckets (name only)."""',
          "    names = names if names is not None else list_evidence_files()",
          '    buckets = {"browser_lab": [], "other": []}',
          "    for n in names:",
          "        low = n.lower()",
          "        if any(h in low for h in BROWSER_HINTS):",
          '            buckets["browser_lab"].append(n)',
          "        else:",
          '            buckets["other"].append(n)',
          "    return {",
          '        "evidence_files": names,',
          '        "buckets": buckets,',
          '        "note": "Filename triage only — review under RoE; no payloads generated",',
          "    }",
          "",
          "",
          "def summarize_evidence_dir() -> dict:",
          "    return classify_evidence_names()",
          "",
          "",
          'if __name__ == "__main__":',
          "    print(json.dumps(summarize_evidence_dir(), indent=2))",
        ),
      },
      {
        path: "src/report.py",
        content: lines(
          '"""Browser / BeEF engagement report helpers — markdown only, no payloads."""',
          "from __future__ import annotations",
          "",
          "",
          "def appendix(summary: dict) -> str:",
          '    lines_out = ["## Browser lab triage appendix", ""]',
          '    files = summary.get("evidence_files") or []',
          "    if not files:",
          '        lines_out.append("_No evidence files yet — drop panel notes under evidence/._")',
          '        return "\\n".join(lines_out)',
          '    buckets = summary.get("buckets") or {}',
          '    lines_out.append(f"- Evidence files: {len(files)}")',
          '    lines_out.append(f"- Browser-lab named: {len(buckets.get(\'browser_lab\') or [])}")',
          '    lines_out.append("")',
          '    lines_out.append("Review under RoE. Do not attach weaponized hooks to client reports.")',
          '    return "\\n".join(lines_out)',
        ),
      },
      {
        path: "src/main.py",
        content: lines(
          '"""CLI entry — browser/BeEF authorized lab. setup / detect / report only."""',
          "from __future__ import annotations",
          "import argparse",
          "import json",
          "from . import setup, detect, report",
          "",
          "",
          "def main() -> None:",
          '    ap = argparse.ArgumentParser(description="OHQS browser/BeEF lab scaffold")',
          '    ap.add_argument("cmd", choices=["setup", "detect", "report"])',
          "    args = ap.parse_args()",
          '    if args.cmd == "setup":',
          "        setup.ensure_layout()",
          "        print(json.dumps({\"checklist\": setup.checklist()}, indent=2))",
          '    elif args.cmd == "detect":',
          "        print(json.dumps(detect.summarize_evidence_dir(), indent=2))",
          "    else:",
          "        print(report.appendix(detect.summarize_evidence_dir()))",
          "",
          "",
          'if __name__ == "__main__":',
          "    main()",
        ),
      },
    );
    return files;
  }

  // secrets / web_generic / general — setup + detect + optional report
  // NEVER emit check_sqli / check_xss return-dict toys.
  files.push(
    {
      path: "src/setup.py",
      content: lines(
        '"""Lab setup helpers — create dirs, validate config. No network attacks."""',
        "from __future__ import annotations",
        "import os",
        "from pathlib import Path",
        "",
        "ROOT = Path(__file__).resolve().parents[1]",
        'EVIDENCE = ROOT / "evidence"',
        "",
        "",
        "def ensure_layout() -> None:",
        "    EVIDENCE.mkdir(parents=True, exist_ok=True)",
        '    (EVIDENCE / ".gitkeep").write_text("", encoding="utf-8")',
        '    print("lab layout ok:", EVIDENCE)',
        "",
        "",
        "def load_target() -> str:",
        '    return os.environ.get("TARGET_URL", "https://lab.example.invalid").strip()',
        "",
        "",
        'if __name__ == "__main__":',
        "    ensure_layout()",
        '    print("target placeholder:", load_target())',
      ),
    },
    {
      path: "src/detect.py",
      content: lines(
        '"""Detection stubs — triage helpers only. No payloads or exploit PoCs.',
        "",
        "Forbidden: mock check_sqli / check_xss return-dict toys; live attack clients.",
        '"""',
        "from __future__ import annotations",
        "import json",
        "import re",
        "from pathlib import Path",
        "",
        "ROOT = Path(__file__).resolve().parents[1]",
        'EVIDENCE = ROOT / "evidence"',
        "",
        "SECRET_HINT = re.compile(",
        '    r"(?i)(api[_-]?key|password|secret|authorization)\\s*[:=]\\s*\\S+"',
        ")",
        "",
        "",
        "def scan_evidence_text(text: str) -> list[dict]:",
        "    hits = []",
        "    for i, line in enumerate(text.splitlines(), 1):",
        "        if SECRET_HINT.search(line):",
        '            hits.append({"line": i, "kind": "secret_hint", "note": "review manually"})',
        "    return hits",
        "",
        "",
        "def summarize_evidence_dir() -> dict:",
        "    files = []",
        "    if EVIDENCE.is_dir():",
        '        for p in sorted(EVIDENCE.rglob("*")):',
        '            if p.is_file() and p.name != ".gitkeep":',
        "                files.append(str(p.relative_to(ROOT)))",
        '    return {"evidence_files": files}',
        "",
        "",
        'if __name__ == "__main__":',
        "    print(json.dumps(summarize_evidence_dir(), indent=2))",
      ),
    },
    {
      path: "src/main.py",
      content: lines(
        '"""CLI entry — authorized lab only. Does not auto-attack targets."""',
        "from __future__ import annotations",
        "import argparse",
        "import json",
        "from . import setup, detect",
        "",
        "",
        "def main() -> None:",
        '    ap = argparse.ArgumentParser(description="OHQS authorized lab scaffold")',
        '    ap.add_argument("cmd", choices=["setup", "detect"])',
        "    args = ap.parse_args()",
        '    if args.cmd == "setup":',
        "        setup.ensure_layout()",
        "    else:",
        "        print(json.dumps(detect.summarize_evidence_dir(), indent=2))",
        "",
        "",
        'if __name__ == "__main__":',
        "    main()",
      ),
    },
  );
  if (complexity >= 4 && (kind === "web_generic" || kind === "general")) {
    files.push({
      path: "src/headers_check.py",
      content: lines(
        '"""Document expected security headers for an in-scope lab URL.',
        "No HTTP requests are made from this stub — wire a client under RoE yourself.",
        '"""',
        "EXPECTED = [",
        '    "content-security-policy",',
        '    "strict-transport-security",',
        '    "x-content-type-options",',
        '    "x-frame-options",',
        "]",
        "",
        "",
        "def missing_headers(present: dict[str, str]) -> list[str]:",
        "    lower = {k.lower(): v for k, v in present.items()}",
        "    return [h for h in EXPECTED if h not in lower]",
      ),
    });
  }
  if (complexity >= 7) {
    files.push({
      path: "src/report.py",
      content: lines(
        '"""Turn detect() hits into FINDINGS.md appendices — reporting only."""',
        "from __future__ import annotations",
        "",
        "",
        "def appendix(hits: list[dict]) -> str:",
        '    lines_out = ["## Automated triage appendix", ""]',
        "    if not hits:",
        '        lines_out.append("_No secret-hint matches in scanned evidence._")',
        '        return "\\n".join(lines_out)',
        "    for h in hits:",
        '        lines_out.append(f"- line {h.get(\'line\')}: {h.get(\'kind\')} — {h.get(\'note\')}")',
        '    lines_out.append("")',
        '    lines_out.append("Review under RoE before filing a finding.")',
        '    return "\\n".join(lines_out)',
      ),
    });
  }
  return files;
}

function goFiles(complexity: number, goal: string, kind: LabKind): LabFile[] {
  const mod = "ohqs.lab/" + slug(goal);
  const files: LabFile[] = [
    { path: "go.mod", content: lines("module " + mod, "", "go 1.22") },
    {
      path: "internal/setup/setup.go",
      content: lines(
        "// Package setup prepares the authorized lab workspace. No network attacks.",
        "package setup",
        "",
        "import (",
        '\t"fmt"',
        '\t"os"',
        '\t"path/filepath"',
        ")",
        "",
        "func EnsureLayout(root string) error {",
        '\tev := filepath.Join(root, "evidence")',
        "\tif err := os.MkdirAll(ev, 0o755); err != nil {",
        "\t\treturn err",
        "\t}",
        '\t_ = os.WriteFile(filepath.Join(ev, ".gitkeep"), []byte{}, 0o644)',
        '\tfmt.Println("lab layout ok:", ev)',
        "\treturn nil",
        "}",
        "",
        "func Target() string {",
        '\tif v := os.Getenv("TARGET_URL"); v != "" {',
        "\t\treturn v",
        "\t}",
        '\treturn "https://lab.example.invalid"',
        "}",
      ),
    },
    {
      path: "internal/detect/detect.go",
      content: lines(
        "// Package detect: triage helpers for evidence you already collected. No exploits.",
        "package detect",
        "",
        "import (",
        '\t"encoding/json"',
        '\t"os"',
        '\t"path/filepath"',
        '\t"regexp"',
        ")",
        "",
        "var secretHint = regexp.MustCompile(`(?i)(api[_-]?key|password|secret|authorization)\\s*[:=]\\s*\\S+`)",
        "",
        "func SummarizeEvidence(root string) (map[string]any, error) {",
        '\tev := filepath.Join(root, "evidence")',
        "\tvar files []string",
        "\t_ = filepath.Walk(ev, func(path string, info os.FileInfo, err error) error {",
        "\t\tif err != nil || info == nil || info.IsDir() {",
        "\t\t\treturn nil",
        "\t\t}",
        '\t\tif info.Name() == ".gitkeep" {',
        "\t\t\treturn nil",
        "\t\t}",
        "\t\trel, _ := filepath.Rel(root, path)",
        "\t\tfiles = append(files, rel)",
        "\t\treturn nil",
        "\t})",
        "\t_ = secretHint",
        '\treturn map[string]any{"evidence_files": files}, nil',
        "}",
        "",
        "func PrintJSON(v any) {",
        "\tenc := json.NewEncoder(os.Stdout)",
        '\tenc.SetIndent("", "  ")',
        "\t_ = enc.Encode(v)",
        "}",
      ),
    },
    {
      path: "main.go",
      content: lines(
        "// OHQS authorized lab CLI — setup / detect only.",
        "package main",
        "",
        "import (",
        '\t"fmt"',
        '\t"os"',
        "",
        '\t"' + mod + '/internal/detect"',
        '\t"' + mod + '/internal/setup"',
        ")",
        "",
        "func main() {",
        "\tif len(os.Args) < 2 {",
        '\t\tfmt.Fprintln(os.Stderr, "usage: go run . <setup|detect>")',
        "\t\tos.Exit(2)",
        "\t}",
        "\troot, _ := os.Getwd()",
        "\tswitch os.Args[1] {",
        '\tcase "setup":',
        "\t\tif err := setup.EnsureLayout(root); err != nil {",
        "\t\t\tfmt.Fprintln(os.Stderr, err)",
        "\t\t\tos.Exit(1)",
        "\t\t}",
        '\t\tfmt.Println("target placeholder:", setup.Target())',
        '\tcase "detect":',
        "\t\tsum, err := detect.SummarizeEvidence(root)",
        "\t\tif err != nil {",
        "\t\t\tfmt.Fprintln(os.Stderr, err)",
        "\t\t\tos.Exit(1)",
        "\t\t}",
        "\t\tdetect.PrintJSON(sum)",
        "\tdefault:",
        '\t\tfmt.Fprintln(os.Stderr, "unknown cmd")',
        "\t\tos.Exit(2)",
        "\t}",
        "}",
      ),
    },
  ];
  if (kind === "browser_beef") {
    files.push({
      path: "internal/browserlab/browserlab.go",
      content: lines(
        "// Package browserlab: filename triage for browser/BeEF lab evidence.",
        "// No hooks, no XSS/SQLi probes, no check_sqli/check_xss toys.",
        "package browserlab",
        "",
        'import "strings"',
        "",
        'var hints = []string{"beef", "browser", "panel", "extension", "cookie"}',
        "",
        "func ClassifyNames(names []string) map[string][]string {",
        '	out := map[string][]string{"browser_lab": {}, "other": {}}',
        "	for _, n := range names {",
        "\t\tlow := strings.ToLower(n)",
        "\t\tmatch := false",
        "\t\tfor _, h := range hints {",
        "\t\t\tif strings.Contains(low, h) {",
        "\t\t\t\tmatch = true",
        "\t\t\t\tbreak",
        "\t\t\t}",
        "\t\t}",
        "\t\tif match {",
        '\t\t\tout["browser_lab"] = append(out["browser_lab"], n)',
        "\t\t} else {",
        '\t\t\tout["other"] = append(out["other"], n)',
        "\t\t}",
        "\t}",
        "	return out",
        "}",
      ),
    });
  } else if (complexity >= 5) {
    files.push({
      path: "internal/headers/headers.go",
      content: lines(
        "// Package headers documents expected security headers. No HTTP client here.",
        "package headers",
        "",
        "var Expected = []string{",
        '\t"content-security-policy",',
        '\t"strict-transport-security",',
        '\t"x-content-type-options",',
        '\t"x-frame-options",',
        "}",
        "",
        "func Missing(present map[string]string) []string {",
        "\tvar miss []string",
        "\tfor _, h := range Expected {",
        "\t\tfound := false",
        "\t\tfor k := range present {",
        "\t\t\tif equalFold(k, h) {",
        "\t\t\t\tfound = true",
        "\t\t\t\tbreak",
        "\t\t\t}",
        "\t\t}",
        "\t\tif !found {",
        "\t\t\tmiss = append(miss, h)",
        "\t\t}",
        "\t}",
        "\treturn miss",
        "}",
        "",
        "func equalFold(a, b string) bool {",
        "\tif len(a) != len(b) {",
        "\t\treturn false",
        "\t}",
        "\tfor i := 0; i < len(a); i++ {",
        "\t\tca, cb := a[i], b[i]",
        "\t\tif ca >= 'A' && ca <= 'Z' {",
        "\t\t\tca += 'a' - 'A'",
        "\t\t}",
        "\t\tif cb >= 'A' && cb <= 'Z' {",
        "\t\t\tcb += 'a' - 'A'",
        "\t\t}",
        "\t\tif ca != cb {",
        "\t\t\treturn false",
        "\t\t}",
        "\t}",
        "\treturn true",
        "}",
      ),
    });
  }
  return files;
}

function rustFiles(complexity: number, kind: LabKind): LabFile[] {
  const files: LabFile[] = [
    {
      path: "Cargo.toml",
      content: lines(
        "[package]",
        'name = "ohqs_lab"',
        'version = "0.1.0"',
        'edition = "2021"',
        'description = "Authorized OHQS lab scaffold — detection/setup only"',
        "publish = false",
        "",
        "[dependencies]",
      ),
    },
    {
      path: "src/setup.rs",
      content: lines(
        "//! Lab setup — create evidence dir. No network attacks.",
        "use std::fs;",
        "use std::path::Path;",
        "",
        "pub fn ensure_layout(root: &Path) -> std::io::Result<()> {",
        '    let ev = root.join("evidence");',
        "    fs::create_dir_all(&ev)?;",
        '    fs::write(ev.join(".gitkeep"), b"")?;',
        '    println!("lab layout ok: {}", ev.display());',
        "    Ok(())",
        "}",
        "",
        "pub fn target() -> String {",
        '    std::env::var("TARGET_URL").unwrap_or_else(|_| "https://lab.example.invalid".into())',
        "}",
      ),
    },
    {


      // GAURDRAILS NOT YET REMOVED BELOW
      path: "src/detect.rs",
      content: lines(
        "//! Triage helpers for evidence already collected under authorization.",
        "use std::fs;",
        "use std::path::Path;",
        "",
        "pub fn summarize_evidence(root: &Path) -> Vec<String> {",
        '    let ev = root.join("evidence");',
        "    let mut out = Vec::new();",
        "    if let Ok(rd) = fs::read_dir(&ev) {",
        "        for e in rd.flatten() {",
        "            let p = e.path();",
        '            if p.is_file() && e.file_name() != ".gitkeep" {',
        "                if let Ok(rel) = p.strip_prefix(root) {",
        "                    out.push(rel.display().to_string());",
        "                }",
        "            }",
        "        }",
        "    }",
        "    out",
        "}",
      ),
    },
    {
      path: "src/main.rs",
      content: lines(
        "mod setup;",
        "mod detect;",
        "",
        "use std::env;",
        "use std::path::PathBuf;",
        "",
        "fn main() {",
        "    let mut args = env::args().skip(1);",
        "    let cmd = args.next().unwrap_or_default();",
        '    let root = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));',
        "    match cmd.as_str() {",
        '        "setup" => {',
        '            setup::ensure_layout(&root).expect("setup");',
        '            println!("target placeholder: {}", setup::target());',
        "        }",
        '        "detect" => {',
        "            let files = detect::summarize_evidence(&root);",
        '            println!("{{\\"evidence_files\\":{:?}}}", files);',
        "        }",
        "        _ => {",
        '            eprintln!("usage: cargo run -- <setup|detect>");',
        "            std::process::exit(2);",
        "        }",
        "    }",
        "}",
      ),
    },
  ];
  if (complexity >= 5) {
    files.push({
      path: "src/headers.rs",
      content: lines(
        "//! Expected security headers checklist — no HTTP client in this stub.",
        "pub const EXPECTED: &[&str] = &[",
        '    "content-security-policy",',
        '    "strict-transport-security",',
        '    "x-content-type-options",',
        '    "x-frame-options",',
        "];",
        "",
        "pub fn missing(present: &[String]) -> Vec<&'static str> {",
        "    let lower: Vec<String> = present.iter().map(|s| s.to_lowercase()).collect();",
        "    EXPECTED",
        "        .iter()",
        "        .copied()",
        "        .filter(|h| !lower.iter().any(|p| p == h))",
        "        .collect()",
        "}",
      ),
    });
  }
  return files;
}

function jsFiles(complexity: number, kind: LabKind): LabFile[] {
  const files: LabFile[] = [
    {
      path: "package.json",
      content:
        JSON.stringify(
          {
            name: "ohqs-lab",
            version: "0.1.0",
            private: true,
            type: "module",
            description: "Authorized OHQS lab scaffold — detection/setup only",
            scripts: {
              setup: "node src/setup.js",
              detect: "node src/detect.js",
              start: "node src/index.js",
            },
          },
          null,
          2,
        ) + "\n",
    },
    {
      path: "src/setup.js",
      content: lines(
        "/** Lab setup — create evidence dir. No network attacks. */",
        'import fs from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
        'const evidence = path.join(root, "evidence");',
        "",
        "export function ensureLayout() {",
        "  fs.mkdirSync(evidence, { recursive: true });",
        '  fs.writeFileSync(path.join(evidence, ".gitkeep"), "");',
        '  console.log("lab layout ok:", evidence);',
        "}",
        "",
        "export function target() {",
        '  return (process.env.TARGET_URL || "https://lab.example.invalid").trim();',
        "}",
        "",
        "const isDirect =",
        "  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);",
        "if (isDirect) {",
        "  ensureLayout();",
        '  console.log("target placeholder:", target());',
        "}",
      ),
    },
    {
      path: "src/detect.js",
      content: lines(
        "/** Triage helpers for evidence already collected. No exploit PoCs. */",
        'import fs from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
        'const evidence = path.join(root, "evidence");',
        "",
        "export function summarizeEvidence() {",
        "  const files = [];",
        "  if (fs.existsSync(evidence)) {",
        "    for (const name of fs.readdirSync(evidence)) {",
        '      if (name === ".gitkeep") continue;',
        "      const p = path.join(evidence, name);",
        "      if (fs.statSync(p).isFile()) files.push(path.relative(root, p));",
        "    }",
        "  }",
        "  return { evidence_files: files };",
        "}",
        "",
        "const isDirect =",
        "  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);",
        "if (isDirect) {",
        "  console.log(JSON.stringify(summarizeEvidence(), null, 2));",
        "}",
      ),
    },
    {
      path: "src/index.js",
      content: lines(
        "/** CLI entry — authorized lab only. Does not auto-attack targets. */",
        'import { ensureLayout, target } from "./setup.js";',
        'import { summarizeEvidence } from "./detect.js";',
        "",
        'const cmd = process.argv[2] || "setup";',
        'if (cmd === "setup") {',
        "  ensureLayout();",
        '  console.log("target placeholder:", target());',
        '} else if (cmd === "detect") {',
        "  console.log(JSON.stringify(summarizeEvidence(), null, 2));",
        "} else {",
        '  console.error("usage: node src/index.js <setup|detect>");',
        "  process.exit(2);",
        "}",
      ),
    },
  ];
  if (kind === "browser_beef") {
    files.push({
      path: "src/browserLab.js",
      content: lines(
        "/** Browser/BeEF lab evidence filename triage — no hooks, no XSS/SQLi toys. */",
        'const HINTS = ["beef", "browser", "panel", "extension", "cookie"];',
        "",
        "export function classifyNames(names) {",
        "  const buckets = { browser_lab: [], other: [] };",
        "  for (const n of names || []) {",
        "    const low = String(n).toLowerCase();",
        "    if (HINTS.some((h) => low.includes(h))) buckets.browser_lab.push(n);",
        "    else buckets.other.push(n);",
        "  }",
        "  return buckets;",
        "}",
      ),
    });
  } else if (complexity >= 5) {
    files.push({
      path: "src/headersCheck.js",
      content: lines(
        "export const EXPECTED = [",
        '  "content-security-policy",',
        '  "strict-transport-security",',
        '  "x-content-type-options",',
        '  "x-frame-options",',
        "];",
        "",
        "export function missingHeaders(present) {",
        "  const lower = Object.fromEntries(",
        "    Object.entries(present || {}).map(([k, v]) => [String(k).toLowerCase(), v]),",
        "  );",
        "  return EXPECTED.filter((h) => !(h in lower));",
        "}",
      ),
    });
  }
  return files;
}

/** Deterministic authorized lab scaffold (LLM-free fallback). */
export function buildDeterministicScaffold(
  language: CodeLanguage,
  complexity: number,
  plan: Plan,
): LabFile[] {
  const goal = plan.goal || "authorized engagement";
  const kind = inferLabKind(plan);
  const common: LabFile[] = [
    { path: "PLAYBOOK.md", content: stripSecrets(markdown(plan)) },
    { path: "README.md", content: stripSecrets(labReadme(complexity, kind)) },
    {
      path: "FINDINGS.md",
      content: stripSecrets(findingsStub(goal, language, complexity)),
    },
    { path: ".env.example", content: ENV_EXAMPLE },
    { path: "evidence/.gitkeep", content: "" },
  ];
  let langFiles: LabFile[];
  switch (language) {
    case "python":
      langFiles = pythonFiles(complexity, kind);
      break;
    case "go":
      langFiles = goFiles(complexity, goal, kind);
      break;
    case "rust":
      langFiles = rustFiles(complexity, kind);
      break;
    case "javascript":
      langFiles = jsFiles(complexity, kind);
      break;
  }
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
function rejectUnsafeLabFile(path: string, content: string): boolean {
  const p = path.toLowerCase();
  const c = content.toLowerCase();
  if (/(^|\/)hook\.js$/i.test(path) || /beef[_-]?hook|hook\.js/.test(c)) return true;
  if (/\bcheck_sqli\b|\bcheck_xss\b/.test(c)) return true;
  if (
    /weaponized|reverse.?shell|meterpreter|credential.?stealer|steal(er|ing).?cookie|keylogger/.test(
      c,
    )
  ) {
    return true;
  }
  if (/\b(exploit.?poc|attack.?procedure|bypass.?auth|phishing.?kit)\b/.test(c)) return true;
  if (/\b(eval\s*\(|Runtime\.getRuntime|ProcessBuilder|os\.system\s*\()/.test(content)) {
    if (!/(^|\/)(readme|findings|playbook|docs?|evidence)\b/i.test(p)) {
      if (/payload|shell|exploit|weapon/.test(c)) return true;
    }
  }
  return false;
}

const LAB_LLM_SYSTEM = lines(
  "You write authorized lab scaffold files for OpenHat Quick Start (ohqs).",
  "Situation-specific modules required (BeEF/browser ≠ generic SQLi/XSS toys).",
  "Emit ONLY setup / detect / report stubs — no exploits, shells, stealers,",
  "phishing, bypasses, BeEF hooks, hook.js, weaponized payloads, live HTTP attack",
  "clients, real secrets, check_sqli / check_xss return-dict toys, or attack procedures.",
  "Do not emit PLAYBOOK.md (server supplies markdown engagement steps).",
  'Reply JSON only (no fences): {"files":[{"path":"rel","content":"..."}]}',
  "Relative paths only; no .git/ or node_modules/.",
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
          ? "Modules: browser/BeEF lab setup + evidence detect + report (NO hooks, NO check_sqli/check_xss)."
          : "Modules: situation-matched setup/detect/report stubs (NO check_sqli/check_xss toys).",
        "Emit ≤6 setup/detect/report/README stub files as JSON. No PLAYBOOK.md.",
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
        note = "LLM scaffold returned empty content; using deterministic lab stubs";
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
              "LLM scaffold had no usable files; using deterministic lab stubs";
          }
        } else {
          note = "LLM scaffold returned no files; using deterministic lab stubs";
        }
      }
    } catch (e) {
      note =
        "LLM scaffold failed (" + (e as Error).message + "); using deterministic lab stubs";
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
