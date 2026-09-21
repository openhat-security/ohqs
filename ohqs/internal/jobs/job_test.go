package jobs

import (
	"os"
	"testing"

	"github.com/openhat/quick-start/internal/planner"
)

func TestCommandsFromPlanSkipsComments(t *testing.T) {
	p := &planner.Plan{
		Steps: []planner.PlanStep{
			{N: 2, Title: "Prereqs", Commands: []string{"# Semgrep: pipx install semgrep", "ohqs browser"}},
		},
	}
	cmds := CommandsFromPlan(p)
	if cmds[0].Skip == "" {
		t.Fatal("comment should skip")
	}
	if cmds[1].Skip != "" {
		t.Fatal("ohqs browser should run")
	}
}

func TestParentOutDirs(t *testing.T) {
	dirs := parentOutDirs("gitleaks detect --source . --report-path evidence/gitleaks.json --report-format json")
	if len(dirs) != 1 || dirs[0] != "evidence" {
		t.Fatalf("dirs %v", dirs)
	}
}

func TestCommandsFromPlanSkipsInteractive(t *testing.T) {
	p := &planner.Plan{
		Steps: []planner.PlanStep{
			{N: 3, Title: "Probe", Commands: []string{"httpx -l live.txt", "zap.sh"}},
		},
	}
	cmds := CommandsFromPlan(p)
	if len(cmds) != 2 {
		t.Fatalf("len %d", len(cmds))
	}
	if cmds[0].Skip != "" {
		t.Fatal("httpx should run")
	}
	if cmds[1].Skip == "" {
		t.Fatal("zap.sh should be skipped")
	}
}

func TestReconcileLeavesQueued(t *testing.T) {
	dir := t.TempDir()
	s := Open(dir, dir)
	m := &Meta{ID: "x", Status: StatusQueued}
	if err := osMkdir(s, m); err != nil {
		t.Fatal(err)
	}
	s.Reconcile(m)
	if m.Status != StatusQueued {
		t.Fatalf("status %s", m.Status)
	}
}

func osMkdir(s *Store, m *Meta) error {
	if err := os.MkdirAll(s.path(m.ID), 0o755); err != nil {
		return err
	}
	return s.save(m)
}
