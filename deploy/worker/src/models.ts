// Port of internal/models (fit, host, catalog) so the edge API returns the same
// recommended-local-GGUF response shape as the Go server.

export interface HostInfo {
  ramgb: number;
  vramgb: number;
  label: string;
}

export interface Model {
  id: string;
  repo: string;
  paramsb: number;
  activeb: number;
  family: string;
  why: string;
  quant: string;
  overhead_gb: number;
  min_imem_gb: number;
  min_imem_note?: string;
  license: string;
  notes: string;
  recommended: boolean;
}

export interface Fit {
  model: Model;
  quant: string;
  requiredgb: number;
  available: number;
  fits: boolean;
  shortgb: number;
}

export interface Recommendation extends Fit {
  score: number;
}

// Mirrors models.DefaultModels.
export const DefaultModels: Model[] = [
  {
    id: "ravenx",
    repo: "deadbydawn101/RavenX-CyberAgent-Qwen3.6-35B-A3B-Opus-4.7-OpenMythos-Pentester-BugHunter-RATH-GGUF",
    paramsb: 35,
    activeb: 3,
    family: "Qwen3.6-35B-A3B MoE",
    why: "Large MoE-safe agentic persona custom-trained for pentest/bug-hunt triage. Needs a serious GPU.",
    quant: "Q4_K_M",
    overhead_gb: 2.0,
    min_imem_gb: 24,
    min_imem_note: "24 GB VRAM recommended (Q4_K_M ≈ 22 GB weights + 2 GB KV/overhead).",
    license: "see model card",
    notes: "Unsloth-managed: `ohqs models install ravenx`; then point --llm at the served endpoint.",
    recommended: true,
  },
  {
    id: "defiant-fable",
    repo: "DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF",
    paramsb: 9,
    activeb: 0,
    family: "Qwen3.5-9B",
    why: "Small enough for a consumer GPU; strong refusal-unrolled reasoning for SOC/social-persona and report workflows.",
    quant: "Q4_K_M",
    overhead_gb: 1.2,
    min_imem_gb: 8,
    min_imem_note: "Runs on 8 GB class GPUs (Q4_K_M ≈ 6.5 GB weights + KV).",
    license: "see model card",
    notes: "Unsloth-managed: `ohqs models install defiant-fable`.",
    recommended: true,
  },
  {
    id: "qwen3-8b-instruct",
    repo: "unsloth/Qwen3-8B-Instruct-GGUF",
    paramsb: 8,
    activeb: 0,
    family: "Qwen3-8B",
    why: "Apache-2.0, balanced instruct model for plan drafting, tool selection, and finding write-up help.",
    quant: "Q4_K_M",
    overhead_gb: 0.9,
    min_imem_gb: 8,
    license: "Apache-2.0 (Qwen3 base varies)",
    notes: "Good default when the tuned personas are too niche.",
    recommended: false,
  },
  {
    id: "qwen25-coder-7b",
    repo: "unsloth/Qwen2.5-Coder-7B-Instruct-GGUF",
    paramsb: 7,
    activeb: 0,
    family: "Qwen2.5-Coder-7B",
    why: "Code reasoning for attack-surface review and reproducing a specific class of bug from the catalog.",
    quant: "Q4_K_M",
    overhead_gb: 0.8,
    min_imem_gb: 8,
    license: "Apache-2.0 (Qwen2.5 base)",
    notes: "Pairs well with ffuf/nuclei/template steps in a playbook.",
    recommended: false,
  },
  {
    id: "qwen3-14b-instruct",
    repo: "unsloth/Qwen3-14B-Instruct-GGUF",
    paramsb: 14,
    activeb: 0,
    family: "Qwen3-14B",
    why: "Step up in reasoning for a 12 GB+ card; better instruction adherence for longer playbooks.",
    quant: "Q4_K_M",
    overhead_gb: 1.2,
    min_imem_gb: 12,
    license: "Apache-2.0 (Qwen3 base varies)",
    notes: "Requires 12 GB+ GPU (Q4_K_M ≈ 10.5 GB).",
    recommended: false,
  },
];

const quants = [
  { name: "Q4_K_M", bytesPerParam: 0.6 },
  { name: "Q5_K_M", bytesPerParam: 0.73 },
  { name: "Q6_K", bytesPerParam: 0.86 },
  { name: "Q8_0", bytesPerParam: 1.1 },
];

function activeLabel(m: Model): string {
  return (m.activeb > 0 ? m.activeb : m.paramsb).toString() + "B";
}

function requiredGB(m: Model, quant: string): number {
  let bpp = 0.6;
  for (const q of quants) {
    if (q.name.toLowerCase() === quant.toLowerCase()) {
      bpp = q.bytesPerParam;
      break;
    }
  }
  return m.paramsb * bpp + (m.overhead_gb > 0 ? m.overhead_gb : 0.8);
}

function bestFit(avail: number, m: Model): Fit {
  const best: Fit = { model: m, available: avail, requiredgb: requiredGB(m, m.quant), quant: m.quant, fits: false, shortgb: 0 };
  if (best.requiredgb <= avail) {
    best.fits = true;
    return best;
  }
  for (const q of quants) {
    if (q.name === best.quant) continue;
    const req = requiredGB(m, q.name);
    if (req <= avail) {
      return { model: m, quant: q.name, requiredgb: req, available: avail, fits: true, shortgb: 0 };
    }
  }
  best.shortgb = best.requiredgb - avail;
  return best;
}

export function availableGB(h: HostInfo): number {
  if (h.vramgb > 0) return h.vramgb;
  if (h.ramgb > 0) return h.ramgb * 0.8;
  return 8;
}

// Recommend mirrors models.Recommend: fits first by params, then non-fits by
// smallest shortfall.
export function recommend(h: HostInfo, limit: number): Recommendation[] {
  const avail = availableGB(h);
  const out: Recommendation[] = DefaultModels.map((m) => {
    const f = bestFit(avail, m);
    return { ...f, score: f.fits ? f.model.paramsb : -f.shortgb };
  });
  out.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    return b.score - a.score;
  });
  return out.slice(0, limit > 0 ? limit : out.length);
}

export { activeLabel };