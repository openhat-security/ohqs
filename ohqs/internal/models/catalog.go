package models

import "strings"

// Recommended GGUF models for the local reasoning/agent step of an authorized
// engagement. These are suggestions only: the operator still runs any LLM they
// have written authorization to use, and is responsible for the model license.
// VRAM figures are rough GGUF estimates, not guarantees.
//
// The first two (ravenx, defiant-fable) are the open red-team/security personas
// explicitly recommended by the project. The rest are well-known quantized
// general/code instruct models that make good local "advisor + code reviewer"
// fits when a tuned persona is not installed.
var DefaultModels = []Model{
	{
		ID:          "ravenx",
		Repo:        "deadbydawn101/RavenX-CyberAgent-Qwen3.6-35B-A3B-Opus-4.7-OpenMythos-Pentester-BugHunter-RATH-GGUF",
		ParamsB:     35,
		ActiveB:     3,
		Family:      "Qwen3.6-35B-A3B MoE",
		Why:         "Large MoE-safe agentic persona custom-trained for pentest/bug-hunt triage. Needs a serious GPU.",
		Quant:       "Q4_K_M",
		OverheadGB:  2.0,
		MinIMemGB:   24,
		MinIMemNote: "24 GB VRAM recommended (Q4_K_M ≈ 22 GB weights + 2 GB KV/overhead).",
		License:     "see model card",
		Notes:       "Unsloth-managed: `ohqs models install ravenx`; then point --llm at the served endpoint.",
		Recommended: true,
	},
	{
		ID:          "defiant-fable",
		Repo:        "DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF",
		ParamsB:     9,
		Family:      "Qwen3.5-9B",
		Why:         "Small enough for a consumer GPU; strong refusal-unrolled reasoning for SOC/social-persona and report workflows.",
		Quant:       "Q4_K_M",
		OverheadGB:  1.2,
		MinIMemGB:   8,
		MinIMemNote: "Runs on 8 GB class GPUs (Q4_K_M ≈ 6.5 GB weights + KV).",
		License:     "see model card",
		Notes:       "Unsloth-managed: `ohqs models install defiant-fable`.",
		Recommended: true,
	},
	{
		ID:         "qwen3-8b-instruct",
		Repo:       "unsloth/Qwen3-8B-Instruct-GGUF",
		ParamsB:    8,
		Family:     "Qwen3-8B",
		Why:        "Apache-2.0, balanced instruct model for plan drafting, tool selection, and finding write-up help.",
		Quant:      "Q4_K_M",
		OverheadGB: 0.9,
		MinIMemGB:  8,
		License:    "Apache-2.0 (Qwen3 base varies)",
		Notes:      "Good default when the tuned personas are too niche.",
	},
	{
		ID:         "qwen25-coder-7b",
		Repo:       "unsloth/Qwen2.5-Coder-7B-Instruct-GGUF",
		ParamsB:    7,
		Family:     "Qwen2.5-Coder-7B",
		Why:        "Code reasoning for attack-surface review and reproducing a specific class of bug from the catalog.",
		Quant:      "Q4_K_M",
		OverheadGB: 0.8,
		MinIMemGB:  8,
		License:    "Apache-2.0 (Qwen2.5 base)",
		Notes:      "Pairs well with ffuf/nuclei/template steps in a playbook.",
	},
	{
		ID:         "qwen3-14b-instruct",
		Repo:       "unsloth/Qwen3-14B-Instruct-GGUF",
		ParamsB:    14,
		Family:     "Qwen3-14B",
		Why:        "Step up in reasoning for a 12 GB+ card; better instruction adherence for longer playbooks.",
		Quant:      "Q4_K_M",
		OverheadGB: 1.2,
		MinIMemGB:  12,
		License:    "Apache-2.0 (Qwen3 base varies)",
		Notes:      "Requires 12 GB+ GPU (Q4_K_M ≈ 10.5 GB).",
	},
}

// ByID resolves a model by slug or full HF repo id (case-insensitive).
func ByID(id string) (Model, bool) {
	want := strings.ToLower(strings.TrimSpace(id))
	for _, m := range DefaultModels {
		if strings.ToLower(strings.TrimSpace(m.ID)) == want || strings.ToLower(strings.TrimSpace(m.Repo)) == want {
			return m, true
		}
	}
	return Model{}, false
}
