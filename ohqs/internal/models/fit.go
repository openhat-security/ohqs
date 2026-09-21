package models

import (
	"fmt"
	"sort"
	"strings"
)

// Quant tiers we size for, in preference order. bytesPerParam are rough GGUF
// estimates (Q4_K_M ≈ 0.60, Q5_K_M ≈ 0.73, Q6_K ≈ 0.86, Q8_0 ≈ 1.10 bytes per
// parameter) plus a small runtime margin.
var quants = []struct {
	Name          string
	BytesPerParam float64
}{
	{"Q4_K_M", 0.60},
	{"Q5_K_M", 0.73},
	{"Q6_K", 0.86},
	{"Q8_0", 1.10},
}

// Fit is a fitted (or miss) sizing for one model on one host.
type Fit struct {
	Model      Model   `json:"model"`
	Quant      string  `json:"quant"`
	RequiredGB float64 `json:"requiredgb"`
	Available  float64 `json:"available"`
	Fits       bool    `json:"fits"`
	ShortGB    float64 `json:"shortgb"` // how far over budget when !Fits
}

// RequiredGB returns the GGUF estimate for a model at a given quant.
func RequiredGB(m Model, quant string) float64 {
	bpp := 0.60
	for _, q := range quants {
		if strings.EqualFold(q.Name, quant) {
			bpp = q.BytesPerParam
			break
		}
	}
	overhead := m.OverheadGB
	if overhead <= 0 {
		overhead = 0.8
	}
	return m.ParamsB*bpp + overhead
}

// BestFit picks the tightest quant that fits, preferring the model's default
// Quant when available, else the smallest that fits. With fits=false, it
// reports the default quant shortfall so the CLI can show how much is missing.
func BestFit(h HostInfo, m Model) Fit {
	avail := h.AvailableGB()
	best := Fit{Model: m, Available: avail, RequiredGB: RequiredGB(m, m.Quant), Quant: m.Quant}
	if best.RequiredGB <= avail {
		best.Fits = true
		return best
	}
	for _, q := range quants {
		if q.Name == best.Quant {
			continue
		}
		req := RequiredGB(m, q.Name)
		if req <= avail {
			best = Fit{Model: m, Quant: q.Name, RequiredGB: req, Available: avail, Fits: true}
			break
		}
	}
	if !best.Fits {
		best.ShortGB = best.RequiredGB - avail
	}
	return best
}

// Recommendation is one ranked model row for display.
type Recommendation struct {
	Fit
	Score float64 `json:"score"`
}

// Recommend returns every catalog model sized for h, ranked: fits first by
// parameter size (more capable first), then non-fits by smallest shortfall.
func Recommend(h HostInfo, limit int) []Recommendation {
	if limit <= 0 {
		limit = len(DefaultModels)
	}
	out := make([]Recommendation, 0, len(DefaultModels))
	for _, m := range DefaultModels {
		f := BestFit(h, m)
		score := f.Model.ParamsB
		if !f.Fits {
			score = -f.ShortGB
		}
		out = append(out, Recommendation{Fit: f, Score: score})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].Fits, out[j].Fits
		if a != b {
			return a
		}
		return out[i].Score > out[j].Score
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Summary is the one-click recommendation: the largest model that fits.
func Summary(h HostInfo) (Recommendation, bool) {
	recs := Recommend(h, 1)
	if len(recs) == 0 {
		return Recommendation{}, false
	}
	return recs[0], recs[0].Fits
}

// LabelFor returns a short human line for a fit, e.g.
//
//	ravenx  Q4_K_M  ~24.0 GB  fits (available 48.0 GB)
//	ravenx  Q4_K_M  ~24.0 GB  need ~24.0 GB (available 8.0 GB)
func (f Fit) LabelFor() string {
	need := fmt.Sprintf("~%.1f GB", f.RequiredGB)
	if f.Fits {
		return fmt.Sprintf("%s  fits (%s ~%.1f GB)", need, strings.ToLower(f.Quant), f.Available)
	}
	return fmt.Sprintf("%s  need %.1f GB more (available ~%.1f GB)", need, f.ShortGB, f.Available)
}
