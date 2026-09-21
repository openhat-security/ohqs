package index

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
)

// fakeEmbedder returns a fixed vocabulary-style embedder: text → sparse 2-hot
// vector built from token ASCII sums. Deterministic and offline.
type fakeEmbedder struct{}

func (fakeEmbedder) Label() string { return "fake-test-embedder (offline)" }

func (fakeEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	dim := 32
	out := make([][]float32, len(texts))
	for i, t := range texts {
		v := make([]float32, dim)
		for j := 0; j < len(t) && j < len(v); j++ {
			v[int(t[j])%dim]++
		}
		if len(v) == 0 {
			v = append(v, 0)
		}
		out[i] = v
	}
	return out, nil
}

func writeTestCatalog(t *testing.T, rows []catalog.Record) string {
	t.Helper()
	dir := t.TempDir()
	cat := filepath.Join(dir, "catalog")
	if err := os.MkdirAll(filepath.Join(cat, "playbooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	var y string
	y += "items:\n"
	for _, r := range rows {
		y += "  - id: " + r.ID + "\n"
		y += "    name: " + r.Name + "\n"
		y += "    kind: tool\n"
		y += "    summary: " + r.Summary + "\n"
		y += "    tags: [" + csvJoin(r.Tags) + "]\n"
		y += "    when_to_use: " + r.WhenToUse + "\n"
	}
	if err := os.WriteFile(filepath.Join(cat, "tools.yaml"), []byte(y), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cat, "extensions.yaml"), []byte("items: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cat, "guides.yaml"), []byte("items: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cat, "os.yaml"), []byte("items: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cat, "platforms.yaml"), []byte("items: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cat, "references.yaml"), []byte("items: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cat, "external.yaml"), []byte("items: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func csvJoin(in []string) string {
	s := ""
	for i, v := range in {
		if i > 0 {
			s += ","
		}
		s += v
	}
	return s
}

func TestVectorStoreRoundTrip(t *testing.T) {
	root := writeTestCatalog(t, []catalog.Record{
		{ID: "ffuf", Name: "ffuf", Summary: "web fuzzer", Tags: []string{"fuzz"}},
		{ID: "nuclei", Name: "nuclei", Summary: "template scanner", Tags: []string{"scan"}},
	})
	cat, err := catalog.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "idx.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Rebuild(cat); err != nil {
		t.Fatal(err)
	}
	ok, err := s.HasVectors()
	if err != nil || ok {
		t.Fatalf("HasVectors after lexical rebuild: ok=%v err=%v", ok, err)
	}
	if err := s.EmbedRecords(context.Background(), cat, fakeEmbedder{}); err != nil {
		t.Fatal(err)
	}
	ok, err = s.HasVectors()
	if err != nil || !ok {
		t.Fatalf("HasVectors after embed: ok=%v err=%v", ok, err)
	}
	embedder, dim := s.VectorMeta()
	if dim != 32 {
		t.Fatalf("dim=%d want 32", dim)
	}
	if embedder != (fakeEmbedder{}).Label() {
		t.Fatalf("embedder=%q", embedder)
	}
	// nil embedder clears vectors.
	if err := s.EmbedRecords(context.Background(), cat, nil); err == nil {
		t.Fatal("expected ErrNoVectors for nil embedder")
	}
	ok, _ = s.HasVectors()
	if ok {
		t.Fatal("vectors should be cleared by nil embedder")
	}
}

func TestSemanticFilterOrdersBySimilarity(t *testing.T) {
	root := writeTestCatalog(t, []catalog.Record{
		{ID: "amass", Name: "amass", Summary: "attack surface subdomain enumeration", WhenToUse: "subdomain discovery"},
		{ID: "gitleaks", Name: "gitleaks", Summary: "scan git history for secrets and API keys", WhenToUse: "secret scanning"},
		{ID: "ffuf", Name: "ffuf", Summary: "web content fuzzer for hidden directories", WhenToUse: "content discovery"},
	})
	cat, _ := catalog.Load(root)
	s, err := Open(filepath.Join(t.TempDir(), "idx.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Rebuild(cat); err != nil {
		t.Fatal(err)
	}
	if err := s.EmbedRecords(context.Background(), cat, fakeEmbedder{}); err != nil {
		t.Fatal(err)
	}
	ids, err := s.SemanticFilter(context.Background(), fakeEmbedder{}, "secret scanning", []string{"amass", "gitleaks", "ffuf"})
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 3 || ids[0] != "gitleaks" {
		t.Fatalf("top semantic hit=%v want gitleaks first", ids)
	}
	// Missing vectors → ErrNoVectors.
	if err := s.EmbedRecords(context.Background(), cat, nil); err == nil {
		t.Fatal("expected error")
	}
	if _, err := s.SemanticFilter(context.Background(), fakeEmbedder{}, "x", []string{"amass", "gitleaks"}); err != ErrNoVectors {
		t.Fatalf("want ErrNoVectors, got %v", err)
	}
}

func TestEncodeDecodeVector(t *testing.T) {
	v := []float32{1.5, -2.25, 3.75}
	blob := EncodeVector(v)
	got, err := DecodeVector(blob, len(v))
	if err != nil {
		t.Fatal(err)
	}
	for i := range v {
		if v[i] != got[i] {
			t.Fatalf("round trip %d: %v != %v", i, v[i], got[i])
		}
	}
	if _, err := DecodeVector(blob, 4); err == nil {
		t.Fatal("expected error for wrong dim")
	}
}
