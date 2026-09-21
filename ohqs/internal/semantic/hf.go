package semantic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// HF calls Hugging Face Inference Providers feature-extraction.
// Default model is sentence-transformers/all-MiniLM-L6-v2 (no weight download).
type HF struct {
	Token    string
	Model    string
	Endpoint string // override for tests
	HTTP     *http.Client
}

func (h *HF) Label() string {
	m := h.Model
	if m == "" {
		m = HFMiniLM
	}
	return m + " (HF Inference)"
}

func (h *HF) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if h == nil || strings.TrimSpace(h.Token) == "" {
		return nil, fmt.Errorf("hf embed: HF_TOKEN required")
	}
	clipped := make([]string, len(texts))
	for i, t := range texts {
		clipped[i] = clipEmbed(t)
	}
	return h.embedAll(ctx, clipped)
}

func (h *HF) embedAll(ctx context.Context, texts []string) ([][]float32, error) {
	type job struct{ start, end int }
	var jobs []job
	for i := 0; i < len(texts); i += hfBatch {
		end := i + hfBatch
		if end > len(texts) {
			end = len(texts)
		}
		jobs = append(jobs, job{i, end})
	}
	out := make([][]float32, len(texts))
	errCh := make(chan error, len(jobs))
	sem := make(chan struct{}, hfWorkers)
	var wg sync.WaitGroup
	for _, j := range jobs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
			batch, err := h.featureExtract(ctx, texts[j.start:j.end])
			if err != nil {
				errCh <- err
				return
			}
			if len(batch) != j.end-j.start {
				errCh <- fmt.Errorf("hf embed: batch size %d want %d", len(batch), j.end-j.start)
				return
			}
			copy(out[j.start:j.end], batch)
		}(j)
	}
	wg.Wait()
	select {
	case err := <-errCh:
		if err != nil {
			return nil, err
		}
	default:
	}
	for i, v := range out {
		if len(v) == 0 {
			return nil, fmt.Errorf("hf embed: empty vector at %d", i)
		}
	}
	return out, nil
}

func (h *HF) featureExtract(ctx context.Context, texts []string) ([][]float32, error) {
	url := h.Endpoint
	if url == "" {
		model := h.Model
		if model == "" {
			model = HFMiniLM
		}
		url = "https://router.huggingface.co/hf-inference/models/" + model + "/pipeline/feature-extraction"
	}
	payload, err := json.Marshal(map[string]any{"inputs": texts, "normalize": true})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.Token)
	req.Header.Set("User-Agent", "ohqs")
	client := h.HTTP
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("hf inference: HTTP %d: %s", res.StatusCode, trimHTTP(raw))
	}
	return parseFeatureExtraction(raw, len(texts))
}

func parseFeatureExtraction(raw []byte, n int) ([][]float32, error) {
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, fmt.Errorf("hf inference: decode: %w", err)
	}
	if m, ok := generic.(map[string]any); ok {
		if e, ok := m["embeddings"]; ok {
			generic = e
		} else if e, ok := m["data"]; ok {
			return parseOpenAIData(e, n)
		}
	}
	vecs, err := vectorsFromJSON(generic)
	if err != nil {
		return nil, err
	}
	if len(vecs) == n {
		return vecs, nil
	}
	if n == 1 && len(vecs) >= 1 {
		return [][]float32{vecs[0]}, nil
	}
	return nil, fmt.Errorf("hf inference: got %d vectors want %d", len(vecs), n)
}

func parseOpenAIData(v any, n int) ([][]float32, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("hf inference: unexpected data")
	}
	out := make([][]float32, n)
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		idx := 0
		if x, ok := m["index"].(float64); ok {
			idx = int(x)
		}
		emb, err := floatSlice(m["embedding"])
		if err != nil || idx < 0 || idx >= n {
			continue
		}
		out[idx] = toF32(emb)
	}
	return out, nil
}

// vectorsFromJSON accepts []float, [][]float, or [][][]float (mean-pool tokens).
func vectorsFromJSON(v any) ([][]float32, error) {
	switch x := v.(type) {
	case []any:
		if len(x) == 0 {
			return nil, fmt.Errorf("hf inference: empty")
		}
		if _, ok := x[0].(float64); ok {
			s, err := floatSlice(x)
			if err != nil {
				return nil, err
			}
			return [][]float32{toF32(s)}, nil
		}
		if inner, ok := x[0].([]any); ok {
			if len(inner) > 0 {
				if _, ok := inner[0].(float64); ok {
					out := make([][]float32, 0, len(x))
					for _, row := range x {
						s, err := floatSlice(row)
						if err != nil {
							return nil, err
						}
						out = append(out, toF32(s))
					}
					return out, nil
				}
				out := make([][]float32, 0, len(x))
				for _, doc := range x {
					tokens, ok := doc.([]any)
					if !ok {
						return nil, fmt.Errorf("hf inference: unexpected token shape")
					}
					var rows [][]float64
					for _, tok := range tokens {
						s, err := floatSlice(tok)
						if err != nil {
							return nil, err
						}
						rows = append(rows, s)
					}
					out = append(out, meanPool(rows))
				}
				return out, nil
			}
		}
	}
	return nil, fmt.Errorf("hf inference: unexpected embedding shape")
}

func floatSlice(v any) ([]float64, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("hf inference: not a vector")
	}
	out := make([]float64, len(arr))
	for i, x := range arr {
		f, ok := x.(float64)
		if !ok {
			return nil, fmt.Errorf("hf inference: non-numeric")
		}
		out[i] = f
	}
	return out, nil
}
