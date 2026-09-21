package semantic

import (
	"context"
	"math"
	"testing"
)

func TestCosineBasic(t *testing.T) {
	a := []float32{1, 0, 0}
	b := []float32{0, 1, 0}
	if got := Cosine(a, b); math.Abs(got) > 1e-9 {
		t.Fatalf("orthogonal vectors: got %v want 0", got)
	}
	c := []float32{1, 1, 0}
	if got, want := Cosine(a, c), 1/math.Sqrt2; math.Abs(got-want) > 1e-6 {
		t.Fatalf("cosine(1,0,0),(1,1,0)=%v want %v", got, want)
	}
	if got := Cosine(a, a); math.Abs(got-1) > 1e-9 {
		t.Fatalf("self similarity: got %v want 1", got)
	}
	if got := Cosine(nil, b); got != 0 {
		t.Fatalf("empty vector: got %v want 0", got)
	}
}

func TestNormalize(t *testing.T) {
	v := Normalize([]float32{3, 4})
	if got, want := v[0], float32(0.6); math.Abs(float64(got-want)) > 1e-6 {
		t.Fatalf("normalize x: got %v want %v", got, want)
	}
	if got, want := v[1], float32(0.8); math.Abs(float64(got-want)) > 1e-6 {
		t.Fatalf("normalize y: got %v want %v", got, want)
	}
}

func TestPickOllamaEmbed(t *testing.T) {
	cases := []struct {
		name, want string
	}{
		{"nomic-embed-text", "nomic-embed-text"},
		{"qwen2.5:7b-instruct", ""},
		{"all-minilm:33m", "all-minilm:33m"},
		{"mxbai-embed-large", "mxbai-embed-large"},
		{"bge-m3", ""},
	}
	for _, c := range cases {
		if got := PickOllamaEmbed([]string{c.name}); got != c.want {
			t.Fatalf("PickOllamaEmbed(%q)=%q want %q", c.name, got, c.want)
		}
	}
	names := []string{"llama3.1:8b", "nomic-embed-text:v1.5", "llava:13b"}
	if got := PickOllamaEmbed(names); got != "nomic-embed-text:v1.5" {
		t.Fatalf("combined pick: got %q", got)
	}
}

func TestEmbedderInterface(t *testing.T) {
	// Compile-time checks: both embedders satisfy the interface.
	var _ Embedder = (*Ollama)(nil)
	var _ Embedder = (*HF)(nil)
}

func TestHFUnbound(tt *testing.T) {
	h := &HF{Endpoint: "http://127.0.0.1:1/reject"}
	_, err := h.Embed(context.Background(), []string{"x"})
	if err == nil {
		tt.Fatal("expected error for tokenless HF embedder")
	}
}

func TestParseFeatureExtraction(t *testing.T) {
	// Single vector shape.
	raw := []byte("[[0.1, 0.2], [0.3, 0.4]]")
	vecs, err := parseFeatureExtraction(raw, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(vecs) != 2 || len(vecs[0]) != 2 {
		t.Fatalf("shape: %v", vecs)
	}
	// OpenAI data shape with index.
	raw = []byte(`{"data":[{"embedding":[1,2],"index":1},{"embedding":[3,4],"index":0}]}`)
	vecs, err = parseFeatureExtraction(raw, 2)
	if err != nil {
		t.Fatal(err)
	}
	if vecs[0][0] != 3 || vecs[1][0] != 1 {
		t.Fatalf("openai data order: %v", vecs)
	}
	// Token-level shape mean-pools.
	raw = []byte(`[[[1,1],[1,1]], [[2,2],[2,4]]]`)
	vecs, err = parseFeatureExtraction(raw, 2)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(float64(vecs[0][0])-1) > 1e-6 || math.Abs(float64(vecs[1][0])-2) > 1e-6 {
		t.Fatalf("mean-pool: %v", vecs)
	}
	if math.Abs(float64(vecs[1][1])-3) > 1e-6 {
		t.Fatalf("mean-pool y: %v", vecs)
	}
}
