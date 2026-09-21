package llm

import (
	"os"
	"strings"
)

const (
	DefaultOpenAIBase = "https://api.openai.com/v1"
	DefaultModel      = "gpt-4o-mini"
	UnslothRepo       = "https://github.com/openhat/unsloth"
)

type Config struct {
	BaseURL string
	APIKey  string
	Model   string
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// Resolve prefers explicit flag/form values, then OHQS_* env, then OPENAI_API_KEY.
func Resolve(baseURL, apiKey, model string) Config {
	return ResolveWith(Config{}, baseURL, apiKey, model)
}

// ResolveWith merges a persisted (machine-local) config into resolution.
// Precedence per field: explicit flag/form value > persisted config > env > default.
// Model is optional: single-model servers (llama.cpp, and many vLLM/Unsloth
// deployments) ignore it, so it is only defaulted for the hosted OpenAI API,
// which requires it.
func ResolveWith(persisted Config, baseURL, apiKey, model string) Config {
	c := Config{
		BaseURL: firstNonEmpty(baseURL, persisted.BaseURL, os.Getenv("OHQS_OPENAI_BASE_URL")),
		APIKey:  firstNonEmpty(apiKey, persisted.APIKey, os.Getenv("OHQS_OPENAI_API_KEY"), os.Getenv("OPENAI_API_KEY")),
		Model:   firstNonEmpty(model, persisted.Model, os.Getenv("OHQS_OPENAI_MODEL")),
	}
	if c.BaseURL == "" && c.APIKey != "" {
		c.BaseURL = DefaultOpenAIBase
	}
	if c.Model == "" && isOpenAIHost(c.BaseURL) {
		c.Model = DefaultModel
	}
	return c
}

// isOpenAIHost reports whether base points at the hosted OpenAI API, which
// requires an explicit model. Local OpenAI-compatible servers usually do not.
func isOpenAIHost(base string) bool {
	return strings.Contains(base, "api.openai.com")
}

func (c Config) Ready() bool {
	return strings.TrimSpace(c.BaseURL) != ""
}

func (c Config) Redacted() (baseURL, model string, keySet bool) {
	return c.BaseURL, c.Model, c.APIKey != ""
}
