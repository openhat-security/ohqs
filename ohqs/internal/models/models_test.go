package models

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestByID(t *testing.T) {
	for _, id := range []string{"ravenx", "RAVENX", "defiant-fable", "qwen3-8b-instruct"} {
		if _, ok := ByID(id); !ok {
			t.Fatalf("ByID(%q) not found", id)
		}
	}
	if _, ok := ByID("deadbydawn101/RavenX-CyberAgent-Qwen3.6-35B-A3B-Opus-4.7-OpenMythos-Pentester-BugHunter-RATH-GGUF"); !ok {
		t.Fatal("ByID(repo) should resolve ravenx")
	}
	if _, ok := ByID("nope"); ok {
		t.Fatal("ByID unknown should be false")
	}
}

func TestRequiredGB(t *testing.T) {
	m, _ := ByID("ravenx")
	req := RequiredGB(m, "Q4_K_M")
	want := 35*0.60 + 2.0
	if math.Abs(req-want) > 1e-6 {
		t.Fatalf("ravenx Q4 required=%v want=%v", req, want)
	}
	m9, _ := ByID("defiant-fable")
	if req := RequiredGB(m9, "Q4_K_M"); req <= 5 || req > 10 {
		t.Fatalf("defiant-fable Q4 required out of range: %v", req)
	}
}

func TestBestFitAndRecommend(t *testing.T) {
	big := HostInfo{RAMGB: 64, VRAMGB: 0, Label: "ram"}
	small := HostInfo{RAMGB: 8, VRAMGB: 0, Label: "ram"}

	recs := Recommend(big, 0)
	if !recs[0].Fits || recs[0].Model.ParamsB < 30 {
		t.Fatalf("big host should fit ravenx first: %+v", recs[0])
	}
	if len(recs) != len(DefaultModels) {
		t.Fatalf("recommend count=%d want %d", len(recs), len(DefaultModels))
	}
	recs = Recommend(small, 0)
	if recs[0].Model.ID == "ravenx" {
		t.Fatalf("8 GB host should not rank ravenx first: %+v", recs[0])
	}
	if !BestFit(small, must(t, "ravenx")).Fits {
		// small host cannot fit ravenx; a smaller model should fit
		if !BestFit(small, must(t, "qwen25-coder-7b")).Fits {
			t.Fatalf("8 GB host should fit qwen25-coder-7b: %+v", BestFit(small, must(t, "qwen25-coder-7b")))
		}
	}
	// A 48 GB discrete GPU should fit the 35B default Q4.
	gpu := HostInfo{RAMGB: 64, VRAMGB: 48, Label: "NVIDIA VRAM"}
	if !BestFit(gpu, must(t, "ravenx")).Fits {
		t.Fatal("48 GB VRAM should fit ravenx Q4_K_M")
	}
	if BestFit(HostInfo{RAMGB: 12, VRAMGB: 0}, must(t, "ravenx")).Fits {
		t.Fatal("12 GB RAM should not fit ravenx")
	}
}

func must(t *testing.T, id string) Model {
	t.Helper()
	m, ok := ByID(id)
	if !ok {
		t.Fatalf("model %s missing", id)
	}
	return m
}

func TestFitLabel(t *testing.T) {
	f := BestFit(HostInfo{RAMGB: 64, VRAMGB: 0}, must(t, "defiant-fable"))
	if !f.Fits || f.LabelFor() == "" {
		t.Fatalf("label: %+v", f.LabelFor())
	}
}

func TestDetectSanity(t *testing.T) {
	h := Detect()
	if h.RAMGB <= 0 {
		t.Fatal("expected positive RAM")
	}
	if h.Label == "" {
		t.Fatal("expected a label")
	}
}

func TestPickGGUF(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "model-Q4_K_M.gguf")
	writeFile(t, dir, "model-Q8_0.gguf")
	got, err := pickGGUF(dir, "Q4_K_M")
	if err != nil {
		t.Fatal(err)
	}
	if got != dir+"/model-Q4_K_M.gguf" {
		t.Fatalf("wanted Q4 file, got %s", got)
	}
	if _, err := pickGGUF(t.TempDir(), "Q4_K_M"); err == nil {
		t.Fatal("expected error for empty dir")
	}
}

func writeFile(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}
