package models

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// DefaultPort is where the local GGUF server listens. Change with --port.
	DefaultPort = "8001"
	// UnslothRepo is the bring-your-own-LLM runner the project recommends.
	UnslothRepo = "https://github.com/openhat/unsloth"
)

// InstalledInfo is what `ohqs models install` writes to data/models/<id>/config.json.
type InstalledInfo struct {
	ID       string `json:"id"`
	Repo     string `json:"repo"`
	Quant    string `json:"quant"`
	GGUFPath string `json:"gguf_path"`
	Venv     string `json:"venv"`
	Port     string `json:"port"`
	BaseURL  string `json:"base_url"`
}

// Installer drives the unsloth-managed install for a recommended model.
type Installer struct {
	Root   string
	Stdout io.Writer
	Stderr io.Writer
}

func (g *Installer) out(format string, args ...any) {
	if g.Stdout != nil {
		fmt.Fprintf(g.Stdout, format, args...)
	}
}

func (g *Installer) ModelDir(id string) string {
	return filepath.Join(g.Root, "data", "models", id)
}

func (g *Installer) venvDir(id string) string {
	return filepath.Join(g.ModelDir(id), "venv")
}

func (g *Installer) ConfigPath(id string) string {
	return filepath.Join(g.ModelDir(id), "config.json")
}

func LoadInstalled(root, id string) (InstalledInfo, error) {
	raw, err := os.ReadFile(filepath.Join(root, "data", "models", id, "config.json"))
	if err != nil {
		return InstalledInfo{}, err
	}
	var info InstalledInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return InstalledInfo{}, err
	}
	return info, nil
}

// Install provisions a Python venv with unsloth + llama-cpp-python[server],
// downloads the recommended GGUF, and records the OpenAI-compatible endpoint.
// It refuses to run when the model does not fit unless force is set.
func (g *Installer) Install(modelID string, port string, force bool) (*InstalledInfo, error) {
	m, ok := ByID(modelID)
	if !ok {
		return nil, fmt.Errorf("unknown model %q (try: ohqs models list)", modelID)
	}
	if port == "" {
		port = DefaultPort
	}
	if !filepath.IsAbs(g.Root) {
		root, err := filepath.Abs(g.Root)
		if err != nil {
			return nil, err
		}
		g.Root = root
	}
	h := Detect()
	fit := BestFit(h, m)
	if !fit.Fits && !force {
		return nil, fmt.Errorf(
			"%s (%s): %s\n  Minimum requirement: %s. Set --force to install anyway and it will page to disk.",
			m.ID, m.Repo, fit.LabelFor(), m.MinIMemNote)
	}

	dir := g.ModelDir(m.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	venv := g.venvDir(m.ID)
	if _, err := os.Stat(filepath.Join(venv, "bin", "python")); err != nil {
		g.out("ohqs models: creating venv %s\n", venv)
		if err := g.run("python3", os.Stdout, "venv", venv); err != nil {
			return nil, fmt.Errorf("create venv: %w", err)
		}
	}
	py := filepath.Join(venv, "bin", "python")
	g.out("ohqs models: installing unsloth + llama-cpp-python[server] + huggingface_hub\n")
	if err := g.run(py, os.Stdout, "-m", "pip", "install", "--quiet", "--upgrade",
		"unsloth", "llama-cpp-python[server]", "huggingface_hub[hf_transfer]"); err != nil {
		return nil, fmt.Errorf("pip install (unsloth): %w", err)
	}

	weights := filepath.Join(dir, "weights")
	if err := os.MkdirAll(weights, 0o755); err != nil {
		return nil, err
	}
	g.out("ohqs models: downloading GGUF for %s (this may take a while)\n", m.Repo)
	hg := filepath.Join(venv, "bin", "huggingface-cli")
	if err := g.run(hg, os.Stdout, "download", m.Repo, "--include", "*.gguf", "--local-dir", weights); err != nil {
		return nil, fmt.Errorf("download GGUF: %w", err)
	}
	ggufPath, err := pickGGUF(weights, m.Quant)
	if err != nil {
		return nil, err
	}
	info := &InstalledInfo{
		ID:       m.ID,
		Repo:     m.Repo,
		Quant:    m.Quant,
		GGUFPath: ggufPath,
		Venv:     venv,
		Port:     port,
		BaseURL:  "http://127.0.0.1:" + port + "/v1",
	}
	raw, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(g.ConfigPath(m.ID), append(raw, '\n'), 0o600); err != nil {
		return nil, err
	}
	return info, nil
}

// pickGGUF picks the downloaded file matching the preferred quant, falling back
// to the smallest Q4/Q5 file, else the first GGUF.
func pickGGUF(dir, preferred string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("list weights: %w", err)
	}
	var ggufs []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasSuffix(strings.ToLower(e.Name()), ".gguf") {
			ggufs = append(ggufs, filepath.Join(dir, e.Name()))
		}
	}
	if len(ggufs) == 0 {
		return "", fmt.Errorf("no .gguf files were downloaded for %s (check the model card)", dir)
	}
	for _, f := range ggufs {
		if strings.Contains(strings.ToUpper(filepath.Base(f)), preferred) {
			return f, nil
		}
	}
	sort.Slice(ggufs, func(i, j int) bool {
		ai, erri := os.Stat(ggufs[i])
		bi, errj := os.Stat(ggufs[j])
		if erri == nil && errj == nil {
			return ai.Size() < bi.Size()
		}
		return ggufs[i] < ggufs[j]
	})
	return ggufs[0], nil
}

// Serve runs the llama.cpp OpenAI-compatible server for an installed model in
// the foreground. Remove gpu to keep layers on CPU (e.g. macOS without Metal).
func Serve(root, id, port string, gpu int) error {
	info, err := LoadInstalled(root, id)
	if err != nil {
		return fmt.Errorf("%s not installed (run: ohqs models install %s)", id, id)
	}
	if _, err := os.Stat(info.GGUFPath); err != nil {
		return fmt.Errorf("missing weights at %s (re-run: ohqs models install %s)", info.GGUFPath, id)
	}
	py := filepath.Join(info.Venv, "bin", "python")
	if _, err := os.Stat(py); err != nil {
		return fmt.Errorf("venv lost at %s (re-run: ohqs models install %s)", py, id)
	}
	args := []string{"-m", "llama_cpp.server",
		"--model", info.GGUFPath,
		"--host", "127.0.0.1",
		"--port", orStr(port, info.Port, DefaultPort),
		"--ctx_size", "8192",
	}
	if gpu > 0 {
		args = append(args, "--n_gpu_layers", fmt.Sprintf("%d", gpu))
	}
	return exec.Command(py, args...).Run()
}

func orStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (g *Installer) run(name string, outw io.Writer, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = outw
	cmd.Stderr = g.Stderr
	if cmd.Stderr == nil {
		cmd.Stderr = io.Discard
	}
	return cmd.Run()
}
