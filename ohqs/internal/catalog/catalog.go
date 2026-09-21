package catalog

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Record struct {
	ID            string   `yaml:"id" json:"id"`
	Name          string   `yaml:"name" json:"name"`
	Kind          string   `yaml:"kind" json:"kind"`
	Summary       string   `yaml:"summary" json:"summary"`
	WhenToUse     string   `yaml:"when_to_use" json:"when_to_use"`
	Tags          []string `yaml:"tags" json:"tags"`
	VulnClasses   []string `yaml:"vuln_classes" json:"vuln_classes"`
	Platforms     []string `yaml:"platforms" json:"platforms"`
	Homepage      string   `yaml:"homepage" json:"homepage"`
	StoreFirefox  string   `yaml:"store_firefox" json:"store_firefox"`
	StoreChromium string   `yaml:"store_chromium" json:"store_chromium"`
	AddonID       string   `yaml:"addon_id" json:"addon_id"`
	XPIURL        string   `yaml:"xpi_url" json:"xpi_url"`
	DocsURLs      []string `yaml:"docs_urls" json:"docs_urls"`
	SubmodulePath string   `yaml:"submodule_path" json:"submodule_path"`
	Bin           string   `yaml:"bin" json:"bin"`
	Build         string   `yaml:"build" json:"build"`
	GoExperiment  string   `yaml:"go_experiment" json:"go_experiment"`
	Install       string   `yaml:"install" json:"install"`
	Commands      []string `yaml:"commands" json:"commands"`
	How           string   `yaml:"how" json:"how"`
	LookFor       string   `yaml:"look_for" json:"look_for"`
	Interpret     string   `yaml:"interpret" json:"interpret"`
	SafeAuto      bool     `yaml:"safe_auto" json:"safe_auto"`
}

type fileItems struct {
	Items []Record `yaml:"items"`
}

type Playbook struct {
	ID    string   `yaml:"id" json:"id"`
	Title string   `yaml:"title" json:"title"`
	Match []string `yaml:"match" json:"match"`
	Steps []Step   `yaml:"steps" json:"steps"`
}

type Step struct {
	ID      string   `yaml:"id" json:"id"`
	Title   string   `yaml:"title" json:"title"`
	Purpose string   `yaml:"purpose" json:"purpose"`
	ToolIDs []string `yaml:"tool_ids" json:"tool_ids"`
}

type Catalog struct {
	Root      string
	Records   []Record
	ByID      map[string]Record
	Playbooks []Playbook
}

func FindRoot(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "catalog", "tools.yaml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find catalog/ from %s", start)
		}
		dir = parent
	}
}

func Load(root string) (*Catalog, error) {
	c := &Catalog{Root: root, ByID: map[string]Record{}}
	files := []string{"tools.yaml", "extensions.yaml", "guides.yaml", "os.yaml", "platforms.yaml", "references.yaml", "external.yaml", "ingested.yaml"}
	for _, name := range files {
		path := filepath.Join(root, "catalog", name)
		b, err := os.ReadFile(path)
		if err != nil {
			if name == "ingested.yaml" && os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		var wrap fileItems
		if err := yaml.Unmarshal(b, &wrap); err != nil {
			return nil, fmt.Errorf("yaml %s: %w", path, err)
		}
		for _, rec := range wrap.Items {
			if rec.ID == "" {
				continue
			}
			if rec.Kind == "" {
				rec.Kind = strings.TrimSuffix(name, ".yaml")
			}
			c.Records = append(c.Records, rec)
			c.ByID[rec.ID] = rec
		}
	}
	pbDir := filepath.Join(root, "catalog", "playbooks")
	entries, err := os.ReadDir(pbDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(pbDir, e.Name()))
		if err != nil {
			return nil, err
		}
		var pb Playbook
		if err := yaml.Unmarshal(b, &pb); err != nil {
			return nil, fmt.Errorf("playbook %s: %w", e.Name(), err)
		}
		c.Playbooks = append(c.Playbooks, pb)
	}
	return c, nil
}

func (r Record) SearchText() string {
	parts := []string{r.ID, r.Name, r.Kind, r.Summary, r.WhenToUse, r.How, r.LookFor, r.Interpret, r.Install}
	parts = append(parts, r.Tags...)
	parts = append(parts, r.VulnClasses...)
	parts = append(parts, r.Commands...)
	return strings.Join(parts, " ")
}

func ReadmeSnippet(root, rel string, max int) string {
	if rel == "" {
		return ""
	}
	for _, name := range []string{"README.md", "readme.md", "README"} {
		b, err := os.ReadFile(filepath.Join(root, rel, name))
		if err != nil {
			continue
		}
		s := string(b)
		if len(s) > max {
			return s[:max]
		}
		return s
	}
	return ""
}
