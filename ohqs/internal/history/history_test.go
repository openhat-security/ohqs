package history

import (
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/planner"
)

func TestAddListGet(t *testing.T) {
	s := Open(t.TempDir())
	req := planner.Request{Situation: "vibe app", Scope: "example.com", Authorized: true, Target: "https://ex.test"}
	plan := &planner.Plan{
		Goal: req.Situation, Scope: req.Scope, Playbook: "ai-slop-web", PlaybookTitle: "AI slop",
		Steps: []planner.PlanStep{{N: 1, Title: "Scope", Tools: []catalog.Record{{ID: "gitleaks", Name: "Gitleaks"}}}},
	}
	e, err := s.Add(SourceCLI, req, plan)
	if err != nil {
		t.Fatal(err)
	}
	if e.Source != SourceCLI || e.Playbook != "ai-slop-web" {
		t.Fatalf("%+v", e)
	}
	got, err := s.Get(e.ID)
	if err != nil || got.Target != "https://ex.test" {
		t.Fatalf("get %v %+v", err, got)
	}
	list := s.List(10)
	if len(list) != 1 || list[0].ID != e.ID {
		t.Fatalf("list %+v", list)
	}
}
