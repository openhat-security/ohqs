package appconfig

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/llm"
)

type Config struct {
	Root         string
	Catalog      string
	IndexPath    string
	Listen       string
	ToolBin      string
	JobsDir      string
	HistoryDir   string
	SettingsPath string
}

func Resolve() (*Config, error) {
	wd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	root, err := catalog.FindRoot(wd)
	if err != nil {
		return nil, err
	}
	return &Config{
		Root:         root,
		Catalog:      filepath.Join(root, "catalog"),
		IndexPath:    filepath.Join(root, "data", "ohqs.sqlite"),
		Listen:       "127.0.0.1:8787",
		ToolBin:      filepath.Join(root, "bin", "tools"),
		JobsDir:      filepath.Join(root, "data", "jobs"),
		HistoryDir:   filepath.Join(root, "data", "history"),
		SettingsPath: filepath.Join(root, "data", "config.json"),
	}, nil
}

func (c *Config) IndexExists() bool {
	_, err := os.Stat(c.IndexPath)
	return err == nil
}

// llmSettings is the on-disk shape of the bring-your-own LLM config.
type llmSettings struct {
	BaseURL string `json:"base_url,omitempty"`
	APIKey  string `json:"api_key,omitempty"`
	Model   string `json:"model,omitempty"`
}

// LoadLLM reads the persisted, machine-local LLM config. A missing file is not
// an error; it returns a zero Config so resolution falls back to env/defaults.
func (c *Config) LoadLLM() (llm.Config, error) {
	raw, err := os.ReadFile(c.SettingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return llm.Config{}, nil
		}
		return llm.Config{}, err
	}
	var s llmSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		return llm.Config{}, err
	}
	return llm.Config{BaseURL: s.BaseURL, APIKey: s.APIKey, Model: s.Model}, nil
}

// SaveLLM writes the LLM config to data/config.json (0600, gitignored). It never
// leaves the machine; the API key is stored locally only.
func (c *Config) SaveLLM(cfg llm.Config) error {
	if err := os.MkdirAll(filepath.Dir(c.SettingsPath), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(llmSettings{
		BaseURL: cfg.BaseURL,
		APIKey:  cfg.APIKey,
		Model:   cfg.Model,
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(c.SettingsPath, append(raw, '\n'), 0o600)
}
