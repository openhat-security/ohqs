package llm

import (
	"strings"
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/planner"
)

func TestExtractJSON(t *testing.T) {
	got := extractJSON("Sure.\n```json\n{\"steps\":[{\"n\":1,\"title\":\"Scope\"}]}\n```\n")
	if !strings.Contains(got, `"title":"Scope"`) {
		t.Fatalf("extractJSON: %s", got)
	}
}

func TestParseDraft(t *testing.T) {
	d, err := parseDraft(`{"goal":"g","scope":"s","steps":[{"n":1,"title":"Lock scope","purpose":"RoE","tool_ids":["gitleaks"]}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if d.Steps[0].Title != "Lock scope" || d.Steps[0].ToolIDs[0] != "gitleaks" {
		t.Fatalf("%+v", d)
	}
}

func TestHydrateUnknownToolsDropped(t *testing.T) {
	root, err := catalog.FindRoot("../../..")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	d := &draftPlan{
		Goal:  "test",
		Scope: "example.com",
		Steps: []draftStep{{N: 1, Title: "Secrets", ToolIDs: []string{"gitleaks", "not-a-real-tool"}}},
	}
	plan := hydrate(cat, planner.Request{Situation: "secrets in a repo", Scope: "example.com", Authorized: true}, d)
	if len(plan.Steps) != 1 || len(plan.Steps[0].Tools) != 1 || plan.Steps[0].Tools[0].ID != "gitleaks" {
		t.Fatalf("tools: %+v", plan.Steps[0].Tools)
	}
}

func TestResolveDefaults(t *testing.T) {
	t.Setenv("OHQS_OPENAI_BASE_URL", "")
	t.Setenv("OHQS_OPENAI_API_KEY", "")
	t.Setenv("OHQS_OPENAI_MODEL", "")
	t.Setenv("OPENAI_API_KEY", "")
	c := Resolve("", "sk-test", "")
	if c.BaseURL != DefaultOpenAIBase || c.Model != DefaultModel || !c.Ready() {
		t.Fatalf("%+v", c)
	}
	_, _, keySet := c.Redacted()
	if !keySet {
		t.Fatal("expected key set")
	}
}

func TestResolveModelOptional(t *testing.T) {
	t.Setenv("OHQS_OPENAI_BASE_URL", "")
	t.Setenv("OHQS_OPENAI_API_KEY", "")
	t.Setenv("OHQS_OPENAI_MODEL", "")
	t.Setenv("OPENAI_API_KEY", "")

	// Local single-model endpoint (Unsloth/vLLM/llama.cpp): URL + key is enough,
	// model stays empty so it is omitted from the request body.
	local := ResolveWith(Config{}, "http://127.0.0.1:8000/v1", "sk-local", "")
	if local.Model != "" {
		t.Fatalf("expected empty model for local endpoint, got %q", local.Model)
	}
	if !local.Ready() {
		t.Fatal("expected local endpoint to be ready")
	}

	// Hosted OpenAI requires a model, so it is still defaulted.
	hosted := ResolveWith(Config{}, "https://api.openai.com/v1", "sk", "")
	if hosted.Model != DefaultModel {
		t.Fatalf("expected %s for OpenAI, got %q", DefaultModel, hosted.Model)
	}
}
