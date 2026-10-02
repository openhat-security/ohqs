package planner

import (
	"context"
	"fmt"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/index"
	"github.com/openhat/quick-start/internal/retrieve"
)

type Request struct {
	Situation  string `json:"situation"`
	Scope      string `json:"scope"`
	Authorized bool   `json:"authorized"`
	Target     string `json:"target"`
	Path       string `json:"path"`
	Wordlist   string `json:"wordlist"`
	UseLLM     bool   `json:"use_llm,omitempty"`
}

type PlanStep struct {
	N        int              `json:"n"`
	Title    string           `json:"title"`
	Purpose  string           `json:"purpose"`
	Tools    []catalog.Record `json:"tools"`
	How      string           `json:"how"`
	LookFor  string           `json:"look_for"`
	Next     string           `json:"next"`
	Commands []string         `json:"commands"`
	Links    []Link           `json:"links,omitempty"`
}

type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
	Note  string `json:"note,omitempty"`
}

type Plan struct {
	Goal          string           `json:"goal"`
	Scope         string           `json:"scope"`
	Playbook      string           `json:"playbook"`
	PlaybookTitle string           `json:"playbook_title"`
	Tools         []catalog.Record `json:"tools"`
	Steps         []PlanStep       `json:"steps"`
	Checklist     []string         `json:"checklist"`
}

const defaultScope = "OpenHat research lab"

func Build(cat *catalog.Catalog, store *index.Store, req Request) (*Plan, error) {
	if strings.TrimSpace(req.Situation) == "" {
		return nil, fmt.Errorf("--situation is required")
	}
	scope := strings.TrimSpace(req.Scope)
	if scope == "" {
		scope = defaultScope
	}
	pb := retrieve.Playbook(cat, req.Situation)
	tools, _ := retrieve.SituationRanked(context.Background(), cat, store, req.Situation, 18)
	byID := map[string]catalog.Record{}
	for _, t := range tools {
		byID[t.ID] = t
	}
	subs := map[string]string{
		"{{url}}":        or(req.Target, "{{url}}"),
		"{{target}}":     or(req.Target, "{{target}}"),
		"{{domain}}":     or(req.Target, "{{domain}}"),
		"{{path}}":       or(req.Path, "."),
		"{{wordlist}}":   or(req.Wordlist, "third-party-resources/guides/SecLists/Discovery/Web-Content/common.txt"),
		"{{live_hosts}}": "live.txt",
		"{{hosts}}":      "subs.txt",
		"{{token}}":      "{{token}}",
	}

	plan := &Plan{
		Goal:          req.Situation,
		Scope:         scope,
		Playbook:      pb.ID,
		PlaybookTitle: pb.Title,
		Tools:         tools,
		Checklist: []string{
			"Execute full exploitation chain per playbook (recon → param discovery → injection → RCE → data exfil)",
			"OWASP access control / IDOR on all CRUD endpoints; test with multiple roles",
			"Secrets in repo, JS, env files, and runtime configs",
			"Injection (SQLi, OS cmd, XSS) on every parameter; use weaponized tools for verification",
			"LLM features: prompt injection, leakage, unsafe output rendering",
			"Write findings with proof-of-concept code, request/response samples, and remediation",
		},
	}

	n := 1
	if pre := prereqStep(cat, pb, n); pre != nil {
		plan.Steps = append(plan.Steps, *pre)
		n++
	}

	for _, st := range pb.Steps {
		var recs []catalog.Record
		var cmds []string
		var hows, looks []string
		for _, id := range st.ToolIDs {
			rec, ok := cat.ByID[id]
			if !ok {
				if r2, ok2 := byID[id]; ok2 {
					rec = r2
					ok = true
				}
			}
			if !ok {
				continue
			}
			recs = append(recs, rec)
			for _, c := range rec.Commands {
				cmds = append(cmds, expand(c, subs))
			}
			if rec.How != "" {
				hows = append(hows, rec.Name+": "+rec.How)
			}
			if rec.LookFor != "" {
				looks = append(looks, rec.Name+": "+rec.LookFor)
			}
		}
		how := st.Purpose
		if len(hows) > 0 {
			how = strings.Join(hows, "\n")
		}
		look := "Notes in the playbook step and each tool's look_for."
		if len(looks) > 0 {
			look = strings.Join(looks, "\n")
		}
		next := "If you have a finding: save request/response or scanner JSON and note it. If not: continue."
		plan.Steps = append(plan.Steps, PlanStep{
			N:        n,
			Title:    st.Title,
			Purpose:  st.Purpose,
			Tools:    recs,
			How:      how,
			LookFor:  look,
			Next:     next,
			Commands: cmds,
		})
		n++
	}
	return plan, nil
}

func prereqStep(cat *catalog.Catalog, pb catalog.Playbook, n int) *PlanStep {
	seen := map[string]bool{}
	var recs []catalog.Record
	var links []Link
	var cmds []string
	for _, st := range pb.Steps {
		for _, id := range st.ToolIDs {
			if seen[id] {
				continue
			}
			rec, ok := cat.ByID[id]
			if !ok {
				continue
			}
			manual := rec.Kind == "extension" || rec.Build == "manual"
			if !manual {
				continue
			}
			seen[id] = true
			recs = append(recs, rec)
			note := rec.Install
			if rec.Kind == "extension" {
				note = "Pre-installed in the OHQS test browser (ohqs browser)."
			}
			if rec.StoreFirefox != "" {
				links = append(links, Link{Label: rec.Name + " (Firefox)", URL: rec.StoreFirefox, Note: note})
			}
			if rec.StoreChromium != "" {
				links = append(links, Link{Label: rec.Name + " (Chrome/Brave/Edge)", URL: rec.StoreChromium, Note: note})
			}
			if rec.StoreFirefox == "" && rec.StoreChromium == "" && rec.Homepage != "" {
				links = append(links, Link{Label: rec.Name, URL: rec.Homepage, Note: note})
			}
			if rec.Kind != "extension" && rec.Install != "" {
				cmds = append(cmds, "# "+rec.Name+": "+rec.Install)
			}
		}
	}
	if len(recs) == 0 {
		return nil
	}
	cmds = append([]string{"ohqs browser"}, cmds...)
	return &PlanStep{
		N:        n,
		Title:    "Workstation prereqs (browser + manual tools)",
		Purpose:  "Open the isolated OHQS test browser with extensions already installed.",
		Tools:    recs,
		How:      "Run ohqs browser. It downloads a private Firefox (OHQS Browser) once, force-installs AMO extensions, and opens a sandbox profile. pipx/npm/ZAP stay copy-paste. Daily Firefox/Chrome is not touched.",
		LookFor:  "FoxyProxy, PwnFox, and Cookie-Editor are already in the sandbox. Daily browsing stays clean.",
		Next:     "Use that window for proxy/auth steps.",
		Commands: cmds,
		Links:    links,
	}
}

func Markdown(p *Plan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Engagement plan\n\n")
	fmt.Fprintf(&b, "**Playbook:** %s (%s)\n\n", p.PlaybookTitle, p.Playbook)
	fmt.Fprintf(&b, "**Goal:** %s\n\n", p.Goal)
	fmt.Fprintf(&b, "**Scope:** %s\n\n", p.Scope)
	fmt.Fprintf(&b, "## Toolkit\n\n")
	for _, t := range p.Tools {
		fmt.Fprintf(&b, "- **%s** (`%s`, %s) — %s\n", t.Name, t.ID, t.Kind, t.Summary)
	}
	fmt.Fprintf(&b, "\n## Steps\n\n")
	for _, s := range p.Steps {
		fmt.Fprintf(&b, "### %d. %s\n\n", s.N, s.Title)
		fmt.Fprintf(&b, "**Purpose:** %s\n\n", s.Purpose)
		if len(s.Tools) > 0 {
			fmt.Fprintf(&b, "**Tools:** ")
			var names []string
			for _, t := range s.Tools {
				names = append(names, t.Name)
			}
			fmt.Fprintf(&b, "%s\n\n", strings.Join(names, ", "))
		}
		if s.How != "" {
			fmt.Fprintf(&b, "**How:**\n\n%s\n\n", s.How)
		}
		if len(s.Links) > 0 {
			fmt.Fprintf(&b, "**Install / store links:**\n\n")
			for _, l := range s.Links {
				fmt.Fprintf(&b, "- [%s](%s)", l.Label, l.URL)
				if l.Note != "" {
					fmt.Fprintf(&b, " — %s", l.Note)
				}
				b.WriteString("\n")
			}
			b.WriteString("\n")
		}
		if len(s.Commands) > 0 {
			fmt.Fprintf(&b, "**Commands:**\n\n")
			for _, c := range s.Commands {
				fmt.Fprintf(&b, "```bash\n%s\n```\n\n", c)
			}
		}
		if s.LookFor != "" {
			fmt.Fprintf(&b, "**What to look for:**\n\n%s\n\n", s.LookFor)
		}
		if s.Next != "" {
			fmt.Fprintf(&b, "**Next:** %s\n\n", s.Next)
		}
	}
	fmt.Fprintf(&b, "## Coverage checklist\n\n")
	for _, c := range p.Checklist {
		fmt.Fprintf(&b, "- [ ] %s\n", c)
	}
	fmt.Fprintf(&b, "\n---\nOpenHat Quick Start — open-source offensive security research catalog.\n")
	return b.String()
}

func expand(cmd string, subs map[string]string) string {
	for k, v := range subs {
		cmd = strings.ReplaceAll(cmd, k, v)
	}
	return cmd
}

func or(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
