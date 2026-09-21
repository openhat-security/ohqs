package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/index"
	"github.com/openhat/quick-start/internal/planner"
	"github.com/openhat/quick-start/internal/retrieve"
)

const systemPrompt = `You write authorized security-engagement playbooks for OpenHat Quick Start (ohqs).

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
}`

type draftPlan struct {
	Goal          string      `json:"goal"`
	Scope         string      `json:"scope"`
	Playbook      string      `json:"playbook"`
	PlaybookTitle string      `json:"playbook_title"`
	Checklist     []string    `json:"checklist"`
	Steps         []draftStep `json:"steps"`
}

type draftStep struct {
	N        int      `json:"n"`
	Title    string   `json:"title"`
	Purpose  string   `json:"purpose"`
	ToolIDs  []string `json:"tool_ids"`
	How      string   `json:"how"`
	LookFor  string   `json:"look_for"`
	Next     string   `json:"next"`
	Commands []string `json:"commands"`
}

// Build uses the LLM when req.UseLLM is set; otherwise the template planner.
// On LLM failure it falls back to the template planner and reports the reason via warn.
func Build(cat *catalog.Catalog, store *index.Store, req planner.Request, cfg Config, warn func(string)) (*planner.Plan, error) {
	if !req.UseLLM {
		return planner.Build(cat, store, req)
	}
	plan, err := Recommend(cat, store, req, cfg)
	if err == nil {
		return plan, nil
	}
	fallback, ferr := planner.Build(cat, store, req)
	if ferr != nil {
		return nil, fmt.Errorf("LLM plan failed (%v); template planner also failed: %w", err, ferr)
	}
	if warn != nil {
		warn(fmt.Sprintf("LLM plan failed (%v); using template playbook. Serve a local model with Unsloth: %s", err, UnslothRepo))
	}
	return fallback, nil
}

func Recommend(cat *catalog.Catalog, store *index.Store, req planner.Request, cfg Config) (*planner.Plan, error) {
	if !req.Authorized {
		return nil, fmt.Errorf("refusing to plan: pass --authorized and a written --scope for work you are allowed to do")
	}
	if strings.TrimSpace(req.Scope) == "" {
		return nil, fmt.Errorf("refusing to plan: --scope is required (program, hosts, out-of-scope)")
	}
	if strings.TrimSpace(req.Situation) == "" {
		return nil, fmt.Errorf("--situation is required")
	}
	content, err := cfg.Chat(systemPrompt, userPrompt(cat, store, req))
	if err != nil {
		return nil, err
	}
	draft, err := parseDraft(content)
	if err != nil {
		return nil, err
	}
	return hydrate(cat, req, draft), nil
}

func userPrompt(cat *catalog.Catalog, store *index.Store, req planner.Request) string {
	pb := retrieve.Playbook(cat, req.Situation)
	tools, _ := retrieve.SituationRanked(context.Background(), cat, store, req.Situation, 18)
	var b strings.Builder
	fmt.Fprintf(&b, "Situation: %s\n", req.Situation)
	fmt.Fprintf(&b, "Scope: %s\n", req.Scope)
	if req.Target != "" {
		fmt.Fprintf(&b, "Target: %s\n", req.Target)
	}
	if req.Path != "" {
		fmt.Fprintf(&b, "Local path: %s\n", req.Path)
	}
	fmt.Fprintf(&b, "\nMatched playbook: %s (%s)\n", pb.Title, pb.ID)
	for _, st := range pb.Steps {
		fmt.Fprintf(&b, "- %s: %s (tools: %s)\n", st.Title, st.Purpose, strings.Join(st.ToolIDs, ", "))
	}
	fmt.Fprintf(&b, "\nCatalog tools to prefer:\n")
	for _, t := range tools {
		fmt.Fprintf(&b, "- %s (%s, %s): %s\n", t.ID, t.Name, t.Kind, t.Summary)
	}
	b.WriteString("\nWrite the JSON plan now.")
	return b.String()
}

func parseDraft(content string) (*draftPlan, error) {
	raw := extractJSON(content)
	if raw == "" {
		return nil, fmt.Errorf("LLM reply had no JSON object")
	}
	var d draftPlan
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		return nil, fmt.Errorf("LLM JSON: %w", err)
	}
	if len(d.Steps) == 0 {
		return nil, fmt.Errorf("LLM plan had no steps")
	}
	return &d, nil
}

func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```JSON")
		s = strings.TrimPrefix(s, "```")
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return ""
	}
	return s[start : end+1]
}

func hydrate(cat *catalog.Catalog, req planner.Request, d *draftPlan) *planner.Plan {
	pb := retrieve.Playbook(cat, req.Situation)
	plan := &planner.Plan{
		Goal:          or(d.Goal, req.Situation),
		Scope:         or(d.Scope, req.Scope),
		Playbook:      or(d.Playbook, pb.ID),
		PlaybookTitle: or(d.PlaybookTitle, pb.Title+" (LLM)"),
		Checklist:     d.Checklist,
	}
	if len(plan.Checklist) == 0 {
		plan.Checklist = []string{
			"Stay inside the stated scope and program rules",
			"Write findings with evidence and a fix",
		}
	}
	seen := map[string]bool{}
	for i, st := range d.Steps {
		n := st.N
		if n == 0 {
			n = i + 1
		}
		var recs []catalog.Record
		for _, id := range st.ToolIDs {
			rec, ok := cat.ByID[id]
			if !ok {
				continue
			}
			recs = append(recs, rec)
			if !seen[rec.ID] {
				plan.Tools = append(plan.Tools, rec)
				seen[rec.ID] = true
			}
		}
		plan.Steps = append(plan.Steps, planner.PlanStep{
			N:        n,
			Title:    or(st.Title, fmt.Sprintf("Step %d", n)),
			Purpose:  st.Purpose,
			Tools:    recs,
			How:      st.How,
			LookFor:  st.LookFor,
			Next:     st.Next,
			Commands: st.Commands,
		})
	}
	return plan
}

func or(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
