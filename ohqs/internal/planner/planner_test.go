package planner

import (
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
)

func TestBuildRequiresAuth(t *testing.T) {
	root, err := catalog.FindRoot("../..")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Build(cat, nil, Request{Situation: "x", Scope: "y", Authorized: false})
	if err == nil {
		t.Fatal("expected auth error")
	}
	plan, err := Build(cat, nil, Request{
		Situation:  "vibe-coded Next.js chat app",
		Scope:      "example.com in scope",
		Authorized: true,
		Target:     "https://www.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Playbook != "ai-slop-web" {
		t.Fatalf("playbook %s", plan.Playbook)
	}
	if len(plan.Steps) < 3 {
		t.Fatalf("steps %d", len(plan.Steps))
	}
	var pre *PlanStep
	for i := range plan.Steps {
		if plan.Steps[i].Title == "Workstation prereqs (browser + manual tools)" {
			pre = &plan.Steps[i]
			break
		}
	}
	if pre == nil || len(pre.Links) == 0 {
		t.Fatal("expected prereq links")
	}
}

func TestBuildNextjsClerkPlaybook(t *testing.T) {
	root, err := catalog.FindRoot("../..")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := Build(cat, nil, Request{
		Situation:  "vibe-coded Next.js app with Clerk authentication for client rebuild assessment",
		Scope:      "app.example.com and repo per SOW",
		Authorized: true,
		Target:     "https://app.example.com",
		Path:       ".",
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Playbook != "nextjs-clerk" {
		t.Fatalf("playbook %s", plan.Playbook)
	}
	var hasMiddleware bool
	for _, s := range plan.Steps {
		if s.Title == "Middleware and route protection audit" {
			hasMiddleware = true
		}
	}
	if !hasMiddleware {
		t.Fatal("expected middleware step")
	}
}
