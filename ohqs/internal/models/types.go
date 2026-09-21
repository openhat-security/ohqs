package models

import "strconv"

// Model is one recommended local LLM (Hugging Face GGUF) for the reasoning /
// agent step of an authorized engagement, with a rough GGUF fit estimate.
type Model struct {
	ID          string  `json:"id"`
	Repo        string  `json:"repo"`
	ParamsB     float64 `json:"paramsb"`
	ActiveB     float64 `json:"activeb"`
	Family      string  `json:"family"`
	Why         string  `json:"why"`
	Quant       string  `json:"quant"`
	OverheadGB  float64 `json:"overhead_gb"`
	MinIMemGB   float64 `json:"min_imem_gb"`
	MinIMemNote string  `json:"min_imem_note"`
	License     string  `json:"license"`
	Notes       string  `json:"notes"`
	Recommended bool    `json:"recommended"`
}

// ActiveLabel reports the effective params a tool sees: active for MoE-style
// models, total otherwise.
func (m Model) ActiveLabel() string {
	b := m.ParamsB
	if m.ActiveB > 0 {
		b = m.ActiveB
	}
	return strconv.FormatFloat(b, 'f', -1, 64) + "B"
}
