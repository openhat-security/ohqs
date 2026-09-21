package deps

import (
	"runtime"
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/planner"
)

func TestBinName(t *testing.T) {
	if g := BinName(catalog.Record{ID: "gitleaks", Commands: []string{"gitleaks detect --source ."}}); g != "gitleaks" {
		t.Fatalf("got %s", g)
	}
	if g := BinName(catalog.Record{ID: "sqlmap", Commands: []string{"python sqlmap.py -u {{url}}"}}); g != "sqlmap" {
		t.Fatalf("sqlmap got %s", g)
	}
	if g := BinName(catalog.Record{ID: "seclists", Kind: "guide", Build: "data"}); g != "" {
		t.Fatalf("guide bin %q", g)
	}
}

func TestGitURL(t *testing.T) {
	u := GitURL("https://github.com/projectdiscovery/httpx")
	if u != "https://github.com/projectdiscovery/httpx.git" {
		t.Fatalf("%s", u)
	}
	if GitURL("https://nmap.org/") != "" {
		t.Fatal("nmap should not be a git url")
	}
}

func TestNeededUsesStepsNotToolkit(t *testing.T) {
	cat := &catalog.Catalog{ByID: map[string]catalog.Record{
		"seclists": {ID: "seclists", Name: "SecLists", Kind: "guide"},
	}}
	plan := &planner.Plan{
		Tools: []catalog.Record{{ID: "wpscan", Name: "WPScan"}},
		Steps: []planner.PlanStep{
			{Tools: []catalog.Record{{ID: "gitleaks", Name: "Gitleaks"}}, Commands: []string{`ffuf -w third-party-resources/guides/SecLists/Discovery/Web-Content/common.txt`}},
		},
	}
	got := Needed(cat, plan)
	ids := map[string]bool{}
	for _, r := range got {
		ids[r.ID] = true
	}
	if !ids["gitleaks"] || !ids["seclists"] {
		t.Fatalf("needed %+v", ids)
	}
	if ids["wpscan"] {
		t.Fatal("toolkit-only tool should not be needed")
	}
}

func TestHostName(t *testing.T) {
	h := Detect(".")
	if h.GOOS != runtime.GOOS {
		t.Fatalf("goos %s", h.GOOS)
	}
	if h.Name == "" {
		t.Fatal("empty name")
	}
}

func TestSupported(t *testing.T) {
	h := Host{GOOS: "darwin"}
	if !h.Supported(nil) {
		t.Fatal("empty platforms")
	}
	if h.Supported([]string{"windows"}) {
		t.Fatal("windows-only on darwin")
	}
}
